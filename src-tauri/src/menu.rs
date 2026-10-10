//! Native popup menus for the shim's Menu.popup() (RIDE's context menu).
//! Clicks come back to the webview as `ride-menu` events carrying the item
//! id; the shim runs the item's click handler or Electron role.

use serde::Deserialize;
use tauri::menu::{CheckMenuItemBuilder, IsMenuItem, Menu, MenuItemBuilder, PredefinedMenuItem, Submenu, SubmenuBuilder};
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
pub fn set_app_menu<R: Runtime>(app: tauri::AppHandle<R>, items: Vec<Item>) -> Result<(), String> {
    let built = build(&app, &items).map_err(|e| e.to_string())?;
    let refs: Vec<&dyn IsMenuItem<R>> = built.iter().map(|c| c.as_ref()).collect();
    let menu = Menu::with_items(&app, &refs).map_err(|e| e.to_string())?;
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

/// App-wide menu event handler: forwards popup-menu clicks to the webviews.
pub fn on_event<R: Runtime>(app: &tauri::AppHandle<R>, id: &str) {
    if id.starts_with("app:") {
        if let Some(command) = ["SC", "SA"].into_iter().find(|command| id.ends_with(&format!(":{command}"))) {
            for window in app.webview_windows().into_values() {
                if window.is_focused().unwrap_or(false)
                    && window.url().map(|url| matches!(url.path(), "/about.html" | "/log.html")).unwrap_or(false)
                {
                    let _ = window.emit_to(window.label(), "ride-diagnostic-menu", command);
                    return;
                }
            }
        }
    }
    if id.starts_with("ctx:") || id.starts_with("app:") {
        let _ = app.emit("ride-menu", id);
    }
}
