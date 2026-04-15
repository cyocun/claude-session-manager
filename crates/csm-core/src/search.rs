use tantivy::schema::document::Value as _;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::ops::Bound;
use std::path::{Path, PathBuf};
use std::sync::{atomic::{AtomicBool, AtomicU64, Ordering}, Mutex, RwLock};
use tantivy::collector::TopDocs;
use tantivy::query::{BooleanQuery, FuzzyTermQuery, Occur, PhraseQuery, PhrasePrefixQuery, QueryParser, RangeQuery, TermQuery};
use tantivy::schema::*;
use tantivy::snippet::SnippetGenerator;
use tantivy::{doc, Index, IndexReader, IndexWriter, ReloadPolicy, TantivyDocument};

use crate::sessions::{find_session_file, history_file};
use crate::models::{extract_searchable_messages, HistoryEntry, RawHistoryEntry, SearchHit, SearchIndexStatus, SearchSort, SearchTimeRange};

const MAX_CONTENT_CHARS: usize = 50 * 1024; // 50K chars per document
const WRITER_HEAP_SIZE: usize = 50 * 1024 * 1024; // 50MB
const INDEX_VERSION: u32 = 3; // Bump when schema/tokenizer changes to force reindex
const TOKENIZER_NAME: &str = "lindera_ipadic";

// PhraseQuery slop: how many positions can intervene between consecutive
// phrase terms before the match fails. 2 is enough to absorb a single
// Japanese particle (e.g. "Tauri の ビルド" matching "Tauri ビルド").
const PHRASE_SLOP: u32 = 2;

// Time-decay tau (in days) for sort=relevance_recent. exp(-days/tau)
// gives a half-life of ~tau * ln(2) ≈ 9.7 days at tau=14.
const RECENT_TAU_DAYS: f32 = 14.0;
const MS_PER_DAY: f32 = 86_400_000.0;

// Keep result-row context snippets short — they sit beneath the main snippet
// in a 2-line clamp.
const CONTEXT_SNIPPET_CHARS: usize = 140;

pub struct SearchIndex {
    index: Index,
    reader: IndexReader,
    writer: Mutex<IndexWriter>,
    segmenter: lindera::segmenter::Segmenter,
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
    // Phase 2: count messages whose content was truncated at MAX_CONTENT_CHARS
    // during indexing. Logged at end of build_full_index so we can decide
    // whether the limit needs raising or whether splitting is required.
    truncated_messages: AtomicU64,
}

struct IndexingFlagGuard<'a> {
    flag: &'a AtomicBool,
}

impl Drop for IndexingFlagGuard<'_> {
    fn drop(&mut self) {
        self.flag.store(false, Ordering::SeqCst);
    }
}

/// Recompute scores in place (for `relevance_recent`) and sort. The decay
/// uses elapsed-time relative to the most recent hit's timestamp rather than
/// wall-clock `now`, so tests don't drift and sessions from older time-frames
/// still get internally ranked sensibly.
fn apply_sort(results: &mut Vec<SearchHit>, sort: SearchSort) {
    match sort {
        SearchSort::Relevance => {
            results.sort_by(|a, b| {
                b.score
                    .partial_cmp(&a.score)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
        }
        SearchSort::Newest => {
            results.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
        }
        SearchSort::Oldest => {
            results.sort_by(|a, b| a.timestamp.cmp(&b.timestamp));
        }
        SearchSort::RelevanceRecent => {
            let now_ms = results.iter().map(|h| h.timestamp).max().unwrap_or(0);
            for hit in results.iter_mut() {
                if hit.timestamp == 0 || now_ms == 0 {
                    continue;
                }
                let elapsed_ms = now_ms.saturating_sub(hit.timestamp) as f32;
                let days = elapsed_ms / MS_PER_DAY;
                let decay = (-days / RECENT_TAU_DAYS).exp();
                hit.score *= decay;
            }
            results.sort_by(|a, b| {
                b.score
                    .partial_cmp(&a.score)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
        }
    }
}

/// Compact the source content of a single message into a one-line snippet
/// short enough to live under the main snippet without doubling the row
/// height.
fn compact_for_context(raw: &str) -> String {
    let collapsed: String = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.chars().take(CONTEXT_SNIPPET_CHARS).collect()
}

/// Read each session file at most once and attach 1-message before/after
/// context to every hit in that session. Falls back gracefully when the file
/// can't be parsed — context is purely informational, so absence is OK.
fn attach_context(results: &mut [SearchHit]) {
    let mut by_session: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, hit) in results.iter().enumerate() {
        by_session
            .entry(hit.session_id.clone())
            .or_default()
            .push(i);
    }

    for (session_id, indices) in by_session {
        let session_file = match find_session_file(&session_id) {
            Some(p) => p,
            None => continue,
        };
        let file = match File::open(&session_file) {
            Ok(f) => f,
            Err(_) => continue,
        };
        let msgs = extract_searchable_messages(&file);
        if msgs.is_empty() {
            continue;
        }
        let mut pos_by_idx: HashMap<u32, usize> = HashMap::with_capacity(msgs.len());
        for (pos, m) in msgs.iter().enumerate() {
            pos_by_idx.insert(m.message_index, pos);
        }

        for hit_idx in indices {
            let target_index = results[hit_idx].message_index;
            let pos = match pos_by_idx.get(&target_index) {
                Some(&p) => p,
                None => continue,
            };
            if pos > 0 {
                let before = compact_for_context(&msgs[pos - 1].content);
                if !before.is_empty() {
                    results[hit_idx].context_before = Some(before);
                }
            }
            if pos + 1 < msgs.len() {
                let after = compact_for_context(&msgs[pos + 1].content);
                if !after.is_empty() {
                    results[hit_idx].context_after = Some(after);
                }
            }
        }
    }
}

/// Parse history.jsonl and collect session_id → project mappings.
/// When `session_filter` is Some, only sessions in the set are collected.
fn collect_session_projects(
    session_filter: Option<&HashSet<&String>>,
) -> Result<HashMap<String, String>, Box<dyn std::error::Error>> {
    let history_path = history_file();
    if !history_path.exists() {
        return Ok(HashMap::new());
    }

    let file = File::open(&history_path)?;
    let mut session_map: HashMap<String, String> = HashMap::new();
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
            if entry.session_id.is_empty() {
                continue;
            }
            if let Some(filter) = session_filter {
                if !filter.contains(&entry.session_id) {
                    continue;
                }
            }
            session_map
                .entry(entry.session_id)
                .or_insert(entry.project);
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

    Ok(session_map)
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
        let dictionary = lindera::dictionary::load_dictionary("embedded://ipadic")
            .map_err(|e| format!("Failed to load IPAdic dictionary: {}", e))?;
        let segmenter_for_index = lindera::segmenter::Segmenter::new(
            lindera::mode::Mode::Normal,
            dictionary,
            None,
        );
        index.tokenizers().register(
            TOKENIZER_NAME,
            lindera_tantivy::tokenizer::LinderaTokenizer::from_segmenter(segmenter_for_index),
        );

        // Separate segmenter instance for tokenizing search queries
        let query_dictionary = lindera::dictionary::load_dictionary("embedded://ipadic")
            .map_err(|e| format!("Failed to load IPAdic dictionary for query: {}", e))?;
        let segmenter = lindera::segmenter::Segmenter::new(
            lindera::mode::Mode::Normal,
            query_dictionary,
            None,
        );

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
            segmenter,
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
            truncated_messages: AtomicU64::new(0),
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
        let messages = extract_searchable_messages(&file);

        let writer = self.writer.lock().unwrap();

        // Delete existing documents for this session
        let term = tantivy::Term::from_field_text(self.f_session_id, session_id);
        writer.delete_term(term);

        // Add new documents
        for msg in &messages {
            let total_chars = msg.content.chars().count();
            let content: String = if total_chars > MAX_CONTENT_CHARS {
                self.truncated_messages.fetch_add(1, Ordering::Relaxed);
                msg.content.chars().take(MAX_CONTENT_CHARS).collect()
            } else {
                msg.content.clone()
            };
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

    pub fn search(
        &self,
        query_str: &str,
        project_filter: Option<&str>,
        limit: usize,
        time_range: Option<&SearchTimeRange>,
        msg_types: Option<&[String]>,
        sort: SearchSort,
    ) -> Result<Vec<SearchHit>, Box<dyn std::error::Error>> {
        let limit = limit.min(500);
        let searcher = self.reader.searcher();
        let query_parser = QueryParser::for_index(&self.index, vec![self.f_content]);

        // Tokenize each whitespace-delimited chunk with lindera, then build
        // a PhraseQuery per chunk (consecutive token match). Multiple chunks
        // are combined with AND.
        let chunks: Vec<&str> = query_str.split_whitespace().collect();
        let mut must_clauses: Vec<(Occur, Box<dyn tantivy::query::Query>)> = Vec::new();

        for chunk in &chunks {
            let lowered = chunk.to_lowercase();
            let mut tokens = self.segmenter.segment(lowered.clone().into())
                .unwrap_or_default();
            let token_strings: Vec<String> = tokens
                .iter_mut()
                .map(|t| t.surface.to_string())
                .filter(|s| !s.trim().is_empty())
                .collect();

            if token_strings.is_empty() {
                continue;
            }

            if token_strings.len() == 1 {
                // Single token: use prefix query for partial matching
                let term = tantivy::Term::from_field_text(self.f_content, &token_strings[0]);
                let prefix_q = PhrasePrefixQuery::new(vec![term.clone()]);
                let mut should: Vec<(Occur, Box<dyn tantivy::query::Query>)> = vec![
                    (Occur::Should, Box::new(prefix_q)),
                ];
                // Fuzzy for longer tokens
                if token_strings[0].chars().count() >= 4 {
                    should.push((Occur::Should, Box::new(FuzzyTermQuery::new(term, 1, true))));
                }
                must_clauses.push((Occur::Must, Box::new(BooleanQuery::new(should))));
            } else {
                // Multiple tokens: PhraseQuery with slop so a single particle
                // (e.g. "の" / "を") between phrase terms doesn't drop the hit.
                let phrase_terms: Vec<tantivy::Term> = token_strings
                    .iter()
                    .map(|s| tantivy::Term::from_field_text(self.f_content, s))
                    .collect();
                let mut phrase_q = PhraseQuery::new(phrase_terms);
                phrase_q.set_slop(PHRASE_SLOP);
                must_clauses.push((Occur::Must, Box::new(phrase_q)));
            }
        }

        let text_query: Box<dyn tantivy::query::Query> = if must_clauses.is_empty() {
            let (query, _errors) = query_parser.parse_query_lenient(&query_str.to_lowercase());
            query
        } else {
            Box::new(BooleanQuery::new(must_clauses))
        };

        // Compose filters as additional MUST clauses on top of the text query.
        let mut filtered: Vec<(Occur, Box<dyn tantivy::query::Query>)> =
            vec![(Occur::Must, text_query)];

        if let Some(project) = project_filter {
            filtered.push((
                Occur::Must,
                Box::new(TermQuery::new(
                    tantivy::Term::from_field_text(self.f_project, project),
                    IndexRecordOption::Basic,
                )),
            ));
        }

        if let Some(types) = msg_types {
            let allowed: Vec<&String> = types
                .iter()
                .filter(|s| !s.is_empty())
                .collect();
            if !allowed.is_empty() {
                let type_clauses: Vec<(Occur, Box<dyn tantivy::query::Query>)> = allowed
                    .iter()
                    .map(|t| {
                        let q = TermQuery::new(
                            tantivy::Term::from_field_text(self.f_msg_type, t),
                            IndexRecordOption::Basic,
                        );
                        (Occur::Should, Box::new(q) as Box<dyn tantivy::query::Query>)
                    })
                    .collect();
                filtered.push((Occur::Must, Box::new(BooleanQuery::new(type_clauses))));
            }
        }

        if let Some(range) = time_range {
            let lower = match range.from {
                Some(v) => Bound::Included(tantivy::Term::from_field_u64(self.f_timestamp, v)),
                None => Bound::Unbounded,
            };
            let upper = match range.to {
                Some(v) => Bound::Excluded(tantivy::Term::from_field_u64(self.f_timestamp, v)),
                None => Bound::Unbounded,
            };
            // Skip building a no-op range query when both bounds are absent.
            if !matches!((&lower, &upper), (Bound::Unbounded, Bound::Unbounded)) {
                filtered.push((Occur::Must, Box::new(RangeQuery::new(lower, upper))));
            }
        }

        let final_query: Box<dyn tantivy::query::Query> = if filtered.len() == 1 {
            filtered.into_iter().next().unwrap().1
        } else {
            Box::new(BooleanQuery::new(filtered))
        };

        // Fetch a pool larger than `limit` so post-processing (decay rescoring,
        // context attachment) has headroom to reorder before truncation.
        let pool_size = (limit * 5).max(limit);
        let top_docs = searcher.search(&final_query, &TopDocs::with_limit(pool_size))?;

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
                context_before: None,
                context_after: None,
            });
        }

        // Apply sort (decay-rescore for relevance_recent runs before truncation
        // so a strong-but-recent doc can leapfrog a stronger-but-older one).
        apply_sort(&mut results, sort);
        results.truncate(limit);

        // Attach 1-message context before/after each hit. Done after truncation
        // to avoid file reads for hits we drop.
        attach_context(&mut results);

        Ok(results)
    }

    pub fn build_full_index(&self) -> Result<(), Box<dyn std::error::Error>> {
        self.is_indexing.store(true, Ordering::SeqCst);
        let _indexing_guard = IndexingFlagGuard {
            flag: &self.is_indexing,
        };

        let session_map = collect_session_projects(None)?;
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

        let truncated = self.truncated_messages.load(Ordering::Relaxed);
        if truncated > 0 {
            eprintln!(
                "Search index: build complete ({} messages truncated at {} chars)",
                truncated, MAX_CONTENT_CHARS
            );
        } else {
            eprintln!("Search index: build complete");
        }
        Ok(())
    }

    pub fn update_sessions(&self, session_ids: &[String]) -> Result<(), Box<dyn std::error::Error>> {
        // Skip if full index build is in progress to avoid writer contention
        if self.is_indexing.load(Ordering::SeqCst) {
            return Ok(());
        }

        let id_set: HashSet<&String> = session_ids.iter().collect();
        let session_project = collect_session_projects(Some(&id_set))?;

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
