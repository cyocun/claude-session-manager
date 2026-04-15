use tauri::menu::{
    CheckMenuItemBuilder, MenuBuilder, MenuItemKind, SubmenuBuilder,
};
use tauri::{AppHandle, Emitter, Manager};

fn find_check_item(items: &[MenuItemKind<tauri::Wry>], id: &str) -> Option<tauri::menu::CheckMenuItem<tauri::Wry>> {
    for item in items {
        match item {
            MenuItemKind::Check(c) => {
                if c.id().as_ref() == id {
                    return Some(c.clone());
                }
            }
            MenuItemKind::Submenu(sub) => {
                if let Ok(sub_items) = sub.items() {
                    if let Some(found) = find_check_item(&sub_items, id) {
                        return Some(found);
                    }
                }
            }
            _ => {}
        }
    }
    None
}

fn set_check_item(app: &AppHandle, id: &str, checked: bool) {
    if let Some(menu) = app.menu() {
        if let Ok(items) = menu.items() {
            if let Some(item) = find_check_item(&items, id) {
                let _ = item.set_checked(checked);
            }
        }
    }
}

fn get_check_item(app: &AppHandle, id: &str) -> Option<bool> {
    let menu = app.menu()?;
    let items = menu.items().ok()?;
    let item = find_check_item(&items, id)?;
    item.is_checked().ok()
}

pub fn setup_menu(app: &AppHandle) -> tauri::Result<()> {
    // Theme submenu
    let theme_system = CheckMenuItemBuilder::with_id("theme:system", "System")
        .checked(true).build(app)?;
    let theme_light = CheckMenuItemBuilder::with_id("theme:light", "Light")
        .checked(false).build(app)?;
    let theme_dark = CheckMenuItemBuilder::with_id("theme:dark", "Dark")
        .checked(false).build(app)?;

    let theme_sub = SubmenuBuilder::with_id(app, "theme_sub", "Theme")
        .item(&theme_system).item(&theme_light).item(&theme_dark)
        .build()?;

    // Terminal submenu
    let terms = [
        ("terminal:Terminal", "Terminal.app"),
        ("terminal:iTerm", "iTerm2"),
        ("terminal:Warp", "Warp"),
        ("terminal:cmux", "cmux"),
        ("terminal:Ghostty", "Ghostty"),
    ];

    let mut terminal_sub_builder = SubmenuBuilder::with_id(app, "terminal_sub", "Terminal App");
    for (id, label) in &terms {
        let item = CheckMenuItemBuilder::with_id(*id, *label)
            .checked(*id == "terminal:Terminal").build(app)?;
        terminal_sub_builder = terminal_sub_builder.item(&item);
    }
    let terminal_sub = terminal_sub_builder.build()?;

    // Language submenu
    let lang_ja = CheckMenuItemBuilder::with_id("lang:ja", "日本語")
        .checked(true).build(app)?;
    let lang_en = CheckMenuItemBuilder::with_id("lang:en", "English")
        .checked(false).build(app)?;

    let lang_sub = SubmenuBuilder::with_id(app, "lang_sub", "Language")
        .item(&lang_ja).item(&lang_en).build()?;

    // Show Archived toggle
    let show_archived = CheckMenuItemBuilder::with_id("toggle:archived", "Show Archived")
        .checked(false).build(app)?;

    let check_updates = tauri::menu::MenuItemBuilder::with_id("app:check-updates", "Check for Updates…")
        .build(app)?;

    // App menu (first submenu becomes the app-name menu on macOS)
    let app_sub = SubmenuBuilder::with_id(app, "app_sub", "Claude Sessions")
        .about(None)
        .item(&check_updates)
        .separator()
        .item(&theme_sub).item(&terminal_sub).item(&lang_sub)
        .separator()
        .item(&show_archived)
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    // File menu (new session, reload, archive)
    let new_session = tauri::menu::MenuItemBuilder::with_id("file:new-session", "New Session")
        .accelerator("CmdOrCtrl+N").build(app)?;
    let reload_sessions = tauri::menu::MenuItemBuilder::with_id("file:reload", "Reload")
        .accelerator("CmdOrCtrl+R").build(app)?;
    let archive_current = tauri::menu::MenuItemBuilder::with_id("file:archive-current", "Archive Current Session")
        .accelerator("CmdOrCtrl+Backspace").build(app)?;
    let file_sub = SubmenuBuilder::with_id(app, "file_sub", "File")
        .item(&new_session)
        .item(&reload_sessions)
        .separator()
        .item(&archive_current)
        .build()?;

    // Edit menu (for copy/paste support)
    let edit_sub = SubmenuBuilder::with_id(app, "edit_sub", "Edit")
        .undo().redo().separator().cut().copy().paste().select_all()
        .build()?;

    // View menu (home, dashboard, zoom)
    let go_home = tauri::menu::MenuItemBuilder::with_id("go:home", "Home")
        .accelerator("CmdOrCtrl+Shift+H").build(app)?;
    let go_token_dashboard = tauri::menu::MenuItemBuilder::with_id("go:token-dashboard", "Token Dashboard")
        .accelerator("CmdOrCtrl+Shift+T").build(app)?;
    let zoom_in = tauri::menu::MenuItemBuilder::with_id("zoom:in", "Zoom In")
        .accelerator("CmdOrCtrl+=").build(app)?;
    let zoom_out = tauri::menu::MenuItemBuilder::with_id("zoom:out", "Zoom Out")
        .accelerator("CmdOrCtrl+-").build(app)?;
    let zoom_reset = tauri::menu::MenuItemBuilder::with_id("zoom:reset", "Actual Size")
        .accelerator("CmdOrCtrl+0").build(app)?;
    let view_sub = SubmenuBuilder::with_id(app, "view_sub", "View")
        .item(&go_home).item(&go_token_dashboard)
        .separator()
        .item(&zoom_in).item(&zoom_out).item(&zoom_reset)
        .build()?;

    // Window menu
    let always_on_top = CheckMenuItemBuilder::with_id("window:always-on-top", "Always on Top")
        .checked(false).build(app)?;
    let window_sub = SubmenuBuilder::with_id(app, "window_sub", "Window")
        .minimize()
        .separator()
        .item(&always_on_top)
        .separator()
        .close_window()
        .build()?;

    let menu = MenuBuilder::new(app)
        .item(&app_sub).item(&file_sub).item(&edit_sub).item(&view_sub).item(&window_sub)
        .build()?;

    app.set_menu(menu)?;

    let theme_ids: Vec<String> = ["theme:system", "theme:light", "theme:dark"].iter().map(|s| s.to_string()).collect();
    let term_ids: Vec<String> = terms.iter().map(|(id, _)| id.to_string()).collect();
    let lang_ids: Vec<String> = ["lang:ja", "lang:en"].iter().map(|s| s.to_string()).collect();

    app.on_menu_event(move |app_handle, event| {
        let id = event.id().as_ref().to_string();

        if id.starts_with("theme:") {
            let value = id.strip_prefix("theme:").unwrap_or("system").to_string();
            for tid in &theme_ids {
                set_check_item(app_handle, tid, *tid == id);
            }
            let _ = app_handle.emit("menu-theme", &value);
        } else if id.starts_with("terminal:") {
            let value = id.strip_prefix("terminal:").unwrap_or("Terminal").to_string();
            for tid in &term_ids {
                set_check_item(app_handle, tid, *tid == id);
            }
            let _ = app_handle.emit("menu-terminal", &value);
        } else if id.starts_with("lang:") {
            let value = id.strip_prefix("lang:").unwrap_or("ja").to_string();
            for lid in &lang_ids {
                set_check_item(app_handle, lid, *lid == id);
            }
            let _ = app_handle.emit("menu-lang", &value);
        } else if id == "toggle:archived" {
            let checked = get_check_item(app_handle, "toggle:archived").unwrap_or(false);
            let _ = app_handle.emit("menu-show-archived", checked);
        } else if id.starts_with("zoom:") {
            let action = id.strip_prefix("zoom:").unwrap_or("reset").to_string();
            let _ = app_handle.emit("menu-zoom", &action);
        } else if id == "go:home" {
            let _ = app_handle.emit("menu-home", ());
        } else if id == "go:token-dashboard" {
            let _ = app_handle.emit("menu-token-dashboard", ());
        } else if id == "file:new-session" {
            let _ = app_handle.emit("menu-new-session", ());
        } else if id == "file:reload" {
            let _ = app_handle.emit("menu-reload", ());
        } else if id == "file:archive-current" {
            let _ = app_handle.emit("menu-archive-current", ());
        } else if id == "app:check-updates" {
            let _ = app_handle.emit("menu-check-updates", ());
        } else if id == "window:always-on-top" {
            let checked = get_check_item(app_handle, "window:always-on-top").unwrap_or(false);
            if let Some(win) = app_handle.get_webview_window("main") {
                let _ = win.set_always_on_top(checked);
            }
        }
    });

    Ok(())
}

pub fn sync_menu_state(app: &AppHandle, theme: &str, terminal: &str, lang: &str, show_archived: bool) {
    let theme_id = format!("theme:{}", theme);
    for tid in &["theme:system", "theme:light", "theme:dark"] {
        set_check_item(app, tid, *tid == theme_id.as_str());
    }

    let term_id = format!("terminal:{}", terminal);
    for tid in &["terminal:Terminal", "terminal:iTerm", "terminal:Warp", "terminal:cmux", "terminal:Ghostty"] {
        set_check_item(app, tid, *tid == term_id.as_str());
    }

    let lang_id = format!("lang:{}", lang);
    for lid in &["lang:ja", "lang:en"] {
        set_check_item(app, lid, *lid == lang_id.as_str());
    }

    set_check_item(app, "toggle:archived", show_archived);
}
