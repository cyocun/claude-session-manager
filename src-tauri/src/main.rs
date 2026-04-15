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
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Emitter, Manager};

/// データディレクトリ配下の永続化ストレージを使う index の初期化ヘルパー。
/// 失敗 (スキーマ不整合・破損など) したら当該ディレクトリを一度消してから
/// もう一度 init を呼び直す。2 回目で失敗するなら本当に壊れているので panic。
fn init_with_retry<T, E, F>(path: PathBuf, label: &str, init: F) -> Arc<T>
where
    F: Fn(PathBuf) -> Result<T, E>,
    E: std::fmt::Display,
{
    match init(path.clone()) {
        Ok(v) => Arc::new(v),
        Err(e) => {
            eprintln!("Failed to init {}: {}", label, e);
            let _ = std::fs::remove_dir_all(&path);
            Arc::new(
                init(path).unwrap_or_else(|e| {
                    panic!("Failed to init {} after cleanup: {}", label, e)
                }),
            )
        }
    }
}

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

            let data_dir = dirs::data_dir()
                .unwrap_or_default()
                .join("com.cyocun.claude-session-manager");

            let search_index: Arc<csm_core::search::SearchIndex> = init_with_retry(
                data_dir.join("search-index"),
                "search index",
                csm_core::search::SearchIndex::new,
            );
            app.manage(pty::PtyState::new());
            app.manage(search_index.clone());

            // Embedding engine: モデル本体は初回 DL 要求時に HF から取得する
            let embedding_engine =
                Arc::new(csm_core::embedding::EmbeddingEngine::new(
                    data_dir.join("embedding-models"),
                ));
            app.manage(embedding_engine.clone());

            // Vector index: 起動時は disk 上の persisted データを読むだけ。
            // 実 embedding の構築は build_vector_index コマンドで明示的に走らせる。
            let vector_index: Arc<csm_core::vector_index::VectorIndex> = {
                let engine = embedding_engine.clone();
                init_with_retry(
                    data_dir.join("vector-index"),
                    "vector index",
                    move |p| csm_core::vector_index::VectorIndex::new(p, engine.clone()),
                )
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
