use serde_json::Value;
use tantivy::schema::document::Value as _;
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{atomic::{AtomicBool, Ordering}, Mutex, RwLock};
use tantivy::collector::TopDocs;
use tantivy::query::{BooleanQuery, Occur, QueryParser, TermQuery};
use tantivy::schema::*;
use tantivy::snippet::SnippetGenerator;
use tantivy::{doc, Index, IndexReader, IndexWriter, ReloadPolicy, TantivyDocument};

use crate::commands::sessions::{claude_dir, find_session_file};
use crate::models::{normalize_message_text, HistoryEntry, RawHistoryEntry, SearchHit, SearchIndexStatus};

const MAX_CONTENT_BYTES: usize = 50 * 1024; // 50KB per document
const WRITER_HEAP_SIZE: usize = 50 * 1024 * 1024; // 50MB

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

impl SearchIndex {
    pub fn new(index_dir: PathBuf) -> Result<Self, Box<dyn std::error::Error>> {
        std::fs::create_dir_all(&index_dir)?;

        let mut schema_builder = Schema::builder();
        let f_session_id = schema_builder.add_text_field("session_id", STRING | STORED);
        let f_project = schema_builder.add_text_field("project", STRING | STORED);
        let f_content = schema_builder.add_text_field("content", TEXT | STORED);
        let f_msg_type = schema_builder.add_text_field("msg_type", STRING | STORED);
        let f_timestamp = schema_builder.add_u64_field("timestamp", INDEXED | STORED | FAST);
        let f_message_index = schema_builder.add_u64_field("message_index", STORED);
        let schema = schema_builder.build();

        let index = Index::open_or_create(
            tantivy::directory::MmapDirectory::open(&index_dir)?,
            schema,
        )?;

        let reader = index
            .reader_builder()
            .reload_policy(ReloadPolicy::OnCommitWithDelay)
            .try_into()?;

        let writer = index.writer(WRITER_HEAP_SIZE)?;

        let meta_path = index_dir.join("index-meta.json");
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
        let meta = serde_json::json!({ "sessions": sessions });
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

    pub fn index_session(
        &self,
        session_id: &str,
        project: &str,
        session_file: &Path,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let file = File::open(session_file)?;
        let messages = Self::extract_searchable_messages(&file);

        let mut writer = self.writer.lock().unwrap();

        // Delete existing documents for this session
        let term = tantivy::Term::from_field_text(self.f_session_id, session_id);
        writer.delete_term(term);

        // Add new documents
        for msg in &messages {
            let content: String = msg.content.chars().take(MAX_CONTENT_BYTES).collect();
            writer.add_document(doc!(
                self.f_session_id => session_id,
                self.f_project => project,
                self.f_content => content,
                self.f_msg_type => msg.msg_type.as_str(),
                self.f_timestamp => msg.timestamp,
                self.f_message_index => msg.message_index as u64,
            ))?;
        }

        writer.commit()?;

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

        let text_query = query_parser.parse_query(query_str)?;

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
            let snippet_html = snippet.to_html();

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

        let history_path = claude_dir().join("history.jsonl");
        if !history_path.exists() {
            self.is_indexing.store(false, Ordering::SeqCst);
            return Ok(());
        }

        // Collect session entries from history
        let file = File::open(&history_path)?;
        let mut session_map: HashMap<String, String> = HashMap::new(); // session_id -> project

        for line in BufReader::new(file).lines().flatten() {
            if let Ok(raw) = serde_json::from_str::<RawHistoryEntry>(&line) {
                let entry: HistoryEntry = raw.into();
                if !entry.session_id.is_empty() {
                    session_map
                        .entry(entry.session_id)
                        .or_insert(entry.project);
                }
            }
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

        // Index sequentially (writer is single-threaded)
        for (session_id, project, session_file) in &entries {
            if let Err(e) = self.index_session(session_id, project, session_file) {
                eprintln!("Failed to index session {}: {}", session_id, e);
            }
        }

        self.save_meta();
        self.is_indexing.store(false, Ordering::SeqCst);

        eprintln!("Search index: build complete");
        Ok(())
    }

    pub fn update_sessions(&self, session_ids: &[String]) -> Result<(), Box<dyn std::error::Error>> {
        let history_path = claude_dir().join("history.jsonl");
        if !history_path.exists() {
            return Ok(());
        }

        // Find project for each session_id
        let file = File::open(&history_path)?;
        let mut session_project: HashMap<String, String> = HashMap::new();
        let id_set: std::collections::HashSet<&String> = session_ids.iter().collect();

        for line in BufReader::new(file).lines().flatten() {
            if let Ok(raw) = serde_json::from_str::<RawHistoryEntry>(&line) {
                let entry: HistoryEntry = raw.into();
                if id_set.contains(&entry.session_id) {
                    session_project
                        .entry(entry.session_id)
                        .or_insert(entry.project);
                }
            }
        }

        for (session_id, project) in &session_project {
            if let Some(session_file) = find_session_file(session_id) {
                if let Err(e) = self.index_session(session_id, project, &session_file) {
                    eprintln!("Failed to update index for session {}: {}", session_id, e);
                }
            }
        }

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
