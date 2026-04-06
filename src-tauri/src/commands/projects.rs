use crate::models::*;
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::process::Command;

fn claude_dir() -> std::path::PathBuf {
    dirs::home_dir().unwrap().join(".claude")
}

fn resolve_project_name(project_path: &str) -> Option<String> {
    let p = std::path::Path::new(project_path);

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
    if let Ok(output) = Command::new("git")
        .args(["-C", project_path, "remote", "get-url", "origin"])
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
        projects
            .entry(proj.clone())
            .and_modify(|p| {
                p.session_count += 1;
                if entry.timestamp > p.last_timestamp {
                    p.last_timestamp = entry.timestamp;
                }
            })
            .or_insert_with(|| ProjectInfo {
                path: proj.clone(),
                name: resolve_project_name(&proj),
                session_count: 1,
                last_timestamp: entry.timestamp,
            });
    }

    let mut results: Vec<ProjectInfo> = projects.into_values().collect();
    results.sort_by(|a, b| b.last_timestamp.cmp(&a.last_timestamp));
    results
}
