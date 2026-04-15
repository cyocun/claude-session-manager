// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod menu;
mod models;
mod tray;

use commands::{
    archive, clipboard, embedding as embedding_cmd, projects, pty, resume, search as search_cmd,
    sessions, settings, updater, vector_search as vector_cmd,
};
use std::sync::Arc;
use tauri::{Emitter, Manager};

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
    let should_clear_cache = std::env::var("CSM_CLEAR_WEBVIEW_CACHE")
        .map(|v| matches!(v.as_str(), "1" | "true" | "TRUE" | "yes" | "YES"))
        .unwrap_or(false);
    if should_clear_cache {
        clear_webview_cache();
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            sessions::list_sessions,
            sessions::get_session_detail,
            sessions::get_session_messages_around,
            projects::list_projects,
            projects::get_project_icon,
            projects::get_token_dashboard,
            projects::get_project_readme,
            projects::open_readme_window,
            projects::get_project_readme_by_path,
            archive::archive_sessions,
            settings::get_settings,
            settings::update_settings,
            clipboard::copy_to_clipboard,
            resume::resume_session,
            resume::start_new_session,
            resume::start_new_session_in_project,
            resume::open_project_in_terminal,
            resume::open_usage_stats,
            resume::get_resume_command,
            resume::get_session_status,
            resume::resume_with_prompt,
            resume::open_path,
            search_cmd::search_sessions,
            search_cmd::get_search_index_status,
            search_cmd::update_search_index,
            embedding_cmd::get_embedding_model_status,
            embedding_cmd::is_embedding_model_cached,
            embedding_cmd::download_embedding_model,
            vector_cmd::get_vector_index_status,
            vector_cmd::build_vector_index,
            vector_cmd::update_vector_index,
            vector_cmd::vector_search,
            vector_cmd::hybrid_search,
            pty::pty_spawn,
            pty::pty_spawn_new,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_close,
            updater::check_for_update,
            updater::install_update_and_restart,
            sync_menu_state,
        ])
        .setup(|app| {
            menu::setup_menu(app.handle())?;
            tray::setup_tray(app.handle())?;

            // Initialize search index
            let data_dir = dirs::data_dir()
                .unwrap_or_default()
                .join("com.cyocun.claude-session-manager");
            let index_dir = data_dir.join("search-index");
            let search_index = match csm_core::search::SearchIndex::new(index_dir) {
                Ok(idx) => Arc::new(idx),
                Err(e) => {
                    eprintln!("Failed to create search index: {}", e);
                    // Try again after removing corrupted index
                    let index_dir = data_dir.join("search-index");
                    let _ = std::fs::remove_dir_all(&index_dir);
                    Arc::new(
                        csm_core::search::SearchIndex::new(index_dir)
                            .expect("Failed to create search index after cleanup"),
                    )
                }
            };
            app.manage(pty::PtyState::new());
            app.manage(search_index.clone());

            // Embedding engine: モデル本体は初回 DL 要求時に HF から取得する
            let embedding_dir = data_dir.join("embedding-models");
            let embedding_engine =
                Arc::new(csm_core::embedding::EmbeddingEngine::new(embedding_dir));
            app.manage(embedding_engine.clone());

            // Vector index: 起動時は disk 上の persisted データを読むだけ。
            // 実 embedding の構築は build_vector_index コマンドで明示的に走らせる。
            let vector_dir = data_dir.join("vector-index");
            let vector_index = match csm_core::vector_index::VectorIndex::new(
                vector_dir.clone(),
                embedding_engine.clone(),
            ) {
                Ok(v) => Arc::new(v),
                Err(e) => {
                    eprintln!("Failed to init vector index: {}", e);
                    let _ = std::fs::remove_dir_all(&vector_dir);
                    Arc::new(
                        csm_core::vector_index::VectorIndex::new(vector_dir, embedding_engine)
                            .expect("Failed to init vector index after cleanup"),
                    )
                }
            };
            app.manage(vector_index);

            // Background index build
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                if let Err(e) = search_index.build_full_index() {
                    eprintln!("Search index build failed: {}", e);
                }
                let _ = handle.emit("search-index-ready", ());
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
