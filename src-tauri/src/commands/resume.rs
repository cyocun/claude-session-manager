use crate::models::*;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::process::Command;

fn claude_dir() -> std::path::PathBuf {
    super::sessions::claude_dir()
}

fn find_project_for_session(session_id: &str) -> Option<String> {
    let path = claude_dir().join("history.jsonl");
    let file = File::open(&path).ok()?;
    for line in BufReader::new(file).lines().flatten() {
        if let Ok(entry) = serde_json::from_str::<HistoryEntry>(&line) {
            if entry.session_id == session_id {
                return Some(entry.project);
            }
        }
    }
    None
}

/// Look up ~/.claude/sessions/{PID}.json to find which PID owns the given session ID.
/// Returns (pid, tty) if the process is still alive.
fn find_running_session(session_id: &str) -> Option<(String, String)> {
    let sessions_dir = claude_dir().join("sessions");
    for entry in std::fs::read_dir(&sessions_dir).ok()?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let v: serde_json::Value = match serde_json::from_str(&content) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if v.get("sessionId").and_then(|s| s.as_str()) != Some(session_id) {
            continue;
        }
        let pid = match v.get("pid").and_then(|p| p.as_u64()) {
            Some(p) => p.to_string(),
            None => continue,
        };
        // Verify process is still alive
        let alive = Command::new("ps")
            .args(["-p", &pid, "-o", "pid="])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !alive {
            continue;
        }
        // Walk up process tree to find the iTerm session's tty.
        // claude spawns a pty, so its tty differs from the iTerm session tty.
        // Typically: claude(ttyA) -> shell(ttyA) -> shell(ttyB) where ttyB is the iTerm session.
        if let Some(tty) = find_iterm_tty(&pid) {
            return Some((pid, tty));
        }
    }
    None
}

/// Walk up the process tree to find the tty that iTerm owns.
/// claude creates a pty internally, so its direct tty != the iTerm session tty.
/// We walk ancestors until the tty changes — that ancestor's tty is the iTerm session's.
fn find_iterm_tty(pid: &str) -> Option<String> {
    let get_ppid_tty = |p: &str| -> Option<(String, String)> {
        let out = Command::new("ps")
            .args(["-o", "ppid=,tty=", "-p", p])
            .output()
            .ok()?;
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let mut parts = s.split_whitespace();
        let ppid = parts.next()?.to_string();
        let tty = parts.next()?.to_string();
        Some((ppid, tty))
    };

    // Get claude's own tty
    let out = Command::new("ps")
        .args(["-o", "tty=", "-p", pid])
        .output()
        .ok()?;
    let own_tty = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if own_tty.is_empty() || own_tty == "?" {
        return None;
    }

    // Walk up until tty changes (max 5 hops to avoid infinite loops)
    let mut current = pid.to_string();
    for _ in 0..5 {
        let (ppid, tty) = get_ppid_tty(&current)?;
        if tty != own_tty && tty != "??" {
            return Some(format!("/dev/{}", tty));
        }
        if ppid == "1" || ppid == "0" {
            break;
        }
        current = ppid;
    }

    // Fallback: use own tty
    Some(format!("/dev/{}", own_tty))
}

/// Focus the terminal tab that owns the given tty.
fn activate_terminal_window(tty: &str, terminal_app: &str) -> bool {
    let script = match terminal_app {
        "iTerm" => format!(
            r#"tell application "iTerm"
                repeat with w in windows
                    repeat with t in tabs of w
                        repeat with s in sessions of t
                            if tty of s is "{tty}" then
                                select t
                                set index of w to 1
                                activate
                                return true
                            end if
                        end repeat
                    end repeat
                end repeat
            end tell
            return false"#,
            tty = tty
        ),
        "Terminal" => format!(
            r#"tell application "Terminal"
                repeat with w in windows
                    repeat with t in tabs of w
                        if tty of t is "{tty}" then
                            set selected tab of w to t
                            set index of w to 1
                            activate
                            return true
                        end if
                    end repeat
                end repeat
            end tell
            return false"#,
            tty = tty
        ),
        _ => return false,
    };

    Command::new("osascript")
        .args(["-e", &script])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains("true"))
        .unwrap_or(false)
}

fn normalize_terminal_app(app: &str) -> &str {
    // Backward compatibility for older setting values.
    if app == "tmux" {
        "cmux"
    } else {
        app
    }
}

fn shell_single_quote_escape(s: &str) -> String {
    s.replace('\'', "'\\''")
}

fn applescript_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

fn launch_in_terminal(terminal_app: &str, cmd: &str) -> Result<String, String> {
    let terminal_app = normalize_terminal_app(terminal_app);
    let cmd_escaped = applescript_escape(cmd);
    let script = match terminal_app {
        "iTerm" => format!(
            r#"tell application "iTerm"
                activate
                tell current window
                    create tab with default profile
                    tell current session
                        write text "{cmd}"
                    end tell
                end tell
            end tell"#,
            cmd = cmd_escaped
        ),
        "Warp" | "Ghostty" | "cmux" => format!(
            r#"tell application "{app}"
                activate
            end tell
            delay 0.3
            tell application "System Events"
                tell process "{app}"
                    keystroke "t" using command down
                    delay 0.2
                    keystroke "{cmd}"
                    key code 36
                end tell
            end tell"#,
            app = terminal_app,
            cmd = cmd_escaped
        ),
        _ => format!(
            r#"tell application "Terminal"
                activate
                do script "{cmd}"
            end tell"#,
            cmd = cmd_escaped
        ),
    };

    Command::new("osascript")
        .args(["-e", &script])
        .spawn()
        .map_err(|e| e.to_string())?;

    Ok(terminal_app.to_string())
}

#[tauri::command]
pub fn get_resume_command(session_id: String) -> Result<ResumeCommand, String> {
    let project = find_project_for_session(&session_id).ok_or("Session not found")?;
    let command = format!("cd {} && claude --resume {}", project, session_id);
    Ok(ResumeCommand {
        command,
        project,
        session_id,
    })
}

#[tauri::command]
pub fn get_session_status(session_id: String) -> SessionStatus {
    let result = find_running_session(&session_id);
    SessionStatus {
        running: result.is_some(),
        pid: result.map(|(pid, _)| pid),
    }
}

#[tauri::command]
pub fn start_new_session() -> ResumeResult {
    let settings = super::settings::get_settings();
    let terminal_app = normalize_terminal_app(&settings.terminal_app);
    let home = dirs::home_dir().unwrap_or_default().to_string_lossy().to_string();
    let cmd = format!("cd '{}' && claude", shell_single_quote_escape(&home));

    match launch_in_terminal(terminal_app, &cmd) {
        Ok(method) => ResumeResult { ok: true, method, pid: None, error: None },
        Err(e) => ResumeResult { ok: false, method: String::new(), pid: None, error: Some(e) },
    }
}

#[tauri::command]
pub fn start_new_session_in_project(project: String) -> ResumeResult {
    let project = project.trim();
    if project.is_empty() {
        return ResumeResult {
            ok: false,
            method: String::new(),
            pid: None,
            error: Some("Project path is empty".to_string()),
        };
    }
    if !std::path::Path::new(project).is_dir() {
        return ResumeResult {
            ok: false,
            method: String::new(),
            pid: None,
            error: Some("Project directory not found".to_string()),
        };
    }

    let settings = super::settings::get_settings();
    let terminal_app = normalize_terminal_app(&settings.terminal_app);
    let cmd = format!("cd '{}' && claude", shell_single_quote_escape(project));

    match launch_in_terminal(terminal_app, &cmd) {
        Ok(method) => ResumeResult { ok: true, method, pid: None, error: None },
        Err(e) => ResumeResult { ok: false, method: String::new(), pid: None, error: Some(e) },
    }
}

#[tauri::command]
pub fn open_project_in_terminal(project: String) -> ResumeResult {
    let project = project.trim();
    if project.is_empty() {
        return ResumeResult {
            ok: false,
            method: String::new(),
            pid: None,
            error: Some("Project path is empty".to_string()),
        };
    }
    if !std::path::Path::new(project).is_dir() {
        return ResumeResult {
            ok: false,
            method: String::new(),
            pid: None,
            error: Some("Project directory not found".to_string()),
        };
    }

    let settings = super::settings::get_settings();
    let terminal_app = normalize_terminal_app(&settings.terminal_app);
    let cmd = format!("cd '{}'", shell_single_quote_escape(project));

    match launch_in_terminal(terminal_app, &cmd) {
        Ok(method) => ResumeResult { ok: true, method, pid: None, error: None },
        Err(e) => ResumeResult { ok: false, method: String::new(), pid: None, error: Some(e) },
    }
}

#[tauri::command]
pub fn open_usage_stats() -> ResumeResult {
    let settings = super::settings::get_settings();
    let terminal_app = normalize_terminal_app(&settings.terminal_app);
    let home = dirs::home_dir().unwrap_or_default().to_string_lossy().to_string();
    let cmd = format!(
        "cd '{}' && claude && /usage",
        shell_single_quote_escape(&home)
    );

    match launch_in_terminal(terminal_app, &cmd) {
        Ok(method) => ResumeResult {
            ok: true,
            method,
            pid: None,
            error: None,
        },
        Err(e) => ResumeResult {
            ok: false,
            method: String::new(),
            pid: None,
            error: Some(e),
        },
    }
}

#[tauri::command]
pub fn resume_session(session_id: String) -> ResumeResult {
    let project = match find_project_for_session(&session_id) {
        Some(p) => p,
        None => {
            return ResumeResult {
                ok: false,
                method: String::new(),
                pid: None,
                error: Some("Session not found".to_string()),
            }
        }
    };

    let settings = super::settings::get_settings();
    let terminal_app = normalize_terminal_app(&settings.terminal_app);

    // Check if already running — focus existing terminal tab via tty
    if let Some((pid, tty)) = find_running_session(&session_id) {
        if activate_terminal_window(&tty, terminal_app) {
            return ResumeResult { ok: true, method: "activated".to_string(), pid: Some(pid), error: None };
        }
        let _ = Command::new("osascript")
            .args(["-e", &format!(r#"tell application "{}" to activate"#, terminal_app)])
            .spawn();
        return ResumeResult { ok: true, method: "activated-app".to_string(), pid: Some(pid), error: None };
    }

    let cmd = format!(
        "cd '{}' && claude --resume {}",
        shell_single_quote_escape(&project),
        shell_single_quote_escape(&session_id)
    );

    match launch_in_terminal(terminal_app, &cmd) {
        Ok(method) => ResumeResult { ok: true, method, pid: None, error: None },
        Err(e) => ResumeResult { ok: false, method: String::new(), pid: None, error: Some(e) },
    }
}

#[tauri::command]
pub fn resume_with_prompt(session_id: String, prompt: String) -> ResumeResult {
    let project = match find_project_for_session(&session_id) {
        Some(p) => p,
        None => {
            return ResumeResult {
                ok: false,
                method: String::new(),
                pid: None,
                error: Some("Session not found".to_string()),
            }
        }
    };

    let settings = super::settings::get_settings();
    let terminal_app = normalize_terminal_app(&settings.terminal_app);

    let cmd = format!(
        "cd '{}' && claude --resume {} '{}'",
        shell_single_quote_escape(&project),
        shell_single_quote_escape(&session_id),
        shell_single_quote_escape(&prompt)
    );

    match launch_in_terminal(terminal_app, &cmd) {
        Ok(method) => ResumeResult { ok: true, method, pid: None, error: None },
        Err(e) => ResumeResult { ok: false, method: String::new(), pid: None, error: Some(e) },
    }
}

/// Open a URL in the default browser or a file path in the default application.
#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    Command::new("open")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}
