use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PastedContent {
    #[serde(default)]
    content: String,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RawHistoryEntry {
    #[serde(default)]
    display: String,
    #[serde(default)]
    timestamp: u64,
    #[serde(default)]
    project: String,
    #[serde(default, rename = "sessionId")]
    session_id: String,
    #[serde(default)]
    pasted_contents: HashMap<String, PastedContent>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    #[serde(default)]
    pub display: String,
    #[serde(default)]
    pub timestamp: u64,
    #[serde(default)]
    pub project: String,
    #[serde(default, rename = "sessionId")]
    pub session_id: String,
}

impl From<RawHistoryEntry> for HistoryEntry {
    fn from(raw: RawHistoryEntry) -> Self {
        let mut display = raw.display;
        if !raw.pasted_contents.is_empty() {
            for (id, pc) in &raw.pasted_contents {
                // Replace "[Pasted text #N ...]" with first line of content
                let placeholder_prefix = format!("[Pasted text #{}", id);
                if let Some(start) = display.find(&placeholder_prefix) {
                    if let Some(end) = display[start..].find(']') {
                        let first_line = pc.content.lines().next().unwrap_or("");
                        let preview: String = first_line.chars().take(80).collect();
                        display.replace_range(start..=start + end, &preview);
                    }
                }
            }
        }
        HistoryEntry {
            display,
            timestamp: raw.timestamp,
            project: raw.project,
            session_id: raw.session_id,
        }
    }
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub session_id: String,
    pub project: String,
    pub first_display: String,
    pub last_display: String,
    pub first_timestamp: u64,
    pub last_timestamp: u64,
    pub message_count: u32,
    pub archived: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionDetail {
    pub session_id: String,
    pub project: String,
    pub messages: Vec<Message>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    #[serde(rename = "type")]
    pub msg_type: String,
    pub content: String,
    pub timestamp: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<ToolInfo>>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ToolInfo {
    pub name: String,
    #[serde(default)]
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub session_count: u32,
    pub last_timestamp: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default = "default_terminal")]
    pub terminal_app: String,
}

fn default_terminal() -> String {
    "Terminal".to_string()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            terminal_app: default_terminal(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeResult {
    pub ok: bool,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeCommand {
    pub command: String,
    pub project: String,
    pub session_id: String,
}

#[derive(Debug, Serialize)]
pub struct SessionStatus {
    pub running: bool,
    pub pid: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub session_id: String,
    pub project: String,
    pub snippet: String,
    pub msg_type: String,
    pub timestamp: u64,
    pub message_index: u32,
    pub score: f32,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchIndexStatus {
    pub total_sessions: u32,
    pub indexed_sessions: u32,
    pub is_indexing: bool,
}
