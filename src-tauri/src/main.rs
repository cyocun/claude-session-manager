// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod models;
mod tray;

use commands::{archive, projects, resume, sessions, settings};

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            sessions::list_sessions,
            sessions::get_session_detail,
            projects::list_projects,
            archive::archive_sessions,
            settings::get_settings,
            settings::update_settings,
            resume::resume_session,
            resume::get_resume_command,
            resume::get_session_status,
        ])
        .setup(|app| {
            tray::setup_tray(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
