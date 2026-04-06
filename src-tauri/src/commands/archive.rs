use crate::commands::sessions::archive_path;
use std::collections::HashSet;

fn load_archive() -> HashSet<String> {
    let path = archive_path();
    if path.exists() {
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(ids) = serde_json::from_str::<Vec<String>>(&content) {
                return ids.into_iter().collect();
            }
        }
    }
    HashSet::new()
}

fn save_archive(archived: &HashSet<String>) {
    let path = archive_path();
    let mut sorted: Vec<&String> = archived.iter().collect();
    sorted.sort();
    if let Ok(json) = serde_json::to_string(&sorted) {
        std::fs::write(path, json).ok();
    }
}

#[tauri::command]
pub fn archive_sessions(session_ids: Vec<String>, archive: bool) -> serde_json::Value {
    let mut archived = load_archive();
    if archive {
        for id in &session_ids {
            archived.insert(id.clone());
        }
    } else {
        for id in &session_ids {
            archived.remove(id);
        }
    }
    save_archive(&archived);
    serde_json::json!({ "ok": true, "archivedCount": archived.len() })
}
