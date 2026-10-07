//! Tauride's windows. The pages create and drive them through Tauri's JS
//! window API (src/wm.js); this module adds what every window needs from
//! the Rust side, and the few operations that API lacks. A window's label is
//! "main" for the main window and "w<id>" for the others, as RIDE passes
//! numeric window ids between windows.

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, Runtime, Window, WindowEvent};

pub fn label_of(id: u32) -> String {
    if id == 1 { "main".into() } else { format!("w{id}") }
}

pub fn id_of(label: &str) -> u32 {
    if label == "main" { 1 } else { label.trim_start_matches('w').parse().unwrap_or(0) }
}

/// When each window last had a close request held back for its page.
static CLOSE_REQUESTS: std::sync::Mutex<Vec<(u32, std::time::Instant)>> = std::sync::Mutex::new(Vec::new());

/// A close request (window manager, a page's close()) goes to the page
/// first, as Electron runs beforeunload: the shim's window.close() runs
/// RIDE's onbeforeunload, which may cancel (to confirm quitting a session)
/// or let the window be destroyed. A second request within three seconds
/// closes regardless, so a page that does not answer cannot hold the
/// window open.
fn hold_close_for_page(id: u32) -> bool {
    let mut held = CLOSE_REQUESTS.lock().unwrap();
    let now = std::time::Instant::now();
    held.retain(|(_, t)| now.duration_since(*t) < std::time::Duration::from_secs(3));
    if held.iter().any(|(i, _)| *i == id) {
        return false;
    }
    held.push((id, now));
    true
}

/// Every window, however it was created: close requests go to the page
/// first, the main window's geometry is saved, and the app exits with the
/// main window.
pub fn watch<R: Runtime>(w: &Window<R>) {
    let app = w.app_handle().clone();
    let id = id_of(w.label());
    w.on_window_event(move |e| {
        if let WindowEvent::CloseRequested { api, .. } = e {
            if hold_close_for_page(id) {
                api.prevent_close();
                let _ = app.emit("ride-close-request", json!({ "id": id }));
            }
        }
        if id != 1 {
            return;
        }
        match e {
            WindowEvent::Moved(_) | WindowEvent::Resized(_) => crate::winstate::schedule_save(&app),
            WindowEvent::CloseRequested { .. } => crate::winstate::save_now(&app),
            // RIDE's helper windows (prefs, dialog, status, floating editors)
            // were children of the main window under Electron and closed
            // with it; here the app exits when the main window goes.
            WindowEvent::Destroyed => app.exit(0),
            _ => {}
        }
    });
}

/// What Tauri's JS window API cannot do to another window: run a script in
/// it, print it, toggle its devtools, or point it at another URL (relative
/// to its current one).
#[tauri::command]
pub fn win_op<R: Runtime>(app: AppHandle<R>, label: String, op: String, arg: Option<String>) -> Result<(), String> {
    let w = app.get_webview_window(&label).ok_or_else(|| format!("no window {label}"))?;
    let arg = arg.unwrap_or_default();
    let r = match op.as_str() {
        "eval" => w.eval(&arg),
        "print" => w.print(),
        "toggleDevTools" => {
            if w.is_devtools_open() { w.close_devtools() } else { w.open_devtools() }
            Ok(())
        }
        "navigate" => {
            let url = w.url().map_err(|e| e.to_string())?.join(&arg).map_err(|e| e.to_string())?;
            w.navigate(url)
        }
        _ => return Err(format!("unknown window operation {op}")),
    };
    r.map_err(|e| e.to_string())
}
