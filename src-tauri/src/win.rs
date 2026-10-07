//! Tauride's windows. The pages create and drive them through Tauri's JS
//! window API (src/wm.js); this module adds what every window needs from
//! the Rust side, and the few operations that API lacks.
//!
//! One process runs any number of sessions, each in its own window with its
//! own helper windows (preferences, dialog, status, floating editors). A
//! window's id says which session it belongs to: session k owns the ids
//! k * SESSION_SPAN + 1 (its session window) and up. The label is "main"
//! for id 1, the first session's window, and "w<id>" otherwise, as RIDE
//! passes numeric window ids between windows.

use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder, Window, WindowEvent};

pub const SESSION_SPAN: u32 = 1_000_000;

pub fn label_of(id: u32) -> String {
    if id == 1 { "main".into() } else { format!("w{id}") }
}

pub fn id_of(label: &str) -> u32 {
    if label == "main" { 1 } else { label.trim_start_matches('w').parse().unwrap_or(0) }
}

fn session_of(id: u32) -> u32 {
    id / SESSION_SPAN
}

fn is_session_window(id: u32) -> bool {
    id % SESSION_SPAN == 1
}

/// The next session's number; the first session (0) opens at startup.
static NEXT_SESSION: AtomicU32 = AtomicU32::new(1);

/// Environment overrides for each session window, as Electron RIDE passed
/// them to the process it spawned for a new session.
static SESSION_ENV: Mutex<Option<HashMap<String, Map<String, Value>>>> = Mutex::new(None);

/// The environment overrides for a session window, for the shim (sync op).
pub fn session_env(label: &str) -> Value {
    SESSION_ENV.lock().unwrap().as_ref().and_then(|m| m.get(label).cloned()).map(Value::Object).unwrap_or(Value::Null)
}

/// A session window: the first is built at startup, the others by
/// open_session.
pub fn session_window<R: Runtime, M: Manager<R>>(manager: &M, label: &str) -> tauri::Result<tauri::WebviewWindow<R>> {
    let (pos, width, height) = crate::winstate::restore(manager.app_handle(), "launchWin");
    let mut b = WebviewWindowBuilder::new(manager, label, WebviewUrl::App("index.html".into()))
        .title("Tauride")
        .inner_size(width, height);
    // macOS paints this behind the title bar too.
    #[cfg(not(target_os = "macos"))]
    {
        b = b.background_color(tauri::window::Color(0x76, 0x88, 0xd9, 0xff));
    }
    if let Some((x, y)) = pos {
        // Later sessions cascade from the saved position.
        let k = f64::from(session_of(id_of(label)) % 8) * 30.0;
        b = b.position(x + k, y + k);
    }
    b.build()
}

/// A new session in its own window. `env` overrides the startup
/// environment for that window, so RIDE_SPAWN, RIDE_CONNECT, RIDE_LISTEN
/// and the like say what the session does, as for a spawned RIDE.
pub fn open_session<R: Runtime>(app: &AppHandle<R>, env: Map<String, Value>) -> Result<u32, String> {
    let id = NEXT_SESSION.fetch_add(1, Ordering::Relaxed) * SESSION_SPAN + 1;
    let label = label_of(id);
    SESSION_ENV.lock().unwrap().get_or_insert_with(HashMap::new).insert(label.clone(), env);
    session_window(app, &label).map_err(|e| e.to_string())?;
    Ok(id)
}

/// Async, as building a window from a synchronous command deadlocks on
/// Windows.
#[tauri::command]
pub async fn session_new<R: Runtime>(app: AppHandle<R>, env: Map<String, Value>) -> Result<u32, String> {
    open_session(&app, env)
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
/// first, session windows' geometry is saved, a session's helper windows
/// close with its session window (as Electron children close with their
/// parent), and the app exits with the last session window.
pub fn watch<R: Runtime>(w: &Window<R>) {
    let app = w.app_handle().clone();
    let label = w.label().to_owned();
    let id = id_of(&label);
    w.on_window_event(move |e| {
        if let WindowEvent::CloseRequested { api, .. } = e {
            if hold_close_for_page(id) {
                api.prevent_close();
                let _ = app.emit("ride-close-request", json!({ "id": id }));
            }
        }
        if !is_session_window(id) {
            return;
        }
        match e {
            WindowEvent::Moved(_) | WindowEvent::Resized(_) => crate::winstate::schedule_save(&app, &label),
            WindowEvent::CloseRequested { .. } => crate::winstate::save_now(&app, &label),
            WindowEvent::Destroyed => {
                if let Some(m) = SESSION_ENV.lock().unwrap().as_mut() {
                    m.remove(&label);
                }
                let others = app.webview_windows();
                for (l, ww) in &others {
                    let i = id_of(l);
                    if i != id && session_of(i) == session_of(id) {
                        let _ = ww.destroy();
                    }
                }
                if !others.keys().any(|l| *l != label && is_session_window(id_of(l))) {
                    app.exit(0);
                }
            }
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
