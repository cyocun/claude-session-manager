pub use csm_core::sessions::{archive_path, claude_dir};

#[tauri::command]
pub fn list_sessions(include_archived: bool) -> Vec<csm_core::models::SessionSummary> {
    csm_core::sessions::list_sessions(include_archived)
}

#[tauri::command]
pub fn get_session_detail(session_id: String) -> Result<csm_core::models::SessionDetail, String> {
    csm_core::sessions::get_session_detail(&session_id)
}

// Used by the search preview pane: returns a window of messages centered on
// `message_index`. The frontend could slice from `get_session_detail` itself,
// but doing it here keeps the payload small when sessions have thousands of
// messages and lets us return positional metadata the preview needs.
#[tauri::command]
pub fn get_session_messages_around(
    session_id: String,
    message_index: u32,
    window: u32,
) -> Result<csm_core::models::SessionMessagesAround, String> {
    let detail = csm_core::sessions::get_session_detail(&session_id)?;
    let total = detail.messages.len();
    if total == 0 {
        return Ok(csm_core::models::SessionMessagesAround {
            session_id: detail.session_id,
            project: detail.project,
            start_index: 0,
            focus_offset: 0,
            total: 0,
            messages: Vec::new(),
        });
    }
    let idx = (message_index as usize).min(total - 1);
    let w = window as usize;
    let start = idx.saturating_sub(w);
    let end = (idx + w + 1).min(total);
    let messages = detail.messages[start..end].to_vec();
    Ok(csm_core::models::SessionMessagesAround {
        session_id: detail.session_id,
        project: detail.project,
        start_index: start as u32,
        focus_offset: (idx - start) as u32,
        total: total as u32,
        messages,
    })
}
