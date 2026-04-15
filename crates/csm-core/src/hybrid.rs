//! BM25 と埋め込みベクトル検索を Reciprocal Rank Fusion (RRF) で合流させる。
//!
//! どちらのスコアも絶対値のスケールが違いすぎて直接足せないので、
//! ランク 0 始まりで `1 / (K + rank)` を加算するのが RRF。
//! 論文由来の K=60 を既定値にしている (実験値だが広く使われる)。
//!
//! マージ粒度はセッション単位。BM25 はメッセージ単位、ベクトルは chunk
//! 単位で返ってくるが、現時点ではまず「どのセッションが関連するか」を
//! 揃える方が UI 上のノイズが少ない。将来メッセージ粒度で合わせたく
//! なったら、この関数を差し替えればよい。

use std::collections::{HashMap, HashSet};

use serde::Serialize;

use crate::models::SearchHit;
use crate::vector_index::VectorHit;

const RRF_K: f32 = 60.0;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HybridHit {
    pub session_id: String,
    pub project: String,
    pub snippet: String,
    pub score: f32,
    pub timestamp: u64,
    pub message_index: u32,
    /// BM25 由来なら元メッセージの "user" / "assistant"。
    /// ベクトル単独ヒットは "hybrid" (chunk 粒度で role が特定できない)。
    pub msg_type: String,
    /// どの経路でヒットしたか ("bm25" / "vector" / 両方)。UI バッジ用。
    pub matched_by: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_before: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_after: Option<String>,
}

/// BM25 / Vector の 2 本のランキングをセッション単位で融合する。
///
/// 同一セッションから BM25 側に複数ヒットがある場合、一番上位のランクを
/// そのセッションの代表として採用する (下位を加算すると上位語彙の
/// 重複で過剰評価される)。代表 snippet / context は常に BM25 優先で、
/// BM25 にヒットがなければベクトル側のものを使う。
pub fn rrf_merge(bm25: &[SearchHit], vector: &[VectorHit], limit: usize) -> Vec<HybridHit> {
    let mut merged: HashMap<String, HybridHit> = HashMap::new();

    // BM25: session の初出ランクだけを採用 (下位を加算すると語彙の重複で過剰評価)。
    // HashSet::insert の戻り値で初出/重複を判定し 1 パスで処理する。
    let mut seen_bm25: HashSet<&str> = HashSet::new();
    for (rank, hit) in bm25.iter().enumerate() {
        if !seen_bm25.insert(hit.session_id.as_str()) {
            continue;
        }
        let score = 1.0 / (RRF_K + rank as f32);
        merged.insert(
            hit.session_id.clone(),
            HybridHit {
                session_id: hit.session_id.clone(),
                project: hit.project.clone(),
                snippet: hit.snippet.clone(),
                score,
                timestamp: hit.timestamp,
                message_index: hit.message_index,
                msg_type: hit.msg_type.clone(),
                matched_by: vec!["bm25".to_string()],
                context_before: hit.context_before.clone(),
                context_after: hit.context_after.clone(),
            },
        );
    }

    // Vector: 既存があれば加算、なければ新規 ("hybrid" を msg_type に入れる)。
    let mut seen_vec: HashSet<&str> = HashSet::new();
    for (rank, hit) in vector.iter().enumerate() {
        if !seen_vec.insert(hit.session_id.as_str()) {
            continue;
        }
        let score = 1.0 / (RRF_K + rank as f32);
        match merged.get_mut(&hit.session_id) {
            Some(existing) => {
                existing.score += score;
                existing.matched_by.push("vector".to_string());
            }
            None => {
                merged.insert(
                    hit.session_id.clone(),
                    HybridHit {
                        session_id: hit.session_id.clone(),
                        project: hit.project.clone(),
                        snippet: hit.snippet.clone(),
                        score,
                        timestamp: hit.timestamp,
                        message_index: hit.msg_start,
                        msg_type: "hybrid".to_string(),
                        matched_by: vec!["vector".to_string()],
                        context_before: None,
                        context_after: None,
                    },
                );
            }
        }
    }

    let mut results: Vec<HybridHit> = merged.into_values().collect();
    results.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    results.truncate(limit);
    results
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bm25(session: &str, rank_snippet: &str) -> SearchHit {
        SearchHit {
            session_id: session.to_string(),
            project: "proj".to_string(),
            snippet: rank_snippet.to_string(),
            msg_type: "user".to_string(),
            timestamp: 0,
            message_index: 0,
            score: 1.0,
            context_before: None,
            context_after: None,
        }
    }

    fn vec_hit(session: &str) -> VectorHit {
        VectorHit {
            session_id: session.to_string(),
            project: "proj".to_string(),
            snippet: "vec snippet".to_string(),
            score: 0.8,
            timestamp: 0,
            msg_start: 0,
            msg_end: 0,
        }
    }

    #[test]
    fn session_matched_by_both_beats_single_path() {
        // BM25 単独 (rank 0) = 1/60 よりも、BM25 rank 1 + Vector rank 0 =
        // 1/61 + 1/60 のほうが高スコアになることを確認。
        // 両経路ヒットのセッションだけを Vector に入れて tie-breaking を避ける。
        let bm25 = vec![bm25("a", "a"), bm25("b", "b"), bm25("c", "c")];
        let vec_hits = vec![vec_hit("b")];
        let merged = rrf_merge(&bm25, &vec_hits, 10);

        assert_eq!(merged[0].session_id, "b");
        assert_eq!(merged[0].matched_by.len(), 2);
    }

    #[test]
    fn bm25_only_session_uses_bm25_snippet() {
        let bm25 = vec![bm25("a", "bm25-snippet")];
        let vec_hits: Vec<VectorHit> = vec![];
        let merged = rrf_merge(&bm25, &vec_hits, 10);
        assert_eq!(merged[0].snippet, "bm25-snippet");
        assert_eq!(merged[0].matched_by, vec!["bm25".to_string()]);
    }

    #[test]
    fn vector_only_session_uses_vector_snippet() {
        let merged = rrf_merge(&[], &[vec_hit("a")], 10);
        assert_eq!(merged[0].snippet, "vec snippet");
        assert_eq!(merged[0].matched_by, vec!["vector".to_string()]);
    }

    #[test]
    fn bm25_hit_preserves_msg_type() {
        let merged = rrf_merge(&[bm25("a", "snip")], &[], 10);
        // fixture bm25() は msg_type="user" を入れている。
        assert_eq!(merged[0].msg_type, "user");
    }

    #[test]
    fn vector_only_hit_uses_hybrid_msg_type() {
        let merged = rrf_merge(&[], &[vec_hit("a")], 10);
        assert_eq!(merged[0].msg_type, "hybrid");
    }

    #[test]
    fn duplicate_bm25_hits_for_same_session_use_top_rank_only() {
        // 同じセッションから BM25 が 3 回ヒットしても、1 件分の RRF のみ
        let hits = vec![bm25("a", "top"), bm25("a", "mid"), bm25("a", "bottom")];
        let merged = rrf_merge(&hits, &[], 10);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].snippet, "top");
        let expected = 1.0 / (RRF_K);
        assert!((merged[0].score - expected).abs() < 1e-6);
    }
}
