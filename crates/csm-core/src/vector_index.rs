//! ベクトル検索インデックス。BM25 (tantivy) と並走し、意味的なヒットを拾う。
//!
//! Phase B: chunk 化・永続化・flat コサイン検索まで。ハイブリッド融合は Phase C。

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, RwLock,
};

use serde::{Deserialize, Serialize};

use crate::embedding::EmbeddingEngine;
use crate::models::{extract_searchable_messages, SearchableMessage};
use crate::sessions::{collect_session_projects, find_session_file};

const INDEX_VERSION: u32 = 1;

// chunk 境界: user 発話ごとに区切るが、長大タスクはサイズ上限で強制分割する。
// 数値は e5 系の推奨入力長（〜512 tokens ≒ ~2kB 日本語）に余白を持たせた値。
const MAX_CHUNK_MESSAGES: usize = 20;
const MAX_CHUNK_CHARS: usize = 4000;

// e5 系はタスク指示プレフィックスで精度が大きく変わる。固定値。
const PASSAGE_PREFIX: &str = "passage: ";
const QUERY_PREFIX: &str = "query: ";

// プレビュー用にチャンク先頭を切り出す長さ。UI 行の 2 行クランプに収まる程度。
const SNIPPET_CHARS: usize = 220;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChunkRecord {
    pub session_id: String,
    pub project: String,
    /// chunk に含まれる最初のメッセージの message_index
    pub msg_start: u32,
    /// chunk に含まれる最後のメッセージの message_index
    pub msg_end: u32,
    pub snippet: String,
    /// chunk 内の最新タイムスタンプ (epoch-ms)
    pub timestamp: u64,
    pub vector: Vec<f32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VectorHit {
    pub session_id: String,
    pub project: String,
    pub snippet: String,
    pub score: f32,
    pub timestamp: u64,
    pub msg_start: u32,
    pub msg_end: u32,
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct PersistedIndex {
    version: u32,
    /// session_id → 最後に embed した時点のファイルサイズ
    sessions: HashMap<String, u64>,
    chunks: Vec<ChunkRecord>,
}

pub struct VectorIndex {
    data_path: PathBuf,
    engine: Arc<EmbeddingEngine>,
    chunks: RwLock<Vec<ChunkRecord>>,
    sessions: RwLock<HashMap<String, u64>>,
    is_indexing: AtomicBool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VectorIndexStatus {
    pub indexed_sessions: u32,
    pub chunk_count: u32,
    pub is_indexing: bool,
}

/// 永続化前の chunk。embedding 取得前の中間表現。
#[derive(Debug, Clone, PartialEq)]
pub struct PendingChunk {
    pub session_id: String,
    pub project: String,
    pub msg_start: u32,
    pub msg_end: u32,
    pub text: String,
    pub snippet: String,
    pub timestamp: u64,
}

impl VectorIndex {
    pub fn new(data_dir: PathBuf, engine: Arc<EmbeddingEngine>) -> Result<Self, String> {
        std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
        let data_path = data_dir.join("vector-index.json");
        let persisted = load_persisted(&data_path).unwrap_or_default();

        // バージョン不一致なら中身を破棄（スキーマ変更時の安全弁）
        let (chunks, sessions) = if persisted.version == INDEX_VERSION {
            (persisted.chunks, persisted.sessions)
        } else {
            (Vec::new(), HashMap::new())
        };

        Ok(Self {
            data_path,
            engine,
            chunks: RwLock::new(chunks),
            sessions: RwLock::new(sessions),
            is_indexing: AtomicBool::new(false),
        })
    }

    pub fn chunk_count(&self) -> usize {
        self.chunks.read().unwrap().len()
    }

    pub fn status(&self) -> VectorIndexStatus {
        VectorIndexStatus {
            indexed_sessions: self.sessions.read().unwrap().len() as u32,
            chunk_count: self.chunks.read().unwrap().len() as u32,
            is_indexing: self.is_indexing.load(Ordering::SeqCst),
        }
    }

    pub fn needs_reindex(&self, session_id: &str, file_size: u64) -> bool {
        let map = self.sessions.read().unwrap();
        map.get(session_id).map(|v| *v != file_size).unwrap_or(true)
    }

    /// 指定セッションを chunk 化して embed し、インデックスに反映。
    /// embed 実行中はモデルロック (fastembed 内部) を取るためスレッドごとに直列。
    pub fn index_session(&self, session_id: &str, project: &str) -> Result<(), String> {
        let path = find_session_file(session_id).ok_or("session file not found")?;
        let file_size = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
        let file = File::open(&path).map_err(|e| e.to_string())?;
        let msgs = extract_searchable_messages(&file);
        let pending = build_chunks(session_id, project, &msgs);

        let texts: Vec<String> = pending
            .iter()
            .map(|p| format!("{}{}", PASSAGE_PREFIX, p.text))
            .collect();
        let vectors = if texts.is_empty() {
            Vec::new()
        } else {
            self.engine.embed(texts)?
        };

        let mut new_records: Vec<ChunkRecord> = Vec::with_capacity(pending.len());
        for (p, v) in pending.into_iter().zip(vectors.into_iter()) {
            new_records.push(ChunkRecord {
                session_id: p.session_id,
                project: p.project,
                msg_start: p.msg_start,
                msg_end: p.msg_end,
                snippet: p.snippet,
                timestamp: p.timestamp,
                vector: v,
            });
        }

        {
            let mut chunks = self.chunks.write().unwrap();
            chunks.retain(|c| c.session_id != session_id);
            chunks.extend(new_records);
        }
        {
            let mut sessions = self.sessions.write().unwrap();
            sessions.insert(session_id.to_string(), file_size);
        }
        Ok(())
    }

    /// クエリ文字列を embed し、chunks 全件にコサイン類似度でスコアリング。
    /// chunks が数万規模なら flat で十分速い (1024 dim × 5万 ≒ 数十ms)。
    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<VectorHit>, String> {
        let chunks = self.chunks.read().unwrap();
        if chunks.is_empty() {
            return Ok(Vec::new());
        }
        let prefixed = format!("{}{}", QUERY_PREFIX, query);
        let q_vec = self
            .engine
            .embed(vec![prefixed])?
            .into_iter()
            .next()
            .ok_or("no embedding returned for query")?;

        let mut scored: Vec<(f32, &ChunkRecord)> = chunks
            .iter()
            .map(|c| (cosine(&q_vec, &c.vector), c))
            .collect();
        scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(limit);

        Ok(scored
            .into_iter()
            .map(|(score, c)| VectorHit {
                session_id: c.session_id.clone(),
                project: c.project.clone(),
                snippet: c.snippet.clone(),
                score,
                timestamp: c.timestamp,
                msg_start: c.msg_start,
                msg_end: c.msg_end,
            })
            .collect())
    }

    /// history.jsonl に載っている全セッションを差分 index 化。
    /// 既に `needs_reindex` が false なセッションはスキップするため、
    /// 2 回目以降は新規/更新セッションのみ embed が走る。
    pub fn build_full_index(&self) -> Result<usize, String> {
        self.is_indexing.store(true, Ordering::SeqCst);
        let _guard = IndexingGuard {
            flag: &self.is_indexing,
        };

        let session_map = collect_session_projects(None).map_err(|e| e.to_string())?;
        let mut indexed = 0usize;
        for (session_id, project) in &session_map {
            let Some(path) = find_session_file(session_id) else {
                continue;
            };
            let size = match std::fs::metadata(&path) {
                Ok(m) => m.len(),
                Err(_) => continue,
            };
            if !self.needs_reindex(session_id, size) {
                continue;
            }
            if let Err(e) = self.index_session(session_id, project) {
                eprintln!("vector index: failed to index {}: {}", session_id, e);
                continue;
            }
            indexed += 1;
        }
        self.save()?;
        Ok(indexed)
    }

    /// 指定 session_id の差分更新。主に新規会話が追加された場合に呼ぶ。
    pub fn update_sessions(&self, session_ids: &[String]) -> Result<(), String> {
        if self.is_indexing.load(Ordering::SeqCst) {
            // 全 index build と被ったら skip (writer 取り合い防止)
            return Ok(());
        }
        let id_set: HashSet<&String> = session_ids.iter().collect();
        let session_map = collect_session_projects(Some(&id_set)).map_err(|e| e.to_string())?;
        for (session_id, project) in &session_map {
            if let Err(e) = self.index_session(session_id, project) {
                eprintln!("vector index: failed to update {}: {}", session_id, e);
            }
        }
        self.save()
    }

    pub fn save(&self) -> Result<(), String> {
        let chunks = self.chunks.read().unwrap();
        let sessions = self.sessions.read().unwrap();
        let persisted = PersistedIndex {
            version: INDEX_VERSION,
            sessions: sessions.clone(),
            chunks: chunks.clone(),
        };
        let json = serde_json::to_string(&persisted).map_err(|e| e.to_string())?;
        std::fs::write(&self.data_path, json).map_err(|e| e.to_string())
    }
}

struct IndexingGuard<'a> {
    flag: &'a AtomicBool,
}

impl Drop for IndexingGuard<'_> {
    fn drop(&mut self) {
        self.flag.store(false, Ordering::SeqCst);
    }
}

fn load_persisted(path: &Path) -> Option<PersistedIndex> {
    let file = File::open(path).ok()?;
    serde_json::from_reader(BufReader::new(file)).ok()
}

/// user 発話を境界にメッセージ列をグループ化。
///
/// - 最初の user まで続く assistant だけの前置きは 1 chunk
/// - user を先頭に、次の user 直前までを 1 chunk
/// - `MAX_CHUNK_MESSAGES` または `MAX_CHUNK_CHARS` を超えたら強制分割
pub fn build_chunks(
    session_id: &str,
    project: &str,
    msgs: &[SearchableMessage],
) -> Vec<PendingChunk> {
    let mut out: Vec<PendingChunk> = Vec::new();
    let mut buf: Vec<&SearchableMessage> = Vec::new();
    let mut buf_chars: usize = 0;

    let flush = |buf: &mut Vec<&SearchableMessage>,
                 buf_chars: &mut usize,
                 out: &mut Vec<PendingChunk>| {
        if buf.is_empty() {
            return;
        }
        let msg_start = buf.first().unwrap().message_index;
        let msg_end = buf.last().unwrap().message_index;
        let timestamp = buf.iter().map(|m| m.timestamp).max().unwrap_or(0);
        let joined: String = buf
            .iter()
            .map(|m| m.content.as_str())
            .collect::<Vec<_>>()
            .join("\n---\n");
        let snippet = first_chars(&joined, SNIPPET_CHARS);
        out.push(PendingChunk {
            session_id: session_id.to_string(),
            project: project.to_string(),
            msg_start,
            msg_end,
            text: joined,
            snippet,
            timestamp,
        });
        buf.clear();
        *buf_chars = 0;
    };

    for msg in msgs {
        let msg_chars = msg.content.chars().count();
        let starts_new_task = msg.msg_type == "user" && !buf.is_empty();
        let would_exceed = buf.len() >= MAX_CHUNK_MESSAGES
            || (buf_chars + msg_chars > MAX_CHUNK_CHARS && !buf.is_empty());
        if starts_new_task || would_exceed {
            flush(&mut buf, &mut buf_chars, &mut out);
        }
        buf.push(msg);
        buf_chars += msg_chars;
    }
    flush(&mut buf, &mut buf_chars, &mut out);
    out
}

fn first_chars(s: &str, n: usize) -> String {
    let collapsed: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.chars().take(n).collect()
}

fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() {
        return 0.0;
    }
    let mut dot = 0.0f32;
    let mut na = 0.0f32;
    let mut nb = 0.0f32;
    for (x, y) in a.iter().zip(b.iter()) {
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    if na == 0.0 || nb == 0.0 {
        0.0
    } else {
        dot / (na.sqrt() * nb.sqrt())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::SearchableMessage;

    fn msg(idx: u32, ty: &str, text: &str, ts: u64) -> SearchableMessage {
        SearchableMessage {
            content: text.to_string(),
            msg_type: ty.to_string(),
            timestamp: ts,
            message_index: idx,
        }
    }

    #[test]
    fn chunks_split_on_user_boundary() {
        let msgs = vec![
            msg(0, "user", "最初の質問", 100),
            msg(1, "assistant", "答え1", 110),
            msg(2, "user", "次の質問", 200),
            msg(3, "assistant", "答え2", 210),
        ];
        let chunks = build_chunks("s1", "proj", &msgs);
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].msg_start, 0);
        assert_eq!(chunks[0].msg_end, 1);
        assert_eq!(chunks[1].msg_start, 2);
        assert_eq!(chunks[1].msg_end, 3);
    }

    #[test]
    fn assistant_only_prologue_becomes_own_chunk() {
        let msgs = vec![
            msg(0, "assistant", "recap", 50),
            msg(1, "user", "質問", 100),
            msg(2, "assistant", "回答", 110),
        ];
        let chunks = build_chunks("s1", "proj", &msgs);
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].msg_end, 0);
        assert_eq!(chunks[1].msg_start, 1);
    }

    #[test]
    fn cosine_is_one_for_identical_vectors() {
        let v = vec![0.1, 0.2, 0.3];
        let score = cosine(&v, &v);
        assert!((score - 1.0).abs() < 1e-6, "score={}", score);
    }

    #[test]
    fn cosine_is_zero_for_orthogonal_vectors() {
        let a = vec![1.0, 0.0];
        let b = vec![0.0, 1.0];
        assert_eq!(cosine(&a, &b), 0.0);
    }
}
