pub use csm_core::sessions::{archive_path, claude_dir};

#[tauri::command]
pub fn list_sessions(include_archived: bool) -> Vec<csm_core::models::SessionSummary> {
    csm_core::sessions::list_sessions(include_archived)
}

#[tauri::command]
pub fn get_session_detail(session_id: String) -> Result<csm_core::models::SessionDetail, String> {
    csm_core::sessions::get_session_detail(&session_id)
}
