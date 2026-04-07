// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod menu;
mod models;
mod tray;

use commands::{archive, projects, resume, sessions, settings};

#[tauri::command]
fn sync_menu_state(
    app: tauri::AppHandle,
    theme: String,
    terminal: String,
    lang: String,
    show_archived: bool,
) {
    menu::sync_menu_state(&app, &theme, &terminal, &lang, show_archived);
}

fn clear_webview_cache() {
    // Remove WKWebView cache to prevent stale UI on launch
    if let Some(home) = dirs::home_dir() {
        let ids = [
            "com.cyocun.claude-session-manager",
            "claude-session-manager",
        ];
        for id in &ids {
            let paths = [
                home.join("Library/WebKit").join(id),
                home.join("Library/Caches").join(id),
            ];
            for p in &paths {
                if p.exists() {
                    let _ = std::fs::remove_dir_all(p);
                }
            }
        }
    }
}

fn main() {
    clear_webview_cache();
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            sessions::list_sessions,
            sessions::get_session_detail,
            projects::list_projects,
            archive::archive_sessions,
            settings::get_settings,
            settings::update_settings,
            resume::resume_session,
            resume::start_new_session,
            resume::get_resume_command,
            resume::get_session_status,
            sync_menu_state,
        ])
        .setup(|app| {
            menu::setup_menu(app.handle())?;
            tray::setup_tray(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
