use base64::Engine;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};

pub struct PtyState {
    sessions: Mutex<HashMap<String, PtySession>>,
}

impl PtyState {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyOutputPayload {
    pty_id: String,
    data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyExitPayload {
    pty_id: String,
    exit_code: Option<u32>,
}

fn spawn_pty_inner(
    app: tauri::AppHandle,
    shell_command: &str,
    working_dir: &str,
) -> Result<String, String> {
    let pty_system = native_pty_system();

    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {}", e))?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
    let mut cmd = CommandBuilder::new(&shell);
    cmd.args(["-c", shell_command]);
    cmd.cwd(working_dir);

    // Inherit full environment, then override terminal-related vars
    for (key, val) in std::env::vars() {
        cmd.env(key, val);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // Disable no-flicker mode in embedded terminal (it interferes with line input)
    cmd.env("CLAUDE_CODE_NO_FLICKER", "0");

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn command: {}", e))?;

    // Drop the slave side; the child process owns it now
    drop(pair.slave);

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to take writer: {}", e))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone reader: {}", e))?;

    let pty_id = uuid::Uuid::new_v4().to_string();

    let state: State<PtyState> = app.state();
    state.sessions.lock().unwrap().insert(
        pty_id.clone(),
        PtySession {
            writer,
            master: pair.master,
            child,
        },
    );

    // Background thread to read PTY output and emit events
    let pty_id_clone = pty_id.clone();
    let app_clone = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data =
                        base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    let _ = app_clone.emit(
                        "pty-output",
                        PtyOutputPayload {
                            pty_id: pty_id_clone.clone(),
                            data,
                        },
                    );
                }
                Err(_) => break,
            }
        }

        // Process exited — try to get exit code
        let exit_code = {
            let state: State<PtyState> = app_clone.state();
            let mut sessions = state.sessions.lock().unwrap();
            if let Some(mut session) = sessions.remove(&pty_id_clone) {
                session.child.wait().ok().map(|s| s.exit_code())
            } else {
                None
            }
        };

        let _ = app_clone.emit(
            "pty-exit",
            PtyExitPayload {
                pty_id: pty_id_clone,
                exit_code,
            },
        );
    });

    Ok(pty_id)
}

#[tauri::command]
pub fn pty_spawn(app: tauri::AppHandle, session_id: String) -> Result<String, String> {
    let project = super::resume::find_project_for_session(&session_id)
        .ok_or_else(|| "Session not found".to_string())?;

    let cmd = format!("claude --resume {}", session_id);
    spawn_pty_inner(app, &cmd, &project)
}

#[tauri::command]
pub fn pty_spawn_new(app: tauri::AppHandle, project: Option<String>) -> Result<String, String> {
    let working_dir = project.unwrap_or_else(|| {
        dirs::home_dir()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string()
    });

    if !std::path::Path::new(&working_dir).is_dir() {
        return Err("Directory not found".to_string());
    }

    spawn_pty_inner(app, "claude", &working_dir)
}

#[tauri::command]
pub fn pty_write(app: tauri::AppHandle, pty_id: String, data: String) -> Result<(), String> {
    let state: State<PtyState> = app.state();
    let mut sessions = state.sessions.lock().unwrap();
    let session = sessions
        .get_mut(&pty_id)
        .ok_or_else(|| "PTY session not found".to_string())?;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data)
        .map_err(|e| format!("Invalid base64: {}", e))?;

    session
        .writer
        .write_all(&bytes)
        .map_err(|e| format!("Write failed: {}", e))?;
    session
        .writer
        .flush()
        .map_err(|e| format!("Flush failed: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn pty_resize(
    app: tauri::AppHandle,
    pty_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let state: State<PtyState> = app.state();
    let sessions = state.sessions.lock().unwrap();
    let session = sessions
        .get(&pty_id)
        .ok_or_else(|| "PTY session not found".to_string())?;

    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Resize failed: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn pty_close(app: tauri::AppHandle, pty_id: String) -> Result<(), String> {
    let state: State<PtyState> = app.state();
    let mut sessions = state.sessions.lock().unwrap();

    if let Some(mut session) = sessions.remove(&pty_id) {
        let _ = session.child.kill();
    }

    Ok(())
}
