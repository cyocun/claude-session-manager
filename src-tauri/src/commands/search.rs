use csm_core::models::{SearchHit, SearchIndexStatus, SearchSort, SearchTimeRange};
use csm_core::search::SearchIndex;
use std::sync::Arc;

#[tauri::command]
pub async fn search_sessions(
    state: tauri::State<'_, Arc<SearchIndex>>,
    query: String,
    project: Option<String>,
    limit: Option<usize>,
    time_range: Option<SearchTimeRange>,
    msg_types: Option<Vec<String>>,
    sort: Option<SearchSort>,
) -> Result<Vec<SearchHit>, String> {
    let limit = limit.unwrap_or(50);
    let sort = sort.unwrap_or_default();
    state
        .search(
            &query,
            project.as_deref(),
            limit,
            time_range.as_ref(),
            msg_types.as_deref(),
            sort,
        )
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
