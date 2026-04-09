use csm_core::search::SearchIndex;
use csm_core::sessions;
use serde::Serialize;
use std::sync::Arc;

#[derive(Clone)]
struct SessionSearchServer {
    index: Arc<SearchIndex>,
}

// --- Simplified output types for MCP (plain text, no HTML) ---

#[derive(Debug, Serialize)]
struct SearchResult {
    session_id: String,
    project: String,
    snippet: String,
    msg_type: String,
    message_index: u32,
    score: f32,
}

#[derive(Debug, Serialize)]
struct SessionInfo {
    session_id: String,
    project: String,
    first_display: String,
    last_display: String,
    message_count: u32,
}

#[derive(Debug, Serialize)]
struct MessageInfo {
    index: usize,
    msg_type: String,
    content: String,
}

#[rmcp::tool(tool_box)]
impl SessionSearchServer {
    /// Search across all past Claude Code sessions by keyword.
    /// Use this to find if a similar error, problem, or topic was encountered before.
    /// Returns matching messages with context snippets.
    #[tool(description = "Search across all past Claude Code sessions by keyword. Use to find similar errors, problems, or solutions from previous sessions.")]
    fn search_sessions(
        &self,
        #[tool(param, description = "Search query keywords")] query: String,
        #[tool(param, description = "Filter by project path (optional)")] project: Option<String>,
        #[tool(param, description = "Max results, default 20")] limit: Option<usize>,
    ) -> String {
        let limit = limit.unwrap_or(20);
        match self.index.search(&query, project.as_deref(), limit) {
            Ok(hits) => {
                let results: Vec<SearchResult> = hits
                    .into_iter()
                    .map(|h| {
                        // Strip HTML tags from snippet (Tantivy generates <b> tags)
                        let snippet = h
                            .snippet
                            .replace("<b>", "")
                            .replace("</b>", "");
                        SearchResult {
                            session_id: h.session_id,
                            project: h.project,
                            snippet,
                            msg_type: h.msg_type,
                            message_index: h.message_index,
                            score: h.score,
                        }
                    })
                    .collect();
                serde_json::to_string_pretty(&results).unwrap_or_default()
            }
            Err(e) => format!("Search error: {}", e),
        }
    }

    /// Get messages from a specific session. Use after search_sessions to see
    /// the full context around a search hit.
    #[tool(description = "Get messages from a specific session. Use after search_sessions to read full context around a match.")]
    fn get_session_messages(
        &self,
        #[tool(param, description = "Session ID to retrieve")] session_id: String,
        #[tool(param, description = "Message index to center the window on")] around_index: Option<usize>,
        #[tool(param, description = "Number of messages to return, default 10")] window: Option<usize>,
    ) -> String {
        match sessions::get_session_detail(&session_id) {
            Ok(detail) => {
                let w = window.unwrap_or(10);
                let (start, end) = if let Some(center) = around_index {
                    let s = center.saturating_sub(w / 2);
                    let e = (center + w / 2 + 1).min(detail.messages.len());
                    (s, e)
                } else {
                    let s = detail.messages.len().saturating_sub(w);
                    (s, detail.messages.len())
                };

                let messages: Vec<MessageInfo> = detail.messages[start..end]
                    .iter()
                    .enumerate()
                    .map(|(i, m)| MessageInfo {
                        index: start + i,
                        msg_type: m.msg_type.clone(),
                        content: m.content.clone(),
                    })
                    .collect();

                let header = format!(
                    "Session: {} | Project: {} | Messages {}-{} of {}",
                    detail.session_id,
                    detail.project,
                    start,
                    end,
                    detail.messages.len()
                );
                format!("{}\n\n{}", header, serde_json::to_string_pretty(&messages).unwrap_or_default())
            }
            Err(e) => format!("Error: {}", e),
        }
    }

    /// List recent Claude Code sessions with metadata.
    #[tool(description = "List recent Claude Code sessions. Use to browse available sessions or find a specific project's sessions.")]
    fn list_sessions(
        &self,
        #[tool(param, description = "Filter by project path substring")] project: Option<String>,
        #[tool(param, description = "Max results, default 20")] limit: Option<usize>,
    ) -> String {
        let all = sessions::list_sessions(false);
        let filtered: Vec<SessionInfo> = all
            .into_iter()
            .filter(|s| {
                project
                    .as_ref()
                    .map_or(true, |p| s.project.contains(p))
            })
            .take(limit.unwrap_or(20))
            .map(|s| SessionInfo {
                session_id: s.session_id,
                project: s.project,
                first_display: s.first_display,
                last_display: s.last_display,
                message_count: s.message_count,
            })
            .collect();
        serde_json::to_string_pretty(&filtered).unwrap_or_default()
    }
}

#[rmcp::handler]
impl rmcp::ServerHandler for SessionSearchServer {
    fn get_info(&self) -> rmcp::model::ServerInfo {
        rmcp::model::ServerInfo {
            instructions: Some("Claude Code session search server. Search across past sessions to find similar errors, solutions, and discussions.".into()),
            ..Default::default()
        }
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Redirect logging to stderr (MCP protocol uses stdout)
    eprintln!("csm-mcp: starting session search MCP server");

    // Open Tantivy index (same location as Tauri app)
    let index_dir = dirs::data_dir()
        .unwrap_or_default()
        .join("com.cyocun.claude-session-manager")
        .join("search-index");

    let search_index = Arc::new(SearchIndex::new(index_dir)?);

    // Build/update index on startup
    eprintln!("csm-mcp: building search index...");
    search_index.build_full_index()?;
    eprintln!("csm-mcp: search index ready");

    let server = SessionSearchServer {
        index: search_index,
    };

    let service = server
        .serve(tokio::io::stdin(), tokio::io::stdout())
        .await?;
    service.waiting().await?;

    Ok(())
}
