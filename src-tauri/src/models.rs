use serde::{Deserialize, Serialize};
use std::collections::HashMap;

fn extract_tag_value(text: &str, tag: &str) -> Option<String> {
    let open = format!("<{}>", tag);
    let close = format!("</{}>", tag);
    let start = text.find(&open)? + open.len();
    let end = text[start..].find(&close)?;
    Some(text[start..start + end].to_string())
}

fn strip_tag_block(mut text: String, tag: &str) -> String {
    let open = format!("<{}>", tag);
    let close = format!("</{}>", tag);
    while let Some(start) = text.find(&open) {
        if let Some(end_rel) = text[start..].find(&close) {
            let end = start + end_rel + close.len();
            text.replace_range(start..end, "");
        } else {
            break;
        }
    }
    text
}

fn format_command_with_result(command: &str, stdout: &str, stderr: &str) -> String {
    let cmd = command.trim();
    let out = stdout.trim();
    let err = stderr.trim();
    if cmd.is_empty() {
        if !out.is_empty() && !err.is_empty() {
            return format!("{}\n\n[stderr]\n{}", out, err);
        }
        if !out.is_empty() {
            return out.to_string();
        }
        if !err.is_empty() {
            return format!("[stderr]\n{}", err);
        }
        return String::new();
    }

    let mut parts = vec![format!("$ {}", cmd)];
    if !out.is_empty() {
        parts.push(out.to_string());
    }
    if !err.is_empty() {
        parts.push(format!("[stderr]\n{}", err));
    }
    parts.join("\n\n")
}

pub fn normalize_message_text(raw: &str) -> String {
    let text = raw.trim();
    if text.is_empty() {
        return String::new();
    }

    let bash_input = extract_tag_value(text, "bash-input")
        .unwrap_or_default()
        .trim()
        .to_string();
    let bash_stdout = extract_tag_value(text, "bash-stdout")
        .unwrap_or_default()
        .trim()
        .to_string();
    let bash_stderr = extract_tag_value(text, "bash-stderr")
        .unwrap_or_default()
        .trim()
        .to_string();
    if !bash_input.is_empty() || !bash_stdout.is_empty() || !bash_stderr.is_empty() {
        let formatted = format_command_with_result(&bash_input, &bash_stdout, &bash_stderr);
        if !formatted.is_empty() {
            return formatted;
        }
    }

    let has_local_command_tags = text.contains("<command-name>")
        || text.contains("<command-message>")
        || text.contains("<command-args>")
        || text.contains("<local-command-caveat>");

    if has_local_command_tags {
        let command_name = extract_tag_value(text, "command-name")
            .unwrap_or_default()
            .trim()
            .to_string();
        let command_message = extract_tag_value(text, "command-message")
            .unwrap_or_default()
            .trim()
            .to_string();
        let command_args = extract_tag_value(text, "command-args")
            .unwrap_or_default()
            .trim()
            .to_string();

        let mut command = if !command_name.is_empty() {
            command_name.clone()
        } else {
            command_message.clone()
        };

        if command.is_empty() {
            command = command_message.clone();
        }
        if command.is_empty() {
            command = command_name.clone();
        }

        if !command.starts_with('/') && !command.starts_with('!') {
            if command_message.starts_with('/') || command_message.starts_with('!') {
                command = command_message.clone();
            } else if command_name.starts_with('/') || command_name.starts_with('!') {
                command = command_name.clone();
            } else if !command.is_empty() {
                command = format!("/{}", command);
            }
        }

        if !command_args.is_empty() {
            if command.is_empty() {
                command = command_args;
            } else {
                command.push(' ');
                command.push_str(&command_args);
            }
        }

        if !command.is_empty() {
            return command;
        }

        let mut cleaned = text.to_string();
        for tag in [
            "local-command-caveat",
            "command-name",
            "command-message",
            "command-args",
            "bash-input",
            "bash-stdout",
            "bash-stderr",
            "current_datetime",
            "reminder",
            "sql_tables",
        ] {
            cleaned = strip_tag_block(cleaned, tag);
        }
        return cleaned.trim().to_string();
    }

    // Always strip system tags that Claude Code injects into user messages
    let mut cleaned = text.to_string();
    for tag in [
        "local-command-caveat",
        "command-name",
        "command-message",
        "command-args",
        "bash-input",
        "bash-stdout",
        "bash-stderr",
        "current_datetime",
        "reminder",
        "sql_tables",
        "system-reminder",
        "antml_thinking",
    ] {
        cleaned = strip_tag_block(cleaned, tag);
    }
    cleaned.trim().to_string()
}

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
        display = normalize_message_text(&display);
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub images: Option<Vec<ImageBlock>>,
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
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImageBlock {
    pub media_type: String,
    pub data: String,
    pub source_type: String,
}

pub struct ProjectInfo {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub session_count: u32,
    pub last_timestamp: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_session_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub project: String,
    pub session_count: u32,
    pub generated_at: u64,
    pub summary: String,
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

#[derive(Debug, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct TokenTotals {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_input_tokens: u64,
    pub cache_read_input_tokens: u64,
    pub total_tokens: u64,
    pub estimated_cost_usd: f64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TokenProjectRow {
    pub project: String,
    pub session_count: u32,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_input_tokens: u64,
    pub cache_read_input_tokens: u64,
    pub total_tokens: u64,
    pub estimated_cost_usd: f64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TokenTimePoint {
    pub label: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
    pub estimated_cost_usd: f64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TokenSessionRow {
    pub session_id: String,
    pub project: String,
    pub last_timestamp: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_input_tokens: u64,
    pub cache_read_input_tokens: u64,
    pub total_tokens: u64,
    pub estimated_cost_usd: f64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TokenDashboard {
    pub totals: TokenTotals,
    pub by_hour: Vec<TokenTimePoint>,
    pub by_project: Vec<TokenProjectRow>,
    pub by_day: Vec<TokenTimePoint>,
    pub by_week: Vec<TokenTimePoint>,
    pub by_month: Vec<TokenTimePoint>,
    pub by_session: Vec<TokenSessionRow>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDecisionItem {
    pub project: String,
    pub session_id: String,
    pub timestamp: u64,
    pub kind: String,
    pub text: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDecisionHistory {
    pub project: String,
    pub items: Vec<ProjectDecisionItem>,
}
