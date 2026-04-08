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
    super::sessions::claude_dir()
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

fn classify_model(model_str: &str) -> &'static str {
    let m = model_str.to_lowercase();
    if m.contains("opus") {
        "opus"
    } else if m.contains("haiku") {
        "haiku"
    } else {
        "sonnet"
    }
}

fn estimate_cost_usd_for_model(
    model: &str,
    input: u64,
    output: u64,
    cache_creation: u64,
    cache_read: u64,
) -> f64 {
    let (input_rate, output_rate, cache_create_rate, cache_read_rate) = match classify_model(model)
    {
        "opus" => (15.0, 75.0, 18.75, 1.50),
        "haiku" => (0.80, 4.0, 1.0, 0.08),
        _ => (3.0, 15.0, 3.75, 0.30), // sonnet
    };
    (input as f64 * input_rate / 1_000_000.0)
        + (output as f64 * output_rate / 1_000_000.0)
        + (cache_creation as f64 * cache_create_rate / 1_000_000.0)
        + (cache_read as f64 * cache_read_rate / 1_000_000.0)
}

fn accumulate_time_point(
    map: &mut HashMap<String, TokenTimePoint>,
    label: String,
    input: u64,
    output: u64,
    cache_creation: u64,
    cache_read: u64,
    total: u64,
    cost: f64,
) {
    let entry = map.entry(label.clone()).or_insert(TokenTimePoint {
        label,
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        total_tokens: 0,
        estimated_cost_usd: 0.0,
    });
    entry.input_tokens += input;
    entry.output_tokens += output;
    entry.cache_creation_input_tokens += cache_creation;
    entry.cache_read_input_tokens += cache_read;
    entry.total_tokens += total;
    entry.estimated_cost_usd += cost;
}

fn extract_user_text(v: &serde_json::Value) -> Option<String> {
    let content = v.get("message").and_then(|m| m.get("content"))?;
    let mut out = String::new();
    match content {
        serde_json::Value::String(s) => out.push_str(s),
        serde_json::Value::Array(arr) => {
            for block in arr {
                if let Some(t) = block.as_str() {
                    if !out.is_empty() {
                        out.push(' ');
                    }
                    out.push_str(t);
                } else if block.get("type").and_then(|x| x.as_str()) == Some("text") {
                    if let Some(t) = block.get("text").and_then(|x| x.as_str()) {
                        if !out.is_empty() {
                            out.push(' ');
                        }
                        out.push_str(t);
                    }
                }
            }
        }
        _ => {}
    }
    let trimmed = out.trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

fn compute_word_freq_native(texts: &[String]) -> Vec<WordFreqEntry> {
    if texts.is_empty() {
        return vec![];
    }
    let joined = texts.join("\n");
    let swift_code = r#"
import Foundation
import NaturalLanguage
let data = FileHandle.standardInput.readDataToEndOfFile()
guard let text = String(data: data, encoding: .utf8) else { exit(0) }
let stopEn: Set<String> = ["the","a","an","is","are","was","were","be","been","being","have","has","had","do","does","did","will","would","could","should","may","might","can","shall","to","of","in","for","on","with","at","by","from","as","into","through","during","before","after","above","below","between","out","off","over","under","again","further","then","once","here","there","when","where","why","how","all","both","each","few","more","most","other","some","such","no","nor","not","only","own","same","so","than","too","very","just","this","that","these","those","it","its","me","my","we","our","you","your","he","him","his","she","her","they","them","their","what","which","who","whom","and","but","if","or","because","until","while","about","like","also","any","new","use","using","used","get","set","one","two","need","want","make","see","know","don","re","ve","ll","let","way","well","now","still"]
let stopJa: Set<String> = ["の","に","は","を","た","が","で","て","と","し","れ","さ","も","から","な","や","ない","この","その","あの","よう","また","もの","こと","する","ある","いる","なる","ため","まで","へ","か","だ","これ","それ","あれ","です","ます","って","ください","よ","ね","けど","ので","なら","てる","した","ている","という","ちょっと","そう","ここ","あと","じゃ","って","もう","ん","だけ","たい","ない","なっ","られ","おり","せ"]
let tok = NLTokenizer(unit: .word)
tok.string = text
var counts: [String: Int] = [:]
tok.enumerateTokens(in: text.startIndex..<text.endIndex) { range, _ in
    let w = String(text[range]).lowercased()
    if w.count >= 2 && !stopEn.contains(w) && !stopJa.contains(w) {
        counts[w, default: 0] += 1
    }
    return true
}
let sorted = counts.sorted { $0.value > $1.value }.prefix(50)
for (word, count) in sorted {
    print("\(count)\t\(word)")
}
"#;
    // Write Swift script to temp file
    let tmp_dir = std::env::temp_dir();
    let script_path = tmp_dir.join("csm_word_freq.swift");
    if std::fs::write(&script_path, swift_code).is_err() {
        return vec![];
    }

    let child = Command::new("swift")
        .arg(&script_path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn();

    let Ok(mut child) = child else {
        return vec![];
    };

    if let Some(mut stdin) = child.stdin.take() {
        use std::io::Write;
        let _ = stdin.write_all(joined.as_bytes());
    }

    let Ok(output) = child.wait_with_output() else {
        return vec![];
    };
    let _ = std::fs::remove_file(&script_path);

    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(2, '\t');
            let count = parts.next()?.parse::<u64>().ok()?;
            let word = parts.next()?.to_string();
            Some(WordFreqEntry { word, count })
        })
        .collect()
}

fn extract_tool_names(v: &serde_json::Value) -> Vec<String> {
    let mut names = Vec::new();
    if let Some(arr) = v.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_array())
    {
        for block in arr {
            if block.get("type").and_then(|x| x.as_str()) == Some("tool_use") {
                if let Some(name) = block.get("name").and_then(|x| x.as_str()) {
                    names.push(name.to_string());
                }
            }
        }
    }
    names
}

fn compute_token_dashboard(since_days: Option<u32>) -> Result<TokenDashboard, String> {
    let projects_dir = claude_dir().join("projects");
    let empty = TokenDashboard {
        totals: TokenTotals::default(),
        by_hour: vec![],
        by_project: vec![],
        by_day: vec![],
        by_week: vec![],
        by_month: vec![],
        by_session: vec![],
        tool_usage: vec![],
        by_model: vec![],
        word_freq: vec![],
    };
    if !projects_dir.exists() {
        return Ok(empty);
    }
    // Cutoff timestamp in millis (0 = no filter)
    let cutoff_ms: u64 = since_days
        .map(|d| {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            now.saturating_sub(d as u64 * 86_400_000)
        })
        .unwrap_or(0);

    let mut by_project: HashMap<String, TokenProjectRow> = HashMap::new();
    let mut by_hour: HashMap<String, TokenTimePoint> = HashMap::new();
    let mut by_day: HashMap<String, TokenTimePoint> = HashMap::new();
    let mut by_week: HashMap<String, TokenTimePoint> = HashMap::new();
    let mut by_month: HashMap<String, TokenTimePoint> = HashMap::new();
    let mut by_session: HashMap<String, TokenSessionRow> = HashMap::new();
    let mut tool_counts: HashMap<String, u64> = HashMap::new();
    let mut model_map: HashMap<String, ModelBreakdown> = HashMap::new();
    let mut user_texts: Vec<String> = Vec::new();
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
            let msg_type = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
            let session_id = v.get("sessionId").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let project = v.get("cwd").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let ts = v.get("timestamp").map(parse_timestamp_millis).unwrap_or(0);
            if cutoff_ms > 0 && ts < cutoff_ms {
                continue;
            }

            // Collect user text for word frequency analysis
            if msg_type == "human" || msg_type == "user" {
                if let Some(text) = extract_user_text(&v) {
                    user_texts.push(text);
                }
            }

            // Extract tool usage from assistant messages
            if msg_type == "assistant" {
                for tool_name in extract_tool_names(&v) {
                    *tool_counts.entry(tool_name).or_insert(0) += 1;
                }
            }

            let model_str = v
                .get("message")
                .and_then(|m| m.get("model"))
                .and_then(|x| x.as_str())
                .unwrap_or("");

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
            let cost = estimate_cost_usd_for_model(model_str, input, output, cache_creation, cache_read);

            totals.input_tokens += input;
            totals.output_tokens += output;
            totals.cache_creation_input_tokens += cache_creation;
            totals.cache_read_input_tokens += cache_read;
            totals.total_tokens += total;
            totals.estimated_cost_usd += cost;

            // Model breakdown
            if !model_str.is_empty() {
                let model_class = classify_model(model_str).to_string();
                let me = model_map.entry(model_class.clone()).or_insert(ModelBreakdown {
                    model: model_class,
                    input_tokens: 0,
                    output_tokens: 0,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                    total_tokens: 0,
                    estimated_cost_usd: 0.0,
                    message_count: 0,
                });
                me.input_tokens += input;
                me.output_tokens += output;
                me.cache_creation_input_tokens += cache_creation;
                me.cache_read_input_tokens += cache_read;
                me.total_tokens += total;
                me.estimated_cost_usd += cost;
                me.message_count += 1;
            }

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

            accumulate_time_point(&mut by_hour, hour_label(ts), input, output, cache_creation, cache_read, total, cost);
            accumulate_time_point(&mut by_day, day_label(ts), input, output, cache_creation, cache_read, total, cost);
            accumulate_time_point(&mut by_week, week_label(ts), input, output, cache_creation, cache_read, total, cost);
            accumulate_time_point(&mut by_month, month_label(ts), input, output, cache_creation, cache_read, total, cost);

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

    // Tool usage sorted by count
    let mut tool_usage: Vec<ToolUsageEntry> = tool_counts
        .into_iter()
        .map(|(name, count)| ToolUsageEntry { name, count })
        .collect();
    tool_usage.sort_by(|a, b| b.count.cmp(&a.count));

    // Model breakdown sorted by cost
    let mut by_model: Vec<ModelBreakdown> = model_map.into_values().collect();
    by_model.sort_by(|a, b| b.estimated_cost_usd.partial_cmp(&a.estimated_cost_usd).unwrap_or(std::cmp::Ordering::Equal));

    // Word frequency via macOS NLTokenizer
    let word_freq = compute_word_freq_native(&user_texts);

    Ok(TokenDashboard {
        totals,
        by_hour: by_hour_vec,
        by_project: by_project_vec,
        by_day: by_day_vec,
        by_week: by_week_vec,
        by_month: by_month_vec,
        by_session: by_session_vec,
        tool_usage,
        by_model,
        word_freq,
    })
}

static TOKEN_CACHE: OnceLock<Mutex<Option<(u64, Option<u32>, TokenDashboard)>>> = OnceLock::new();
const TOKEN_CACHE_TTL_SECS: u64 = 30;

#[tauri::command]
pub async fn get_token_dashboard(since_days: Option<u32>) -> Result<TokenDashboard, String> {
    let cache = TOKEN_CACHE.get_or_init(|| Mutex::new(None));
    let now = now_ts();
    if let Ok(guard) = cache.lock() {
        if let Some((ts, cached_days, data)) = &*guard {
            if now.saturating_sub(*ts) <= TOKEN_CACHE_TTL_SECS && *cached_days == since_days {
                return Ok(data.clone());
            }
        }
    }

    let days = since_days;
    let computed = tauri::async_runtime::spawn_blocking(move || compute_token_dashboard(days))
        .await
        .map_err(|e| e.to_string())??;

    if let Ok(mut guard) = cache.lock() {
        *guard = Some((now, since_days, computed.clone()));
    }
    Ok(computed)
}

