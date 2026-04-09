use csm_core::models::{SearchHit, SearchIndexStatus};
use csm_core::search::SearchIndex;
use std::sync::Arc;

#[tauri::command]
pub async fn search_sessions(
    state: tauri::State<'_, Arc<SearchIndex>>,
    query: String,
    project: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<SearchHit>, String> {
    let limit = limit.unwrap_or(50);
    state
        .search(&query, project.as_deref(), limit)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_search_index_status(
    state: tauri::State<'_, Arc<SearchIndex>>,
) -> SearchIndexStatus {
    state.get_status()
}

#[tauri::command]
pub async fn update_search_index(
    state: tauri::State<'_, Arc<SearchIndex>>,
    session_ids: Vec<String>,
) -> Result<(), String> {
    state
        .update_sessions(&session_ids)
        .map_err(|e| e.to_string())
}
