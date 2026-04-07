use crate::models::*;
use serde_json::Value;
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use walkdir::WalkDir;

pub fn claude_dir() -> std::path::PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join(".claude")
}

fn history_file() -> std::path::PathBuf {
    claude_dir().join("history.jsonl")
}

fn load_archive() -> std::collections::HashSet<String> {
    let path = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("archive.json");

    // Also check app data dir
    let app_data = dirs::data_dir()
        .unwrap_or_default()
        .join("com.cyocun.claude-session-manager");
    let alt_path = app_data.join("archive.json");

    for p in [&alt_path, &path] {
        if p.exists() {
            if let Ok(content) = std::fs::read_to_string(p) {
                if let Ok(ids) = serde_json::from_str::<Vec<String>>(&content) {
                    return ids.into_iter().collect();
                }
            }
        }
    }
    std::collections::HashSet::new()
}

pub fn archive_path() -> std::path::PathBuf {
    let app_data = dirs::data_dir()
        .unwrap_or_default()
        .join("com.cyocun.claude-session-manager");
    std::fs::create_dir_all(&app_data).ok();
    app_data.join("archive.json")
}

pub fn find_session_file(session_id: &str) -> Option<std::path::PathBuf> {
    let projects_dir = claude_dir().join("projects");
    let target = format!("{}.jsonl", session_id);
    for entry in WalkDir::new(&projects_dir).into_iter().filter_map(|e| e.ok()) {
        if entry.file_name().to_string_lossy() == target {
            return Some(entry.into_path());
        }
    }
    None
}

#[tauri::command]
pub fn list_sessions(include_archived: bool) -> Vec<SessionSummary> {
    let path = history_file();
    if !path.exists() {
        return vec![];
    }

    let file = match File::open(&path) {
        Ok(f) => f,
        Err(_) => return vec![],
    };

    let mut sessions: HashMap<String, SessionSummary> = HashMap::new();

    let mut parse_errors = 0;
    let mut total_lines = 0;
    for line in BufReader::new(file).lines().flatten() {
        total_lines += 1;
        let entry: HistoryEntry = match serde_json::from_str::<crate::models::RawHistoryEntry>(&line) {
            Ok(raw) => raw.into(),
            Err(e) => {
                if parse_errors == 0 {
                    eprintln!("JSONL parse error on line {}: {} | line: {}", total_lines, e, &line[..line.len().min(100)]);
                }
                parse_errors += 1;
                continue;
            }
        };

        if entry.session_id.is_empty() {
            continue;
        }

        sessions
            .entry(entry.session_id.clone())
            .and_modify(|s| {
                if entry.timestamp > s.last_timestamp {
                    s.last_timestamp = entry.timestamp;
                    if !entry.display.is_empty() {
                        s.last_display = entry.display.clone();
                    }
                }
                s.message_count += 1;
            })
            .or_insert(SessionSummary {
                session_id: entry.session_id,
                project: entry.project,
                first_display: entry.display.clone(),
                last_display: entry.display,
                first_timestamp: entry.timestamp,
                last_timestamp: entry.timestamp,
                message_count: 1,
                archived: false,
            });
    }

    let archived = load_archive();
    let mut results: Vec<SessionSummary> = sessions
        .into_values()
        .map(|mut s| {
            s.archived = archived.contains(&s.session_id);
            s
        })
        .filter(|s| include_archived || !s.archived)
        .collect();

    results.sort_by(|a, b| b.last_timestamp.cmp(&a.last_timestamp));
    results
}

fn extract_tool_info(block: &Value) -> Option<ToolInfo> {
    let btype = block.get("type")?.as_str()?;

    if btype == "tool_use" {
        let name = block.get("name").and_then(|v| v.as_str()).unwrap_or("unknown").to_string();
        let id = block.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let input = block.get("input");

        let mut info = ToolInfo {
            name: name.clone(),
            id,
            command: None, description: None, file: None,
            old: None, new: None, content: None,
            pattern: None, path: None, output: None, input: None,
        };

        match name.as_str() {
            "Bash" => {
                info.command = input.and_then(|i| i.get("command")).and_then(|v| v.as_str()).map(|s| s.to_string());
                info.description = input.and_then(|i| i.get("description")).and_then(|v| v.as_str()).map(|s| s.to_string());
            }
            "Edit" => {
                info.file = input.and_then(|i| i.get("file_path")).and_then(|v| v.as_str()).map(|s| s.to_string());
                info.old = input.and_then(|i| i.get("old_string")).and_then(|v| v.as_str()).map(|s| s.chars().take(500).collect());
                info.new = input.and_then(|i| i.get("new_string")).and_then(|v| v.as_str()).map(|s| s.chars().take(500).collect());
            }
            "Write" => {
                info.file = input.and_then(|i| i.get("file_path")).and_then(|v| v.as_str()).map(|s| s.to_string());
                info.content = input.and_then(|i| i.get("content")).and_then(|v| v.as_str()).map(|s| s.chars().take(500).collect());
            }
            "Read" => {
                info.file = input.and_then(|i| i.get("file_path")).and_then(|v| v.as_str()).map(|s| s.to_string());
            }
            "Glob" | "Grep" => {
                info.pattern = input.and_then(|i| i.get("pattern")).and_then(|v| v.as_str()).map(|s| s.to_string());
                info.path = input.and_then(|i| i.get("path")).and_then(|v| v.as_str()).map(|s| s.to_string());
            }
            _ => {
                if let Some(inp) = input {
                    info.input = Some(inp.clone());
                }
            }
        }
        Some(info)
    } else if btype == "tool_result" {
        let id = block.get("tool_use_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let result_content = block.get("content");
        let output = match result_content {
            Some(Value::String(s)) => s.chars().take(2000).collect(),
            Some(Value::Array(arr)) => {
                arr.iter()
                    .filter_map(|b| {
                        if let Some(t) = b.get("text").and_then(|v| v.as_str()) {
                            Some(t.to_string())
                        } else {
                            Some(b.to_string())
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
                    .chars()
                    .take(2000)
                    .collect()
            }
            _ => String::new(),
        };

        Some(ToolInfo {
            name: "_result".to_string(),
            id,
            output: Some(output),
            command: None, description: None, file: None,
            old: None, new: None, content: None,
            pattern: None, path: None, input: None,
        })
    } else {
        None
    }
}

fn extract_message(msg: &Value) -> Option<Message> {
    let msg_type = msg.get("type")?.as_str()?;
    if msg_type != "user" && msg_type != "assistant" {
        return None;
    }

    let message = msg.get("message")?;
    let content_val = message.get("content")?;
    let timestamp = msg.get("timestamp").cloned().unwrap_or(Value::Null);

    let mut text_parts: Vec<String> = Vec::new();
    let mut tools: Vec<ToolInfo> = Vec::new();

    match content_val {
        Value::String(s) => {
            text_parts.push(s.clone());
        }
        Value::Array(blocks) => {
            for block in blocks {
                match block {
                    Value::String(s) => text_parts.push(s.clone()),
                    Value::Object(_) => {
                        if let Some(btype) = block.get("type").and_then(|v| v.as_str()) {
                            if btype == "text" {
                                if let Some(t) = block.get("text").and_then(|v| v.as_str()) {
                                    text_parts.push(t.to_string());
                                }
                            } else if let Some(tool) = extract_tool_info(block) {
                                tools.push(tool);
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }

    let content: String = text_parts.join("\n").chars().take(2000).collect();

    Some(Message {
        msg_type: msg_type.to_string(),
        content,
        timestamp,
        tools: if tools.is_empty() { None } else { Some(tools) },
    })
}

#[tauri::command]
pub fn get_session_detail(session_id: String) -> Result<SessionDetail, String> {
    let path = history_file();
    if !path.exists() {
        return Err("History not found".to_string());
    }

    let file = File::open(&path).map_err(|e| e.to_string())?;
    let mut project_path = None;

    for line in BufReader::new(file).lines().flatten() {
        if let Ok(entry) = serde_json::from_str::<HistoryEntry>(&line) {
            if entry.session_id == session_id {
                project_path = Some(entry.project);
                break;
            }
        }
    }

    let project = project_path.ok_or("Session not found")?;

    let mut messages = Vec::new();
    if let Some(session_file) = find_session_file(&session_id) {
        if let Ok(f) = File::open(&session_file) {
            for line in BufReader::new(f).lines().flatten() {
                if let Ok(msg) = serde_json::from_str::<Value>(&line) {
                    if let Some(m) = extract_message(&msg) {
                        messages.push(m);
                    }
                }
            }
        }
    }

    Ok(SessionDetail {
        session_id,
        project,
        messages,
    })
}
