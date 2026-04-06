use crate::commands::sessions::list_sessions;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};

const TRAY_ID: &str = "main";

pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_tray_menu(app)?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(app.default_window_icon().cloned().unwrap())
        .icon_as_template(true)
        .menu(&menu)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if id == "open_ui" {
                if let Some(window) = app.get_webview_window("main") {
                    window.show().ok();
                    window.set_focus().ok();
                }
            } else if id == "quit" {
                app.exit(0);
            } else if id.starts_with("session:") {
                let session_id = id.strip_prefix("session:").unwrap_or("");
                if !session_id.is_empty() {
                    let _ = crate::commands::resume::resume_session(session_id.to_string());
                }
            }
        })
        .build(app)?;

    // Refresh tray menu every 30 seconds
    let app_handle = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(30));
        if let Err(e) = refresh_tray(&app_handle) {
            eprintln!("tray refresh error: {}", e);
        }
    });

    Ok(())
}

fn build_tray_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let sessions = list_sessions(false);
    let recent: Vec<_> = sessions.into_iter().take(5).collect();

    let mut builder = MenuBuilder::new(app);

    for s in &recent {
        let project_name = s.project.split('/').last().unwrap_or(&s.project);
        let display: String = s.first_display.chars().take(40).collect();
        let label = format!("{}: {}", project_name, display);
        let id = format!("session:{}", s.session_id);
        let item = MenuItemBuilder::with_id(id, label).build(app)?;
        builder = builder.item(&item);
    }

    builder = builder.separator();
    let open_item = MenuItemBuilder::with_id("open_ui", "Open UI").build(app)?;
    builder = builder.item(&open_item);
    builder = builder.separator();
    let quit_item = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
    builder = builder.item(&quit_item);

    builder.build()
}

fn refresh_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_tray_menu(app)?;
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_menu(Some(menu))?;
    }
    Ok(())
}
