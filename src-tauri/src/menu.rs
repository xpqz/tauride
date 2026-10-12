//! Native popup menus for the shim's Menu.popup() (RIDE's context menu).
//! Clicks come back to the webview as `ride-menu` events carrying the item
//! id; the shim runs the item's click handler or Electron role.

use serde::Deserialize;
use tauri::menu::{CheckMenuItemBuilder, IsMenuItem, Menu, MenuItemBuilder, MenuItemKind, PredefinedMenuItem, Submenu, SubmenuBuilder};
use tauri::{Emitter, Manager, Runtime, WebviewWindow};

#[derive(Deserialize)]
pub struct Item {
    id: String,
    #[serde(default)]
    label: String,
    /// "normal", "checkbox" or "separator".
    kind: String,
    #[serde(default)]
    checked: bool,
    #[serde(default = "yes")]
    enabled: bool,
    submenu: Option<Vec<Item>>,
    /// Electron accelerator, e.g. "Ctrl+C"; dropped if muda cannot parse it.
    accelerator: Option<String>,
    /// Electron role, honoured by the application menu only.
    role: Option<String>,
}

fn yes() -> bool {
    true
}

type Built<R> = Box<dyn IsMenuItem<R>>;

/// The system's own item for an Electron role, so macOS gets its standard
/// behaviour (Hide, clipboard, full screen) rather than a webview round trip.
fn predefined<R: Runtime, M: Manager<R>>(m: &M, role: Option<&str>) -> tauri::Result<Option<Built<R>>> {
    Ok(Some(match role {
        Some("hide") => Box::new(PredefinedMenuItem::hide(m, None)?),
        Some("hideothers") => Box::new(PredefinedMenuItem::hide_others(m, None)?),
        Some("unhide") => Box::new(PredefinedMenuItem::show_all(m, None)?),
        Some("togglefullscreen") => Box::new(PredefinedMenuItem::fullscreen(m, None)?),
        Some("cut") => Box::new(PredefinedMenuItem::cut(m, None)?),
        Some("copy") => Box::new(PredefinedMenuItem::copy(m, None)?),
        Some("paste") => Box::new(PredefinedMenuItem::paste(m, None)?),
        _ => return Ok(None),
    }))
}

fn build<R: Runtime, M: Manager<R>>(m: &M, items: &[Item]) -> tauri::Result<Vec<Built<R>>> {
    items
        .iter()
        .map(|it| -> tauri::Result<Built<R>> {
            // Electron marks access keys with &, muda with &: the same.
            Ok(match (it.kind.as_str(), &it.submenu) {
                ("separator", _) => Box::new(PredefinedMenuItem::separator(m)?),
                (_, Some(sub)) => {
                    let children = build(m, sub)?;
                    let refs: Vec<&dyn IsMenuItem<R>> = children.iter().map(|c| c.as_ref()).collect();
                    let s: Submenu<R> = SubmenuBuilder::with_id(m, &it.id, &it.label).enabled(it.enabled).items(&refs).build()?;
                    Box::new(s)
                }
                ("checkbox", _) => {
                    let mk = |acc: Option<&str>| {
                        let mut b = CheckMenuItemBuilder::with_id(&it.id, &it.label).checked(it.checked).enabled(it.enabled);
                        if let Some(a) = acc {
                            b = b.accelerator(a);
                        }
                        b.build(m)
                    };
                    Box::new(mk(it.accelerator.as_deref()).or_else(|_| mk(None))?)
                }
                _ => {
                    if let Some(p) = predefined(m, it.role.as_deref())? {
                        return Ok(p);
                    }
                    let mk = |acc: Option<&str>| {
                        let mut b = MenuItemBuilder::with_id(&it.id, &it.label).enabled(it.enabled);
                        if let Some(a) = acc {
                            b = b.accelerator(a);
                        }
                        b.build(m)
                    };
                    Box::new(mk(it.accelerator.as_deref()).or_else(|_| mk(None))?)
                }
            })
        })
        .collect()
}

#[tauri::command]
pub fn popup_menu<R: Runtime>(window: WebviewWindow<R>, items: Vec<Item>) -> Result<(), String> {
    let built = build(&window, &items).map_err(|e| e.to_string())?;
    let refs: Vec<&dyn IsMenuItem<R>> = built.iter().map(|c| c.as_ref()).collect();
    let menu = Menu::with_items(&window, &refs).map_err(|e| e.to_string())?;
    window.popup_menu(&menu).map_err(|e| e.to_string())
}

/// Electron's Menu.setApplicationMenu: the menu bar on macOS.
#[tauri::command]
pub fn set_app_menu<R: Runtime>(
    app: tauri::AppHandle<R>,
    window: WebviewWindow<R>,
    mut items: Vec<Item>,
) -> Result<(), String> {
    let Some(focused) = app.webview_windows().into_values()
        .find(|window| window.is_focused().unwrap_or(false)) else { return Ok(()); };
    if !owns_focused_window(window.label(), focused.label()) { return Ok(()); }
    let url = focused.url().map_err(|e| e.to_string())?;
    filter_edit_accelerators(&mut items, &url);
    let built = build(&app, &items).map_err(|e| e.to_string())?;
    let refs: Vec<&dyn IsMenuItem<R>> = built.iter().map(|c| c.as_ref()).collect();
    let menu = Menu::with_items(&app, &refs).map_err(|e| e.to_string())?;
    if !focused.is_focused().map_err(|e| e.to_string())? { return Ok(()); }
    app.set_menu(menu.clone()).map_err(|e| e.to_string())?;
    // macOS lists the open windows in its Window menu and adds its search
    // field to the Help menu. This must follow set_menu, which creates the
    // native menus.
    #[cfg(target_os = "macos")]
    for it in &items {
        if let Some(sub) = menu.get(&it.id).and_then(|k| k.as_submenu().cloned()) {
            match it.role.as_deref() {
                Some("window") => sub.set_as_windows_menu_for_nsapp().map_err(|e| e.to_string())?,
                Some("help") => sub.set_as_help_menu_for_nsapp().map_err(|e| e.to_string())?,
                _ => {}
            }
        }
    }
    Ok(())
}

fn restore_checkbox<R: Runtime>(items: Vec<MenuItemKind<R>>, id: &str) -> tauri::Result<bool> {
    for item in items {
        if item.id().as_ref() == id {
            if let Some(checkbox) = item.as_check_menuitem() {
                checkbox.set_checked(!checkbox.is_checked()?)?;
            }
            return Ok(true);
        }
        if let Some(submenu) = item.as_submenu() {
            if restore_checkbox(submenu.items()?, id)? { return Ok(true); }
        }
    }
    Ok(false)
}

fn is_session_page(url: &tauri::Url) -> bool {
    matches!(url.path(), "" | "/" | "/index.html")
        && url.query_pairs().find(|(key, _)| key == "type")
            .map(|(_, value)| value == "editor").unwrap_or(true)
}

fn owns_focused_window(owner: &str, focused: &str) -> bool {
    let owner = crate::win::id_of(owner);
    let focused = crate::win::id_of(focused);
    crate::win::is_session_window(owner)
        && crate::win::session_of(owner) == crate::win::session_of(focused)
}

fn allow_edit_accelerator(command: &str, url: &tauri::Url) -> bool {
    is_session_page(url) || (command == "SC" && matches!(url.path(), "/about.html" | "/log.html"))
}

fn filter_edit_accelerators(items: &mut [Item], url: &tauri::Url) {
    for item in items {
        if let Some(command) = focused_edit_command(&item.id) {
            if !allow_edit_accelerator(command, url) {
                item.enabled = false;
                item.accelerator = None;
            }
        }
        if let Some(children) = &mut item.submenu { filter_edit_accelerators(children, url); }
    }
}

fn focused_edit_command(id: &str) -> Option<&str> {
    if !id.starts_with("app:") { return None; }
    let command = id.rsplit(':').next()?;
    ["FX", "SI", "SC", "RP", "QCP", "TGC", "RD"].contains(&command).then_some(command)
}

/// App-wide menu event handler: forwards popup-menu clicks to the webviews.
pub fn on_event<R: Runtime>(app: &tauri::AppHandle<R>, id: &str) {
    if id.starts_with("app:") {
        if let Some(command) = ["AGC", "AGO", "TTB"].into_iter().find(|command| id.ends_with(&format!(":{command}"))) {
            let focused = app.webview_windows().into_values().find(|window| window.is_focused().unwrap_or(false));
            let eligible = focused.as_ref().and_then(|window| window.url().ok()).map(|url| {
                matches!(url.path(), "" | "/" | "/index.html")
                    && url.query_pairs().find(|(key, _)| key == "type")
                        .map(|(_, value)| value == "editor").unwrap_or(true)
            }).unwrap_or(false);
            if eligible {
                if let Some(window) = focused {
                    let _ = window.emit_to(window.label(), "ride-session-menu", command);
                }
            } else if let Some(menu) = app.menu() {
                if let Ok(items) = menu.items() { let _ = restore_checkbox(items, id); }
            }
            return;
        }
    }
    if id.starts_with("app:") && id.ends_with(":CVH") {
        for window in app.webview_windows().into_values() {
            if window.is_focused().unwrap_or(false) {
                if let Ok(url) = window.url() {
                    let session_page = matches!(url.path(), "" | "/" | "/index.html")
                        && url.query_pairs().find(|(key, _)| key == "type")
                            .map(|(_, value)| value == "editor").unwrap_or(true);
                    if session_page {
                        let _ = window.emit_to(window.label(), "ride-clear-visible-history", ());
                    }
                }
                break;
            }
        }
        return;
    }
    if id.starts_with("app:") {
        if let Some(command) = ["SC", "SA"].into_iter().find(|command| id.ends_with(&format!(":{command}"))) {
            for window in app.webview_windows().into_values() {
                if window.is_focused().unwrap_or(false) {
                    if let Ok(url) = window.url() {
                        if matches!(url.path(), "/about.html" | "/log.html") {
                            let _ = window.emit_to(window.label(), "ride-diagnostic-menu", command);
                            return;
                        }
                        if command == "SA" && url.query_pairs().any(|(key, value)| key == "type" && value == "prf") {
                            let _ = window.emit_to(window.label(), "ride-preferences-select-all", ());
                            return;
                        }
                    }
                }
            }
        }
    }
    if let Some(command) = focused_edit_command(id) {
        if let Some(window) = app.webview_windows().into_values()
            .find(|window| window.is_focused().unwrap_or(false)) {
            if window.url().map(|url| is_session_page(&url)).unwrap_or(false) {
                let _ = window.emit_to(window.label(), "ride-session-menu", command);
            }
        }
        return;
    }
    if id.starts_with("ctx:") || id.starts_with("app:") {
        let _ = app.emit("ride-menu", id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configurable_editing_and_interrupt_commands_route_independently_of_menu_owner() {
        for code in ["FX", "SI", "SC", "RP", "QCP", "TGC", "RD"] {
            for owner in ["main", "w1000001", "w1000012"] {
                assert_eq!(focused_edit_command(&format!("app:{owner}:7:3:2:{code}")), Some(code));
            }
        }
        assert_eq!(focused_edit_command("ctx:7:3:FX"), None);
        assert_eq!(focused_edit_command("app:main:1:2:PRF"), None);
    }

    #[test]
    fn owning_main_installs_the_menu_for_its_floating_and_helper_windows() {
        for focused in ["main", "w12", "w50"] { assert!(owns_focused_window("main", focused)); }
        assert!(owns_focused_window("w1000001", "w1000012"));
        assert!(!owns_focused_window("main", "w1000001"));
        assert!(!owns_focused_window("w1000001", "w12"));
        assert!(!owns_focused_window("w12", "w12"));
    }

    #[test]
    fn helpers_release_contextual_accelerators_but_preserve_diagnostic_find() {
        let preferences = tauri::Url::parse("http://tauri.localhost/index.html?type=prf").unwrap();
        let diagnostic = tauri::Url::parse("http://tauri.localhost/about.html").unwrap();
        let session = tauri::Url::parse("http://tauri.localhost/index.html?type=editor").unwrap();
        for command in ["FX", "SI", "SC", "RP", "QCP", "TGC", "RD"] {
            assert!(!allow_edit_accelerator(command, &preferences));
            assert_eq!(allow_edit_accelerator(command, &diagnostic), command == "SC");
            assert!(allow_edit_accelerator(command, &session));
        }
    }

    #[test]
    fn editing_commands_accept_session_and_floating_pages_and_reject_helpers() {
        for url in ["http://tauri.localhost/", "http://tauri.localhost/index.html",
            "http://tauri.localhost/index.html?type=editor&winId=12"] {
            assert!(is_session_page(&tauri::Url::parse(url).unwrap()));
        }
        for url in ["http://tauri.localhost/index.html?type=prf", "http://tauri.localhost/about.html",
            "http://tauri.localhost/log.html", "http://tauri.localhost/status.html",
            "http://tauri.localhost/dialog.html"] {
            assert!(!is_session_page(&tauri::Url::parse(url).unwrap()));
        }
    }
}
