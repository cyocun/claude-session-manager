use crate::models::*;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::process::Command;

fn claude_dir() -> std::path::PathBuf {
    dirs::home_dir().unwrap().join(".claude")
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

fn find_running_session(session_id: &str) -> Option<String> {
    let output = Command::new("pgrep")
        .args(["-af", &format!("claude.*--resume.*{}", session_id)])
        .output()
        .ok()?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let pid = stdout.trim().split_whitespace().next()?;
        Some(pid.to_string())
    } else {
        None
    }
}

fn activate_terminal_window(session_id: &str, terminal_app: &str) -> bool {
    let script = match terminal_app {
        "iTerm" => format!(
            r#"tell application "iTerm"
                repeat with w in windows
                    repeat with t in tabs of w
                        repeat with s in sessions of t
                            if tty of s is not "" then
                                set sessionName to name of s
                                if sessionName contains "{sid}" then
                                    select t
                                    set index of w to 1
                                    activate
                                    return true
                                end if
                            end if
                        end repeat
                    end repeat
                end repeat
            end tell
            return false"#,
            sid = session_id
        ),
        "Terminal" => format!(
            r#"tell application "Terminal"
                repeat with w in windows
                    repeat with t in tabs of w
                        if processes of t contains "claude" then
                            set customTitle to custom title of t
                            if customTitle contains "{sid}" then
                                set selected tab of w to t
                                set index of w to 1
                                activate
                                return true
                            end if
                        end if
                    end repeat
                end repeat
            end tell
            return false"#,
            sid = session_id
        ),
        _ => return false,
    };

    Command::new("osascript")
        .args(["-e", &script])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains("true"))
        .unwrap_or(false)
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
    let pid = find_running_session(&session_id);
    SessionStatus {
        running: pid.is_some(),
        pid,
    }
}

#[tauri::command]
pub fn start_new_session() -> ResumeResult {
    let settings = super::settings::get_settings();
    let terminal_app = &settings.terminal_app;
    let home = dirs::home_dir().unwrap_or_default().to_string_lossy().to_string();
    let cmd = format!("cd {} && claude", home);

    let script = match terminal_app.as_str() {
        "iTerm" => format!(
            r#"tell application "iTerm"
                activate
                tell current window
                    create tab with default profile
                    tell current session
                        write text "{cmd}"
                    end tell
                end tell
            end tell"#
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
            app = terminal_app
        ),
        _ => format!(
            r#"tell application "Terminal"
                activate
                do script "{cmd}"
            end tell"#
        ),
    };

    match Command::new("osascript").args(["-e", &script]).spawn() {
        Ok(_) => ResumeResult { ok: true, method: terminal_app.clone(), pid: None, error: None },
        Err(e) => ResumeResult { ok: false, method: String::new(), pid: None, error: Some(e.to_string()) },
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
    let terminal_app = &settings.terminal_app;

    // Check if already running
    if let Some(pid) = find_running_session(&session_id) {
        if activate_terminal_window(&session_id, terminal_app) {
            return ResumeResult { ok: true, method: "activated".to_string(), pid: Some(pid), error: None };
        }
        let _ = Command::new("osascript")
            .args(["-e", &format!(r#"tell application "{}" to activate"#, terminal_app)])
            .spawn();
        return ResumeResult { ok: true, method: "activated-app".to_string(), pid: Some(pid), error: None };
    }

    let cmd = format!("cd {} && claude --resume {}", project, session_id);

    let script = match terminal_app.as_str() {
        "iTerm" => format!(
            r#"tell application "iTerm"
                activate
                tell current window
                    create tab with default profile
                    tell current session
                        write text "{cmd}"
                    end tell
                end tell
            end tell"#
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
            app = terminal_app
        ),
        _ => format!(
            r#"tell application "Terminal"
                activate
                do script "{cmd}"
            end tell"#
        ),
    };

    match Command::new("osascript").args(["-e", &script]).spawn() {
        Ok(_) => ResumeResult { ok: true, method: terminal_app.clone(), pid: None, error: None },
        Err(e) => ResumeResult { ok: false, method: String::new(), pid: None, error: Some(e.to_string()) },
    }
}
