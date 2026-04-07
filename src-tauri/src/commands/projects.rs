use crate::models::*;
use chrono::Datelike;
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Listener};

fn claude_dir() -> std::path::PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join(".claude")
}

fn resolve_project_name(project_path: &str) -> Option<String> {
    let canonical = std::fs::canonicalize(project_path).ok()?;
    if !canonical.is_dir() {
        return None;
    }
    let p = canonical.as_path();

    // 1. package.json
    let pkg = p.join("package.json");
    if pkg.exists() {
        if let Ok(content) = std::fs::read_to_string(&pkg) {
            if let Ok(data) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(name) = data.get("name").and_then(|v| v.as_str()) {
                    if !name.is_empty() && name != "undefined" {
                        return Some(name.to_string());
                    }
                }
            }
        }
    }

    // 2. git remote origin
    let canonical_str = canonical.to_string_lossy().to_string();
    if let Ok(output) = Command::new("git")
        .args(["-C", &canonical_str, "remote", "get-url", "origin"])
        .output()
    {
        let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !url.is_empty() {
            let cleaned = url.trim_end_matches('/').trim_end_matches(".git");
            let parts: Vec<&str> = cleaned.split('/').collect();
            if parts.len() >= 2 {
                let repo = parts[parts.len() - 1];
                let mut owner = parts[parts.len() - 2].to_string();
                if let Some(pos) = owner.rfind(':') {
                    owner = owner[pos + 1..].to_string();
                }
                return Some(format!("{}/{}", owner, repo));
            }
        }
    }

    // 3. pyproject.toml
    let pyproj = p.join("pyproject.toml");
    if pyproj.exists() {
        if let Ok(content) = std::fs::read_to_string(&pyproj) {
            for line in content.lines() {
                let trimmed = line.trim();
                if trimmed.starts_with("name") {
                    if let Some(val) = trimmed.split('=').nth(1) {
                        let name = val.trim().trim_matches('"').trim_matches('\'').to_string();
                        if !name.is_empty() {
                            return Some(name);
                        }
                    }
                }
            }
        }
    }

    None
}

#[tauri::command]
pub fn list_projects() -> Vec<ProjectInfo> {
    let path = claude_dir().join("history.jsonl");
    if !path.exists() {
        return vec![];
    }

    let file = match File::open(&path) {
        Ok(f) => f,
        Err(_) => return vec![],
    };

    let mut projects: HashMap<String, ProjectInfo> = HashMap::new();

    for line in BufReader::new(file).lines().flatten() {
        let entry: HistoryEntry = match serde_json::from_str(&line) {
            Ok(e) => e,
            Err(_) => continue,
        };

        let proj = entry.project.clone();
        let sid = entry.session_id.clone();
        projects
            .entry(proj.clone())
            .and_modify(|p| {
                p.session_count += 1;
                if entry.timestamp > p.last_timestamp {
                    p.last_timestamp = entry.timestamp;
                    p.last_session_id = Some(sid.clone());
                }
            })
            .or_insert_with(|| ProjectInfo {
                path: proj.clone(),
                name: resolve_project_name(&proj),
                session_count: 1,
                last_timestamp: entry.timestamp,
                last_session_id: Some(sid),
            });
    }

    let mut results: Vec<ProjectInfo> = projects.into_values().collect();
    results.sort_by(|a, b| b.last_timestamp.cmp(&a.last_timestamp));
    results
}

#[tauri::command]
pub fn get_project_icon(project: String) -> Result<Option<String>, String> {
    let base = std::path::Path::new(&project);
    if !base.is_dir() {
        return Ok(None);
    }

    let candidates = [
        "favicon.ico",
        "favicon.png",
        "favicon.svg",
        "public/favicon.ico",
        "public/favicon.png",
        "public/favicon.svg",
        "assets/icon.png",
        "assets/icon.svg",
        "src-tauri/icons/icon.png",
    ];

    for candidate in &candidates {
        let path = base.join(candidate);
        if path.is_file() {
            if let Ok(bytes) = std::fs::read(&path) {
                // Skip files larger than 256KB
                if bytes.len() > 256 * 1024 {
                    continue;
                }
                let mime = match path.extension().and_then(|e| e.to_str()) {
                    Some("ico") => "image/x-icon",
                    Some("png") => "image/png",
                    Some("svg") => "image/svg+xml",
                    Some("jpg") | Some("jpeg") => "image/jpeg",
                    _ => "image/png",
                };
                use base64::Engine;
                let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                return Ok(Some(format!("data:{};base64,{}", mime, b64)));
            }
        }
    }

    Ok(None)
}

fn read_project_readme(project: &str) -> Option<String> {
    let base = std::path::Path::new(project);
    if !base.is_dir() {
        return None;
    }
    let candidates = ["README.md", "readme.md", "Readme.md", "README.markdown", "README.txt", "README"];
    for name in &candidates {
        let path = base.join(name);
        if path.is_file() {
            if let Ok(meta) = std::fs::metadata(&path) {
                if meta.len() > 512 * 1024 {
                    return None;
                }
            }
            return std::fs::read_to_string(&path).ok();
        }
    }
    None
}

#[tauri::command]
pub fn get_project_readme(project: String) -> Result<Option<String>, String> {
    Ok(read_project_readme(&project))
}

#[tauri::command]
pub fn get_project_readme_by_path(path: String) -> Result<Option<String>, String> {
    let p = std::path::Path::new(&path);
    if !p.is_file() {
        return Ok(None);
    }
    if let Ok(meta) = std::fs::metadata(p) {
        if meta.len() > 512 * 1024 {
            return Ok(None);
        }
    }
    // Resolve images relative to the file's parent directory
    let content = std::fs::read_to_string(p).map_err(|e| e.to_string())?;
    let parent = p.parent().map(|d| d.to_string_lossy().to_string()).unwrap_or_default();
    Ok(Some(resolve_readme_images(&content, &parent)))
}

static README_COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// Resolve image paths in markdown to data URIs.
/// - Relative paths (./img.png, docs/img.png) → base64 data URI
/// - localhost URLs (http://127.0.0.1:*/path, http://localhost:*/path) → base64 data URI
/// - Absolute http(s) URLs → left as-is
fn resolve_readme_images(content: &str, project_path: &str) -> String {
    let base = std::path::Path::new(project_path);

    let resolve_to_local = |src: &str| -> Option<std::path::PathBuf> {
        let trimmed = src.trim();
        // localhost URLs → extract path
        if let Some(path) = trimmed
            .strip_prefix("http://127.0.0.1")
            .or_else(|| trimmed.strip_prefix("http://localhost"))
        {
            if let Some(pos) = path.find('/') {
                let local = &path[pos..];
                let abs = base.join(local.trim_start_matches('/'));
                if abs.is_file() {
                    return Some(abs);
                }
            }
            return None;
        }
        // External URL → skip
        if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
            return None;
        }
        // Relative path
        let cleaned = trimmed.trim_start_matches("./");
        let abs = base.join(cleaned);
        if abs.is_file() { Some(abs) } else { None }
    };

    let to_data_uri = |path: &std::path::Path| -> Option<String> {
        let bytes = std::fs::read(path).ok()?;
        if bytes.len() > 2 * 1024 * 1024 { return None; } // Skip > 2MB
        let mime = match path.extension().and_then(|e| e.to_str()) {
            Some("png") => "image/png",
            Some("jpg") | Some("jpeg") => "image/jpeg",
            Some("gif") => "image/gif",
            Some("svg") => "image/svg+xml",
            Some("webp") => "image/webp",
            Some("ico") => "image/x-icon",
            _ => "application/octet-stream",
        };
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        Some(format!("data:{};base64,{}", mime, b64))
    };

    // Match markdown image syntax: ![alt](src)
    let re_md = regex::Regex::new(r"!\[([^\]]*)\]\(([^)]+)\)").unwrap();
    // Match HTML img tags: <img ... src="..." ...>
    let re_html = regex::Regex::new(r#"(<img\s[^>]*?\bsrc\s*=\s*")([^"]+)(")"#).unwrap();

    let result = re_md.replace_all(content, |caps: &regex::Captures| {
        let alt = &caps[1];
        let src = &caps[2];
        if let Some(path) = resolve_to_local(src) {
            if let Some(data_uri) = to_data_uri(&path) {
                return format!("![{}]({})", alt, data_uri);
            }
        }
        caps[0].to_string()
    });
    let result = re_html.replace_all(&result, |caps: &regex::Captures| {
        let src = &caps[2];
        if let Some(path) = resolve_to_local(src) {
            if let Some(data_uri) = to_data_uri(&path) {
                return format!("{}{}{}", &caps[1], data_uri, &caps[3]);
            }
        }
        caps[0].to_string()
    });
    result.into_owned()
}

#[tauri::command]
pub fn open_readme_window(app: tauri::AppHandle, project: String, name: String) -> Result<(), String> {
    let raw = read_project_readme(&project).ok_or("README not found")?;
    let content = resolve_readme_images(&raw, &project);
    let label = format!("readme-{}", README_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
    let title = format!("{} — README", name);

    let win = tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App("readme.html".into()))
        .title(&title)
        .inner_size(800.0, 700.0)
        .center()
        .build()
        .map_err(|e| e.to_string())?;

    let payload = serde_json::json!({ "content": content, "projectPath": project });
    let win2 = win.clone();
    win.once("readme-ready", move |_| {
        let _ = win2.emit("load-readme", &payload);
    });

    Ok(())
}

fn now_ts() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn app_data_dir() -> std::path::PathBuf {
    dirs::data_dir()
        .unwrap_or_default()
        .join("com.cyocun.claude-session-manager")
}

fn summary_cache_path() -> std::path::PathBuf {
    app_data_dir().join("project-summaries.json")
}

fn load_summary_cache() -> HashMap<String, ProjectSummary> {
    let path = summary_cache_path();
    if let Ok(content) = std::fs::read_to_string(path) {
        if let Ok(map) = serde_json::from_str::<HashMap<String, ProjectSummary>>(&content) {
            return map;
        }
    }
    HashMap::new()
}

fn save_summary_cache(cache: &HashMap<String, ProjectSummary>) -> Result<(), String> {
    let dir = app_data_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = summary_cache_path();
    let json = serde_json::to_string(cache).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

fn collect_project_session_context(project: &str) -> Result<(u32, String), String> {
    let history_path = claude_dir().join("history.jsonl");
    if !history_path.exists() {
        return Err("History not found".to_string());
    }
    let file = File::open(&history_path).map_err(|e| e.to_string())?;

    let mut sessions: HashMap<String, (u64, String, String)> = HashMap::new();
    for line in BufReader::new(file).lines().flatten() {
        let entry: HistoryEntry = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if entry.project != project || entry.session_id.is_empty() {
            continue;
        }
        sessions
            .entry(entry.session_id.clone())
            .and_modify(|(ts, _first, last)| {
                if entry.timestamp >= *ts {
                    *ts = entry.timestamp;
                    *last = entry.display.clone();
                }
            })
            .or_insert((entry.timestamp, entry.display.clone(), entry.display));
    }
    if sessions.is_empty() {
        return Err("No sessions found for project".to_string());
    }

    let mut rows: Vec<(String, u64, String, String)> = sessions
        .into_iter()
        .map(|(id, (ts, first, last))| (id, ts, first, last))
        .collect();
    rows.sort_by(|a, b| b.1.cmp(&a.1));

    let mut context = String::new();
    context.push_str(&format!("Project: {}\n", project));
    context.push_str(&format!("Session count: {}\n\n", rows.len()));
    context.push_str("Recent sessions:\n");
    for (idx, (sid, ts, first, last)) in rows.iter().take(120).enumerate() {
        context.push_str(&format!(
            "{}. session_id={} timestamp={} first={} last={}\n",
            idx + 1,
            sid,
            ts,
            first.replace('\n', " ").chars().take(220).collect::<String>(),
            last.replace('\n', " ").chars().take(220).collect::<String>()
        ));
    }
    Ok((rows.len() as u32, context))
}

#[tauri::command]
pub fn get_project_summary(project: String) -> Result<Option<ProjectSummary>, String> {
    let cache = load_summary_cache();
    Ok(cache.get(project.trim()).cloned())
}

#[tauri::command]
pub async fn generate_project_summary(project: String) -> Result<ProjectSummary, String> {
    tauri::async_runtime::spawn_blocking(move || compute_project_summary(project))
        .await
        .map_err(|e| e.to_string())?
}

fn compute_project_summary(project: String) -> Result<ProjectSummary, String> {
    let project = project.trim().to_string();
    if project.is_empty() {
        return Err("Project path is empty".to_string());
    }

    let (session_count, context) = collect_project_session_context(&project)?;
    let prompt = format!(
        "You are summarizing Claude Code sessions for one software project.\n\
Return plain Japanese text with these sections:\n\
1) 概要\n2) 最近の主要トピック\n3) 意思決定・方針\n4) 未解決課題\n5) 次にやると良いこと\n\
Keep it concise and factual. If data is insufficient, say so.\n\n{}",
        context
    );

    let output = Command::new("claude")
        .arg("-p")
        .arg("--output-format")
        .arg("text")
        .arg(prompt)
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(if err.trim().is_empty() {
            "Failed to run claude for summary".to_string()
        } else {
            err
        });
    }

    let summary = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if summary.is_empty() {
        return Err("Empty summary output".to_string());
    }

    let item = ProjectSummary {
        project: project.clone(),
        session_count,
        generated_at: now_ts(),
        summary,
    };

    let mut cache = load_summary_cache();
    cache.insert(project, item.clone());
    save_summary_cache(&cache)?;
    Ok(item)
}

fn parse_timestamp_millis(v: &serde_json::Value) -> u64 {
    if let Some(ms) = v.as_u64() {
        return ms;
    }
    if let Some(s) = v.as_str() {
        if let Ok(ms) = s.parse::<u64>() {
            return ms;
        }
        if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
            return dt.timestamp_millis().max(0) as u64;
        }
    }
    0
}

fn week_label(ts_millis: u64) -> String {
    let dt = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ts_millis as i64)
        .unwrap_or(chrono::DateTime::<chrono::Utc>::UNIX_EPOCH);
    let iso = dt.iso_week();
    format!("{}-W{:02}", iso.year(), iso.week())
}

fn day_label(ts_millis: u64) -> String {
    let dt = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ts_millis as i64)
        .unwrap_or(chrono::DateTime::<chrono::Utc>::UNIX_EPOCH);
    dt.format("%Y-%m-%d").to_string()
}

fn hour_label(ts_millis: u64) -> String {
    let dt = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ts_millis as i64)
        .unwrap_or(chrono::DateTime::<chrono::Utc>::UNIX_EPOCH);
    dt.format("%Y-%m-%d %H:00").to_string()
}

fn month_label(ts_millis: u64) -> String {
    let dt = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ts_millis as i64)
        .unwrap_or(chrono::DateTime::<chrono::Utc>::UNIX_EPOCH);
    dt.format("%Y-%m").to_string()
}

fn estimate_cost_usd(input: u64, output: u64, cache_creation: u64, cache_read: u64) -> f64 {
    // Approximation for Sonnet-like pricing (per 1M tokens).
    let input_rate = 3.0 / 1_000_000.0;
    let output_rate = 15.0 / 1_000_000.0;
    let cache_create_rate = 3.75 / 1_000_000.0;
    let cache_read_rate = 0.30 / 1_000_000.0;
    (input as f64 * input_rate)
        + (output as f64 * output_rate)
        + (cache_creation as f64 * cache_create_rate)
        + (cache_read as f64 * cache_read_rate)
}

fn accumulate_time_point(
    map: &mut HashMap<String, TokenTimePoint>,
    label: String,
    input: u64,
    output: u64,
    total: u64,
    cost: f64,
) {
    let entry = map.entry(label.clone()).or_insert(TokenTimePoint {
        label,
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        estimated_cost_usd: 0.0,
    });
    entry.input_tokens += input;
    entry.output_tokens += output;
    entry.total_tokens += total;
    entry.estimated_cost_usd += cost;
}

fn classify_decision_kind(text: &str) -> Option<&'static str> {
    let s = text.to_lowercase();
    if s.contains("方針") || s.contains("方針として") || s.contains("policy") || s.contains("decision") {
        return Some("policy");
    }
    if s.contains("採用") || s.contains("adopt") || s.contains("use ") || s.contains("使う") {
        return Some("adopt");
    }
    if s.contains("却下") || s.contains("見送り") || s.contains("やめる") || s.contains("reject") {
        return Some("reject");
    }
    if s.contains("優先") || s.contains("先に") || s.contains("later") || s.contains("後で") {
        return Some("priority");
    }
    None
}

fn extract_message_text(v: &serde_json::Value) -> String {
    let content = v
        .get("message")
        .and_then(|m| m.get("content"))
        .unwrap_or(&serde_json::Value::Null);
    match content {
        serde_json::Value::String(s) => normalize_message_text(s),
        serde_json::Value::Array(arr) => {
            let mut out = String::new();
            for block in arr {
                if let Some(t) = block.as_str() {
                    if !out.is_empty() {
                        out.push('\n');
                    }
                    out.push_str(t);
                } else if block.get("type").and_then(|x| x.as_str()) == Some("text") {
                    if let Some(t) = block.get("text").and_then(|x| x.as_str()) {
                        if !out.is_empty() {
                            out.push('\n');
                        }
                        out.push_str(&normalize_message_text(t));
                    }
                }
            }
            out.trim().to_string()
        }
        _ => String::new(),
    }
}

fn compute_token_dashboard() -> Result<TokenDashboard, String> {
    let projects_dir = claude_dir().join("projects");
    if !projects_dir.exists() {
        return Ok(TokenDashboard {
            totals: TokenTotals::default(),
            by_hour: vec![],
            by_project: vec![],
            by_day: vec![],
            by_week: vec![],
            by_month: vec![],
            by_session: vec![],
        });
    }

    let mut by_project: HashMap<String, TokenProjectRow> = HashMap::new();
    let mut by_hour: HashMap<String, TokenTimePoint> = HashMap::new();
    let mut by_day: HashMap<String, TokenTimePoint> = HashMap::new();
    let mut by_week: HashMap<String, TokenTimePoint> = HashMap::new();
    let mut by_month: HashMap<String, TokenTimePoint> = HashMap::new();
    let mut by_session: HashMap<String, TokenSessionRow> = HashMap::new();
    let mut totals = TokenTotals::default();

    for entry in walkdir::WalkDir::new(&projects_dir).into_iter().filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }
        if entry.path().extension().and_then(|x| x.to_str()) != Some("jsonl") {
            continue;
        }
        let Ok(file) = File::open(entry.path()) else { continue };
        for line in BufReader::new(file).lines().flatten() {
            let v: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let session_id = v.get("sessionId").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let project = v.get("cwd").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let ts = v.get("timestamp").map(parse_timestamp_millis).unwrap_or(0);
            let usage = v
                .get("message")
                .and_then(|m| m.get("usage"))
                .or_else(|| v.get("usage"));
            let Some(usage) = usage else { continue; };

            let input = usage.get("input_tokens").and_then(|x| x.as_u64()).unwrap_or(0);
            let output = usage.get("output_tokens").and_then(|x| x.as_u64()).unwrap_or(0);
            let cache_creation = usage.get("cache_creation_input_tokens").and_then(|x| x.as_u64()).unwrap_or(0);
            let cache_read = usage.get("cache_read_input_tokens").and_then(|x| x.as_u64()).unwrap_or(0);
            if input == 0 && output == 0 && cache_creation == 0 && cache_read == 0 {
                continue;
            }

            let total = input + output + cache_creation + cache_read;
            let cost = estimate_cost_usd(input, output, cache_creation, cache_read);

            totals.input_tokens += input;
            totals.output_tokens += output;
            totals.cache_creation_input_tokens += cache_creation;
            totals.cache_read_input_tokens += cache_read;
            totals.total_tokens += total;
            totals.estimated_cost_usd += cost;

            let proj_entry = by_project.entry(project.clone()).or_insert(TokenProjectRow {
                project: project.clone(),
                session_count: 0,
                input_tokens: 0,
                output_tokens: 0,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
                total_tokens: 0,
                estimated_cost_usd: 0.0,
            });
            proj_entry.input_tokens += input;
            proj_entry.output_tokens += output;
            proj_entry.cache_creation_input_tokens += cache_creation;
            proj_entry.cache_read_input_tokens += cache_read;
            proj_entry.total_tokens += total;
            proj_entry.estimated_cost_usd += cost;

            accumulate_time_point(&mut by_hour, hour_label(ts), input, output, total, cost);
            accumulate_time_point(&mut by_day, day_label(ts), input, output, total, cost);
            accumulate_time_point(&mut by_week, week_label(ts), input, output, total, cost);
            accumulate_time_point(&mut by_month, month_label(ts), input, output, total, cost);

            if !session_id.is_empty() {
                let sess_entry = by_session.entry(session_id.clone()).or_insert(TokenSessionRow {
                    session_id,
                    project: project.clone(),
                    last_timestamp: ts,
                    input_tokens: 0,
                    output_tokens: 0,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                    total_tokens: 0,
                    estimated_cost_usd: 0.0,
                });
                sess_entry.project = project.clone();
                if ts > sess_entry.last_timestamp {
                    sess_entry.last_timestamp = ts;
                }
                sess_entry.input_tokens += input;
                sess_entry.output_tokens += output;
                sess_entry.cache_creation_input_tokens += cache_creation;
                sess_entry.cache_read_input_tokens += cache_read;
                sess_entry.total_tokens += total;
                sess_entry.estimated_cost_usd += cost;
            }
        }
    }

    // Distinct session counts by project from by_session map.
    let mut project_session_counts: HashMap<String, u32> = HashMap::new();
    for s in by_session.values() {
        *project_session_counts.entry(s.project.clone()).or_insert(0) += 1;
    }
    for p in by_project.values_mut() {
        p.session_count = *project_session_counts.get(&p.project).unwrap_or(&0);
    }

    let mut by_project_vec: Vec<TokenProjectRow> = by_project.into_values().collect();
    by_project_vec.sort_by(|a, b| b.total_tokens.cmp(&a.total_tokens));

    let mut by_hour_vec: Vec<TokenTimePoint> = by_hour.into_values().collect();
    by_hour_vec.sort_by(|a, b| a.label.cmp(&b.label));

    let mut by_day_vec: Vec<TokenTimePoint> = by_day.into_values().collect();
    by_day_vec.sort_by(|a, b| a.label.cmp(&b.label));

    let mut by_week_vec: Vec<TokenTimePoint> = by_week.into_values().collect();
    by_week_vec.sort_by(|a, b| a.label.cmp(&b.label));

    let mut by_month_vec: Vec<TokenTimePoint> = by_month.into_values().collect();
    by_month_vec.sort_by(|a, b| a.label.cmp(&b.label));

    let mut by_session_vec: Vec<TokenSessionRow> = by_session.into_values().collect();
    by_session_vec.sort_by(|a, b| b.last_timestamp.cmp(&a.last_timestamp));
    by_session_vec.truncate(200);

    Ok(TokenDashboard {
        totals,
        by_hour: by_hour_vec,
        by_project: by_project_vec,
        by_day: by_day_vec,
        by_week: by_week_vec,
        by_month: by_month_vec,
        by_session: by_session_vec,
    })
}

static TOKEN_CACHE: OnceLock<Mutex<Option<(u64, TokenDashboard)>>> = OnceLock::new();
const TOKEN_CACHE_TTL_SECS: u64 = 30;

#[tauri::command]
pub async fn get_token_dashboard() -> Result<TokenDashboard, String> {
    let cache = TOKEN_CACHE.get_or_init(|| Mutex::new(None));
    let now = now_ts();
    if let Ok(guard) = cache.lock() {
        if let Some((ts, data)) = &*guard {
            if now.saturating_sub(*ts) <= TOKEN_CACHE_TTL_SECS {
                return Ok(data.clone());
            }
        }
    }

    let computed = tauri::async_runtime::spawn_blocking(compute_token_dashboard)
        .await
        .map_err(|e| e.to_string())??;

    if let Ok(mut guard) = cache.lock() {
        *guard = Some((now, computed.clone()));
    }
    Ok(computed)
}

#[tauri::command]
pub fn get_project_decision_history(project: String) -> Result<ProjectDecisionHistory, String> {
    let project = project.trim().to_string();
    if project.is_empty() {
        return Ok(ProjectDecisionHistory {
            project,
            items: vec![],
        });
    }

    let history_path = claude_dir().join("history.jsonl");
    if !history_path.exists() {
        return Ok(ProjectDecisionHistory {
            project,
            items: vec![],
        });
    }
    let file = File::open(&history_path).map_err(|e| e.to_string())?;
    let mut session_ids: HashMap<String, bool> = HashMap::new();
    for line in BufReader::new(file).lines().flatten() {
        let v: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if v.get("project").and_then(|x| x.as_str()) != Some(project.as_str()) {
            continue;
        }
        if let Some(sid) = v.get("sessionId").and_then(|x| x.as_str()) {
            session_ids.insert(sid.to_string(), true);
        }
    }

    let mut items: Vec<ProjectDecisionItem> = Vec::new();
    for sid in session_ids.keys() {
        let Some(path) = crate::commands::sessions::find_session_file(sid) else {
            continue;
        };
        let Ok(f) = File::open(path) else { continue };
        for line in BufReader::new(f).lines().flatten() {
            let v: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let msg_type = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
            if msg_type != "assistant" && msg_type != "user" {
                continue;
            }
            let text = extract_message_text(&v);
            if text.is_empty() {
                continue;
            }
            let Some(kind) = classify_decision_kind(&text) else {
                continue;
            };
            let ts = v.get("timestamp").map(parse_timestamp_millis).unwrap_or(0);
            items.push(ProjectDecisionItem {
                project: project.clone(),
                session_id: sid.clone(),
                timestamp: ts,
                kind: kind.to_string(),
                text: text.replace('\n', " ").chars().take(280).collect(),
            });
        }
    }

    items.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    items.truncate(300);

    Ok(ProjectDecisionHistory { project, items })
}
