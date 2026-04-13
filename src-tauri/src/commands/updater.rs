use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

#[derive(Serialize)]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    pub notes: Option<String>,
    pub date: Option<String>,
}

#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    eprintln!(
        "[updater] check starting (current {})",
        env!("CARGO_PKG_VERSION")
    );
    let updater = app.updater().map_err(|e| {
        eprintln!("[updater] updater handle error: {e}");
        e.to_string()
    })?;
    let update = updater.check().await.map_err(|e| {
        eprintln!("[updater] check error: {e}");
        e.to_string()
    })?;
    match &update {
        Some(u) => eprintln!("[updater] update available: {}", u.version),
        None => eprintln!("[updater] no update"),
    }
    Ok(update.map(|u| UpdateInfo {
        version: u.version.clone(),
        current_version: u.current_version.clone(),
        notes: u.body.clone(),
        date: u.date.map(|d| d.to_string()),
    }))
}

#[tauri::command]
pub async fn install_update_and_restart(app: AppHandle) -> Result<(), String> {
    eprintln!("[updater] install requested");
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = updater.check().await.map_err(|e| {
        eprintln!("[updater] install-time check error: {e}");
        e.to_string()
    })?;
    let Some(update) = update else {
        eprintln!("[updater] install aborted: no update available");
        return Err("no update available".to_string());
    };
    update
        .download_and_install(
            |chunk, total| {
                eprintln!(
                    "[updater] download progress: {chunk}{}",
                    total.map(|t| format!("/{t}")).unwrap_or_default()
                );
            },
            || {
                eprintln!("[updater] download finished, installing");
            },
        )
        .await
        .map_err(|e| {
            eprintln!("[updater] install error: {e}");
            e.to_string()
        })?;
    eprintln!("[updater] restarting");
    app.restart();
}
