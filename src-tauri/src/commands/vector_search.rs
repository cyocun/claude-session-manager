use csm_core::hybrid::{rrf_merge, HybridHit};
use csm_core::models::SearchSort;
use csm_core::search::SearchIndex;
use csm_core::vector_index::{VectorHit, VectorIndex, VectorIndexStatus};
use std::sync::Arc;

/// 重い同期処理を Tokio の worker に逃がす共通ヘルパー。
/// embedding の forward pass は `&mut self` を要求する都合で blocking しか
/// 書けず、Tauri の async コマンドからはこの経由でしか呼べない。
async fn run_blocking<F, T, E>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, E> + Send + 'static,
    T: Send + 'static,
    E: ToString + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_vector_index_status(state: tauri::State<'_, Arc<VectorIndex>>) -> VectorIndexStatus {
    state.status()
}

/// 全セッションを差分 index 化。モデル未 DL ならここで初回 DL が走る。
/// 戻り値は新規 / 更新した session の件数。
#[tauri::command]
pub async fn build_vector_index(
    state: tauri::State<'_, Arc<VectorIndex>>,
) -> Result<usize, String> {
    let idx = state.inner().clone();
    run_blocking(move || idx.build_full_index()).await
}

#[tauri::command]
pub async fn update_vector_index(
    state: tauri::State<'_, Arc<VectorIndex>>,
    session_ids: Vec<String>,
) -> Result<(), String> {
    let idx = state.inner().clone();
    run_blocking(move || idx.update_sessions(&session_ids)).await
}

#[tauri::command]
pub async fn vector_search(
    state: tauri::State<'_, Arc<VectorIndex>>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<VectorHit>, String> {
    let limit = limit.unwrap_or(50);
    let idx = state.inner().clone();
    run_blocking(move || idx.search(&query, limit)).await
}

/// BM25 と Vector を RRF で合流させたハイブリッド検索。
/// ベクトル側が未構築でも BM25 結果がそのまま返るのでフェイルソフト。
#[tauri::command]
pub async fn hybrid_search(
    bm25: tauri::State<'_, Arc<SearchIndex>>,
    vector: tauri::State<'_, Arc<VectorIndex>>,
    query: String,
    limit: Option<usize>,
    project: Option<String>,
) -> Result<Vec<HybridHit>, String> {
    let limit = limit.unwrap_or(30);
    // RRF の融合品質は各経路の top-N を広めに取るほど上がる。
    // 経路ごとに limit * 2 くらいが経験的に落としどころ。
    let per_source = limit * 2;

    let bm25_hits = bm25
        .search(
            &query,
            project.as_deref(),
            per_source,
            None,
            None,
            SearchSort::Relevance,
        )
        .map_err(|e| e.to_string())?;

    let idx = vector.inner().clone();
    let q = query.clone();
    let vec_hits = run_blocking(move || idx.search(&q, per_source))
        .await
        .unwrap_or_default();

    Ok(rrf_merge(&bm25_hits, &vec_hits, limit))
}
