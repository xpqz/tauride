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
}

fn yes() -> bool {
    true
}

type Built<R> = Box<dyn IsMenuItem<R>>;

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
                ("checkbox", _) => Box::new(
                    CheckMenuItemBuilder::with_id(&it.id, &it.label).checked(it.checked).enabled(it.enabled).build(m)?,
                ),
                _ => Box::new(MenuItemBuilder::with_id(&it.id, &it.label).enabled(it.enabled).build(m)?),
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

/// App-wide menu event handler: forwards popup-menu clicks to the webviews.
pub fn on_event<R: Runtime>(app: &tauri::AppHandle<R>, id: &str) {
    if id.starts_with("ctx:") {
        let _ = app.emit("ride-menu", id);
    }
}
