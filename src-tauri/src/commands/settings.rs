use crate::models::Settings;

fn settings_path() -> std::path::PathBuf {
    let app_data = dirs::data_dir()
        .unwrap_or_default()
        .join("com.cyocun.claude-session-manager");
    std::fs::create_dir_all(&app_data).ok();
    app_data.join("settings.json")
}

#[tauri::command]
pub fn get_settings() -> Settings {
    let path = settings_path();
    if path.exists() {
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(s) = serde_json::from_str::<Settings>(&content) {
                return s;
            }
        }
    }
    Settings::default()
}

#[tauri::command]
pub fn update_settings(terminal_app: Option<String>) -> Settings {
    let mut settings = get_settings();
    if let Some(app) = terminal_app {
        settings.terminal_app = app;
    }
    if let Ok(json) = serde_json::to_string_pretty(&settings) {
        std::fs::write(settings_path(), json).ok();
    }
    settings
}
