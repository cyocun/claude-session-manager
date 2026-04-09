use serde_json::Value;
use tantivy::schema::document::Value as _;
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{atomic::{AtomicBool, Ordering}, Mutex, RwLock};
use tantivy::collector::TopDocs;
use tantivy::query::{BooleanQuery, FuzzyTermQuery, Occur, QueryParser, TermQuery};
use tantivy::schema::*;
use tantivy::snippet::SnippetGenerator;
use tantivy::{doc, Index, IndexReader, IndexWriter, ReloadPolicy, TantivyDocument};

use crate::sessions::{find_session_file, history_file};
use crate::models::{normalize_message_text, HistoryEntry, RawHistoryEntry, SearchHit, SearchIndexStatus};

const MAX_CONTENT_CHARS: usize = 50 * 1024; // 50K chars per document
const WRITER_HEAP_SIZE: usize = 50 * 1024 * 1024; // 50MB
const INDEX_VERSION: u32 = 3; // Bump when schema/tokenizer changes to force reindex
const TOKENIZER_NAME: &str = "lindera_ipadic";

pub struct SearchIndex {
    index: Index,
    reader: IndexReader,
    writer: Mutex<IndexWriter>,
    f_session_id: Field,
    f_project: Field,
    f_content: Field,
    f_msg_type: Field,
    f_timestamp: Field,
    f_message_index: Field,
    indexed_sessions: RwLock<HashMap<String, u64>>,
    meta_path: PathBuf,
    pub is_indexing: AtomicBool,
    pub total_sessions: Mutex<u32>,
}

struct IndexingFlagGuard<'a> {
    flag: &'a AtomicBool,
}

impl Drop for IndexingFlagGuard<'_> {
    fn drop(&mut self) {
        self.flag.store(false, Ordering::SeqCst);
    }
}

impl SearchIndex {
    pub fn new(index_dir: PathBuf) -> Result<Self, Box<dyn std::error::Error>> {
        std::fs::create_dir_all(&index_dir)?;

        // This is a single-process app: any leftover writer lock is stale.
        let _ = std::fs::remove_file(index_dir.join(".tantivy-writer.lock"));

        // Wipe index if version changed (schema/tokenizer upgrade)
        let meta_path = index_dir.join("index-meta.json");
        if Self::stored_version(&meta_path) != INDEX_VERSION {
            eprintln!("Search index version changed, rebuilding...");
            let _ = std::fs::remove_dir_all(&index_dir);
            std::fs::create_dir_all(&index_dir)?;
            // Write version immediately so we don't re-wipe on next startup
            let meta = serde_json::json!({ "version": INDEX_VERSION, "sessions": {} });
            let _ = std::fs::write(&meta_path, serde_json::to_string(&meta).unwrap_or_default());
        }

        let mut schema_builder = Schema::builder();
        let f_session_id = schema_builder.add_text_field("session_id", STRING | STORED);
        let f_project = schema_builder.add_text_field("project", STRING | STORED);
        let content_options = TextOptions::default()
            .set_indexing_options(
                TextFieldIndexing::default()
                    .set_tokenizer(TOKENIZER_NAME)
                    .set_index_option(IndexRecordOption::WithFreqsAndPositions)
            )
            .set_stored();
        let f_content = schema_builder.add_text_field("content", content_options);
        let f_msg_type = schema_builder.add_text_field("msg_type", STRING | STORED);
        let f_timestamp = schema_builder.add_u64_field("timestamp", INDEXED | STORED | FAST);
        let f_message_index = schema_builder.add_u64_field("message_index", STORED);
        let schema = schema_builder.build();

        let index = Index::open_or_create(
            tantivy::directory::MmapDirectory::open(&index_dir)?,
            schema,
        )?;

        // Register lindera Japanese tokenizer (IPAdic / MeCab-compatible)
        let lindera_tokenizer = {
            let dictionary = lindera::dictionary::load_dictionary("embedded://ipadic")
                .map_err(|e| format!("Failed to load IPAdic dictionary: {}", e))?;
            let segmenter = lindera::segmenter::Segmenter::new(
                lindera::mode::Mode::Normal,
                dictionary,
                None,
            );
            lindera_tantivy::tokenizer::LinderaTokenizer::from_segmenter(segmenter)
        };
        index.tokenizers().register(TOKENIZER_NAME, lindera_tokenizer);

        let reader = index
            .reader_builder()
            .reload_policy(ReloadPolicy::OnCommitWithDelay)
            .try_into()?;

        let writer = index.writer(WRITER_HEAP_SIZE)?;

        let indexed_sessions = Self::load_meta(&meta_path);

        Ok(Self {
            index,
            reader,
            writer: Mutex::new(writer),
            f_session_id,
            f_project,
            f_content,
            f_msg_type,
            f_timestamp,
            f_message_index,
            indexed_sessions: RwLock::new(indexed_sessions),
            meta_path,
            is_indexing: AtomicBool::new(false),
            total_sessions: Mutex::new(0),
        })
    }

    fn stored_version(meta_path: &Path) -> u32 {
        std::fs::read_to_string(meta_path)
            .ok()
            .and_then(|data| serde_json::from_str::<serde_json::Value>(&data).ok())
            .and_then(|meta| meta.get("version")?.as_u64())
            .unwrap_or(0) as u32
    }

    fn load_meta(meta_path: &Path) -> HashMap<String, u64> {
        if let Ok(data) = std::fs::read_to_string(meta_path) {
            if let Ok(meta) = serde_json::from_str::<serde_json::Value>(&data) {
                if let Some(sessions) = meta.get("sessions").and_then(|v| v.as_object()) {
                    return sessions
                        .iter()
                        .filter_map(|(k, v)| v.as_u64().map(|s| (k.clone(), s)))
                        .collect();
                }
            }
        }
        HashMap::new()
    }

    fn save_meta(&self) {
        let map = self.indexed_sessions.read().unwrap();
        let sessions: serde_json::Map<String, serde_json::Value> = map
            .iter()
            .map(|(k, v)| (k.clone(), serde_json::Value::Number((*v).into())))
            .collect();
        let meta = serde_json::json!({ "version": INDEX_VERSION, "sessions": sessions });
        match serde_json::to_string(&meta) {
            Ok(json) => {
                if let Err(e) = std::fs::write(&self.meta_path, json) {
                    eprintln!("Failed to write search index metadata: {}", e);
                }
            }
            Err(e) => {
                eprintln!("Failed to serialize search index metadata: {}", e);
            }
        }
    }

    pub fn needs_reindex(&self, session_id: &str, file_size: u64) -> bool {
        let map = self.indexed_sessions.read().unwrap();
        match map.get(session_id) {
            Some(&cached_size) => cached_size != file_size,
            None => true,
        }
    }

    /// Index a session without committing — caller is responsible for commit.
    fn index_session_no_commit(
        &self,
        session_id: &str,
        project: &str,
        session_file: &Path,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let file = File::open(session_file)?;
        let messages = Self::extract_searchable_messages(&file);

        let writer = self.writer.lock().unwrap();

        // Delete existing documents for this session
        let term = tantivy::Term::from_field_text(self.f_session_id, session_id);
        writer.delete_term(term);

        // Add new documents
        for msg in &messages {
            let content: String = msg.content.chars().take(MAX_CONTENT_CHARS).collect();
            writer.add_document(doc!(
                self.f_session_id => session_id,
                self.f_project => project,
                self.f_content => content,
                self.f_msg_type => msg.msg_type.as_str(),
                self.f_timestamp => msg.timestamp,
                self.f_message_index => msg.message_index as u64,
            ))?;
        }

        // Update meta
        let file_size = std::fs::metadata(session_file).map(|m| m.len()).unwrap_or(0);
        self.indexed_sessions
            .write()
            .unwrap()
            .insert(session_id.to_string(), file_size);

        Ok(())
    }

    fn extract_searchable_messages(file: &File) -> Vec<SearchableMessage> {
        let mut messages = Vec::new();
        let mut message_index: u32 = 0;

        for line in BufReader::new(file).lines().flatten() {
            let msg: Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };

            let msg_type = match msg.get("type").and_then(|v| v.as_str()) {
                Some(t) if t == "user" || t == "assistant" => t.to_string(),
                _ => continue,
            };

            let message = match msg.get("message") {
                Some(m) => m,
                None => continue,
            };

            let content_val = match message.get("content") {
                Some(c) => c,
                None => continue,
            };

            let timestamp = msg
                .get("timestamp")
                .and_then(|v| {
                    v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))
                })
                .unwrap_or(0);

            let mut text_parts: Vec<String> = Vec::new();

            match content_val {
                Value::String(s) => {
                    text_parts.push(normalize_message_text(s));
                }
                Value::Array(blocks) => {
                    for block in blocks {
                        match block {
                            Value::String(s) => text_parts.push(normalize_message_text(s)),
                            Value::Object(_) => {
                                if let Some(btype) = block.get("type").and_then(|v| v.as_str()) {
                                    // Only index user/assistant text, skip tool_use and tool_result
                                    if btype == "text" {
                                        if let Some(t) =
                                            block.get("text").and_then(|v| v.as_str())
                                        {
                                            text_parts.push(normalize_message_text(t));
                                        }
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                }
                _ => {}
            }

            if !text_parts.is_empty() {
                messages.push(SearchableMessage {
                    content: text_parts.join("\n"),
                    msg_type,
                    timestamp,
                    message_index,
                });
            }

            message_index += 1;
        }

        messages
    }

    pub fn search(
        &self,
        query_str: &str,
        project_filter: Option<&str>,
        limit: usize,
    ) -> Result<Vec<SearchHit>, Box<dyn std::error::Error>> {
        let limit = limit.min(500);
        let searcher = self.reader.searcher();
        let query_parser = QueryParser::for_index(&self.index, vec![self.f_content]);
        let escaped_query = query_str
            .split_whitespace()
            .map(|term| escape_query_term(&term.to_lowercase()))
            .collect::<Vec<String>>()
            .join(" ");

        // Build per-term query: prefix OR fuzzy, all terms must match
        let terms: Vec<String> = query_str
            .split_whitespace()
            .map(|term| escape_query_term(&term.to_lowercase()))
            .filter(|term| !term.is_empty())
            .collect();
        let mut must_clauses: Vec<(Occur, Box<dyn tantivy::query::Query>)> = Vec::new();

        for escaped_term in &terms {
            let mut should_clauses: Vec<(Occur, Box<dyn tantivy::query::Query>)> = Vec::new();

            // Prefix query (e.g. "robot-ar" matches "robot-arm")
            if let Ok(prefix_q) = query_parser.parse_query(&format!("{}*", escaped_term)) {
                should_clauses.push((Occur::Should, prefix_q));
            }

            // Fuzzy query (Levenshtein distance 1) — only for longer terms to avoid noise
            if escaped_term.chars().count() >= 7 {
                let tantivy_term = tantivy::Term::from_field_text(self.f_content, escaped_term);
                let fuzzy_q = FuzzyTermQuery::new(tantivy_term, 1, true);
                should_clauses.push((Occur::Should, Box::new(fuzzy_q)));
            }

            if !should_clauses.is_empty() {
                must_clauses.push((Occur::Must, Box::new(BooleanQuery::new(should_clauses))));
            }
        }

        let text_query: Box<dyn tantivy::query::Query> = if must_clauses.is_empty() {
            let (query, _errors) = query_parser.parse_query_lenient(&escaped_query);
            query
        } else {
            Box::new(BooleanQuery::new(must_clauses))
        };

        let final_query: Box<dyn tantivy::query::Query> = if let Some(project) = project_filter {
            let project_query = TermQuery::new(
                tantivy::Term::from_field_text(self.f_project, project),
                IndexRecordOption::Basic,
            );
            Box::new(BooleanQuery::new(vec![
                (Occur::Must, text_query),
                (Occur::Must, Box::new(project_query)),
            ]))
        } else {
            text_query
        };

        // Return all matching messages (not just best per session)
        let top_docs = searcher.search(&final_query, &TopDocs::with_limit(limit * 5))?;

        let snippet_generator = SnippetGenerator::create(&searcher, &final_query, self.f_content)?;

        let mut results: Vec<SearchHit> = Vec::new();

        for (score, doc_address) in top_docs {
            let doc: TantivyDocument = searcher.doc(doc_address)?;

            let session_id = doc
                .get_first(self.f_session_id)
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            if session_id.is_empty() {
                continue;
            }

            let project = doc
                .get_first(self.f_project)
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            let msg_type = doc
                .get_first(self.f_msg_type)
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            let timestamp = doc
                .get_first(self.f_timestamp)
                .and_then(|v| v.as_u64())
                .unwrap_or(0);

            let message_index = doc
                .get_first(self.f_message_index)
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as u32;

            let snippet = snippet_generator.snippet_from_doc(&doc);
            let mut snippet_html = snippet.to_html();
            if snippet_html.trim().is_empty() {
                snippet_html = doc
                    .get_first(self.f_content)
                    .and_then(|v| v.as_str())
                    .map(|s| {
                        let compact = s.split_whitespace().collect::<Vec<_>>().join(" ");
                        compact.chars().take(220).collect::<String>()
                    })
                    .unwrap_or_default();
            }
            if snippet_html.trim().is_empty() {
                continue;
            }

            results.push(SearchHit {
                session_id,
                project,
                snippet: snippet_html,
                msg_type,
                timestamp,
                message_index,
                score,
            });
        }

        results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        results.truncate(limit);

        Ok(results)
    }

    pub fn build_full_index(&self) -> Result<(), Box<dyn std::error::Error>> {
        self.is_indexing.store(true, Ordering::SeqCst);
        let _indexing_guard = IndexingFlagGuard {
            flag: &self.is_indexing,
        };

        let history_path = history_file();
        if !history_path.exists() {
            return Ok(());
        }

        // Collect session entries from history
        let file = File::open(&history_path)?;
        let mut session_map: HashMap<String, String> = HashMap::new(); // session_id -> project
        let mut parse_errors = 0usize;
        let mut read_errors = 0usize;

        for line_result in BufReader::new(file).lines() {
            let line = match line_result {
                Ok(line) => line,
                Err(_) => {
                    read_errors += 1;
                    continue;
                }
            };
            if let Ok(raw) = serde_json::from_str::<RawHistoryEntry>(&line) {
                let entry: HistoryEntry = raw.into();
                if !entry.session_id.is_empty() {
                    session_map
                        .entry(entry.session_id)
                        .or_insert(entry.project);
                }
            } else {
                parse_errors += 1;
            }
        }
        if parse_errors > 0 || read_errors > 0 {
            eprintln!(
                "Search index: ignored {} parse errors and {} read errors while scanning history",
                parse_errors, read_errors
            );
        }

        *self.total_sessions.lock().unwrap() = session_map.len() as u32;

        // Collect entries that need indexing
        let entries: Vec<(String, String, PathBuf)> = session_map
            .into_iter()
            .filter_map(|(session_id, project)| {
                let session_file = find_session_file(&session_id)?;
                let file_size = std::fs::metadata(&session_file).ok()?.len();
                if self.needs_reindex(&session_id, file_size) {
                    Some((session_id, project, session_file))
                } else {
                    None
                }
            })
            .collect();

        eprintln!(
            "Search index: {} sessions to index out of {}",
            entries.len(),
            self.total_sessions.lock().unwrap()
        );

        // Index sequentially without per-session commit, then batch commit
        for (session_id, project, session_file) in &entries {
            if let Err(e) = self.index_session_no_commit(session_id, project, session_file) {
                eprintln!("Failed to index session {}: {}", session_id, e);
            }
        }

        self.writer.lock().unwrap().commit()?;
        self.save_meta();

        eprintln!("Search index: build complete");
        Ok(())
    }

    pub fn update_sessions(&self, session_ids: &[String]) -> Result<(), Box<dyn std::error::Error>> {
        let history_path = history_file();
        if !history_path.exists() {
            return Ok(());
        }

        // Find project for each session_id
        let file = File::open(&history_path)?;
        let mut session_project: HashMap<String, String> = HashMap::new();
        let id_set: std::collections::HashSet<&String> = session_ids.iter().collect();

        let mut parse_errors = 0usize;
        let mut read_errors = 0usize;
        for line_result in BufReader::new(file).lines() {
            let line = match line_result {
                Ok(line) => line,
                Err(_) => {
                    read_errors += 1;
                    continue;
                }
            };
            if let Ok(raw) = serde_json::from_str::<RawHistoryEntry>(&line) {
                let entry: HistoryEntry = raw.into();
                if id_set.contains(&entry.session_id) {
                    session_project
                        .entry(entry.session_id)
                        .or_insert(entry.project);
                }
            } else {
                parse_errors += 1;
            }
        }
        if parse_errors > 0 || read_errors > 0 {
            eprintln!(
                "Search index: ignored {} parse errors and {} read errors in incremental update",
                parse_errors, read_errors
            );
        }

        for (session_id, project) in &session_project {
            if let Some(session_file) = find_session_file(session_id) {
                if let Err(e) = self.index_session_no_commit(session_id, project, &session_file) {
                    eprintln!("Failed to update index for session {}: {}", session_id, e);
                }
            }
        }

        self.writer.lock().unwrap().commit()?;
        self.save_meta();
        Ok(())
    }

    pub fn get_status(&self) -> SearchIndexStatus {
        let indexed = self.indexed_sessions.read().unwrap().len() as u32;
        let total = *self.total_sessions.lock().unwrap();
        SearchIndexStatus {
            total_sessions: total,
            indexed_sessions: indexed,
            is_indexing: self.is_indexing.load(Ordering::SeqCst),
        }
    }
}

struct SearchableMessage {
    content: String,
    msg_type: String,
    timestamp: u64,
    message_index: u32,
}

fn escape_query_term(term: &str) -> String {
    let mut escaped = String::with_capacity(term.len());
    for ch in term.chars() {
        match ch {
            '+' | '-' | '=' | '&' | '|' | '>' | '<' | '!' | '(' | ')' | '{' | '}' | '['
            | ']' | '^' | '"' | '~' | '*' | '?' | ':' | '\\' | '/' => {
                escaped.push('\\');
                escaped.push(ch);
            }
            _ => escaped.push(ch),
        }
    }
    escaped
}
