//! Windows behind the shim's BrowserWindow. RIDE addresses windows by
//! Electron's numeric ids (BrowserWindow.fromId, ids passed between windows),
//! so each window gets one: the main window is 1 (label "main"), the rest
//! "w<id>" in creation order.

use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU32, Ordering};
use tauri::{AppHandle, Emitter, Manager, Runtime, Url, WebviewUrl, WebviewWindow, WindowEvent};

static NEXT_ID: AtomicU32 = AtomicU32::new(2);

pub fn label_of(id: u32) -> String {
    if id == 1 { "main".into() } else { format!("w{id}") }
}

pub fn id_of(label: &str) -> u32 {
    if label == "main" { 1 } else { label.trim_start_matches('w').parse().unwrap_or(0) }
}

pub fn alloc() -> u32 {
    NEXT_ID.fetch_add(1, Ordering::Relaxed)
}

/// The subset of Electron's BrowserWindow options RIDE passes.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct WinOpts {
    width: Option<f64>,
    height: Option<f64>,
    x: Option<f64>,
    y: Option<f64>,
    min_width: Option<f64>,
    min_height: Option<f64>,
    show: Option<bool>,
    resizable: Option<bool>,
    title: Option<String>,
    parent: Option<u32>,
}

/// When each window last had a close request held back for its page.
static CLOSE_REQUESTS: std::sync::Mutex<Vec<(u32, std::time::Instant)>> = std::sync::Mutex::new(Vec::new());

/// A close request (window manager, BrowserWindow.close()) goes to the page
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

/// Forwards window events to every window's shim, which dispatches them to
/// the matching BrowserWindow objects.
pub fn watch<R: Runtime>(w: &WebviewWindow<R>) {
    let app = w.app_handle().clone();
    let id = id_of(w.label());
    w.on_window_event(move |e| {
        if let WindowEvent::CloseRequested { api, .. } = e {
            if hold_close_for_page(id) {
                api.prevent_close();
                let _ = app.emit("ride-close-request", json!({ "id": id }));
            }
        }
        let name = match e {
            WindowEvent::Destroyed => "closed",
            WindowEvent::CloseRequested { .. } => "close",
            WindowEvent::Focused(true) => "focus",
            WindowEvent::Focused(false) => "blur",
            WindowEvent::Resized(_) => "resize",
            WindowEvent::Moved(_) => "move",
            _ => return,
        };
        let _ = app.emit("ride-win", json!({ "id": id, "event": name }));
        if id == 1 {
            match e {
                WindowEvent::Moved(_) | WindowEvent::Resized(_) => crate::winstate::schedule_save(&app),
                WindowEvent::CloseRequested { .. } => crate::winstate::save_now(&app),
                _ => {}
            }
        }
        // RIDE's helper windows (prefs, dialog, status, floating editors)
        // were children of the main window under Electron and closed with
        // it; here the app exits when the main window goes.
        if id == 1 && matches!(e, WindowEvent::Destroyed) {
            app.exit(0);
        }
    });
}

fn window<R: Runtime>(app: &AppHandle<R>, id: u32) -> Result<WebviewWindow<R>, String> {
    app.get_webview_window(&label_of(id)).ok_or_else(|| format!("no window {id}"))
}

/// `url` is relative to the app root ("index.html?type=prf&appid=..."); the
/// shim strips the file:// and tauri:// forms RIDE builds. Async, as building
/// a window from a synchronous command deadlocks on Windows.
#[tauri::command]
pub async fn win_create<R: Runtime>(app: AppHandle<R>, id: u32, url: String, opts: WinOpts) -> Result<(), String> {
    let base = app
        .get_webview_window("main")
        .and_then(|m| m.url().ok())
        .ok_or("no main window")?;
    let rel = url;
    let url: Url = base.join(&rel).map_err(|e| e.to_string())?;
    if std::env::var_os("RIDE_TAURI_DEBUG").is_some() {
        eprintln!("[win_create] id {id}: {rel:?} against {base} -> {url}");
    }
    let mut b = crate::window_builder(&app, &label_of(id), WebviewUrl::CustomProtocol(url))
        .visible(opts.show.unwrap_or(true))
        .resizable(opts.resizable.unwrap_or(true))
        .title(opts.title.unwrap_or_else(|| "Ride".into()));
    if let (Some(w), Some(h)) = (opts.width, opts.height) {
        b = b.inner_size(w, h);
    }
    if let (Some(w), Some(h)) = (opts.min_width, opts.min_height) {
        b = b.min_inner_size(w, h);
    }
    if let (Some(x), Some(y)) = (opts.x, opts.y) {
        b = b.position(x, y);
    }
    if let Some(p) = opts.parent.and_then(|p| window(&app, p).ok()) {
        #[cfg(target_os = "linux")]
        {
            b = b.transient_for(&p).map_err(|e| e.to_string())?;
        }
        #[cfg(not(target_os = "linux"))]
        {
            b = b.parent(&p).map_err(|e| e.to_string())?;
        }
    }
    let w = b.build().map_err(|e| e.to_string())?;
    watch(&w);
    Ok(())
}

fn num(a: &Value, k: &str) -> Option<f64> {
    a.get(k).and_then(Value::as_f64)
}

/// Asynchronous BrowserWindow methods.
#[tauri::command]
pub fn win_call<R: Runtime>(app: AppHandle<R>, id: u32, method: String, args: Value) -> Result<(), String> {
    let w = match window(&app, id) {
        Ok(w) => w,
        Err(_) if matches!(method.as_str(), "close" | "destroy") => return Ok(()),
        Err(e) => return Err(e),
    };
    let r = match method.as_str() {
        "show" => w.show().and_then(|_| w.set_focus()),
        "showInactive" => w.show(),
        "hide" => w.hide(),
        "focus" => w.set_focus(),
        "close" => w.close(),
        "destroy" => w.destroy(),
        "minimize" => w.minimize(),
        "maximize" => w.maximize(),
        "unmaximize" => w.unmaximize(),
        "setFullScreen" => w.set_fullscreen(args.get("flag").and_then(Value::as_bool).unwrap_or(false)),
        "setTitle" => w.set_title(args.get("title").and_then(Value::as_str).unwrap_or("")),
        "setAlwaysOnTop" => w.set_always_on_top(args.get("flag").and_then(Value::as_bool).unwrap_or(false)),
        "setResizable" => w.set_resizable(args.get("flag").and_then(Value::as_bool).unwrap_or(true)),
        "center" => w.center(),
        "setSize" | "setContentSize" => match (num(&args, "width"), num(&args, "height")) {
            (Some(wd), Some(ht)) => w.set_size(tauri::LogicalSize::new(wd, ht)),
            _ => Ok(()),
        },
        "setMinimumSize" => match (num(&args, "width"), num(&args, "height")) {
            (Some(wd), Some(ht)) => w.set_min_size(Some(tauri::LogicalSize::new(wd, ht))),
            _ => Ok(()),
        },
        "setPosition" => match (num(&args, "x"), num(&args, "y")) {
            (Some(x), Some(y)) => w.set_position(tauri::LogicalPosition::new(x, y)),
            _ => Ok(()),
        },
        "setBounds" | "setContentBounds" => {
            let mut r = Ok(());
            if let (Some(x), Some(y)) = (num(&args, "x"), num(&args, "y")) {
                r = w.set_position(tauri::LogicalPosition::new(x, y));
            }
            if let (Some(wd), Some(ht)) = (num(&args, "width"), num(&args, "height")) {
                r = r.and_then(|_| w.set_size(tauri::LogicalSize::new(wd, ht)));
            }
            r
        }
        "eval" => w.eval(args.get("js").and_then(Value::as_str).unwrap_or("")),
        "navigate" => {
            let rel = args.get("url").and_then(Value::as_str).unwrap_or("index.html");
            let base = w.url().map_err(|e| e.to_string())?;
            let url = base.join(rel).map_err(|e| e.to_string())?;
            w.navigate(url)
        }
        "print" => w.print(),
        "toggleDevTools" => {
            if w.is_devtools_open() { w.close_devtools() } else { w.open_devtools() }
            Ok(())
        }
        _ => return Err(format!("unknown window method {method}")),
    };
    r.map_err(|e| e.to_string())
}

/// Synchronous BrowserWindow getters, for the ridesync:// scheme. Bounds are
/// logical pixels, Electron's DIPs.
pub fn get<R: Runtime>(app: &AppHandle<R>, a: &Value) -> crate::sync::Result {
    let id = a.get("id").and_then(Value::as_u64).unwrap_or(0) as u32;
    let prop = a.get("prop").and_then(Value::as_str).unwrap_or("");
    let w = match window(app, id) {
        Ok(w) => w,
        Err(_) if prop == "exists" => return Ok(Value::from(false)),
        Err(e) => return Err(crate::sync::err("ENOENT", e)),
    };
    let e = |e: tauri::Error| crate::sync::err("EIO", e.to_string());
    let scale = w.scale_factor().map_err(e)?;
    Ok(match prop {
        "exists" => Value::from(true),
        "focused" => Value::from(w.is_focused().map_err(e)?),
        "visible" => Value::from(w.is_visible().map_err(e)?),
        "maximized" => Value::from(w.is_maximized().map_err(e)?),
        "minimized" => Value::from(w.is_minimized().map_err(e)?),
        "fullScreen" => Value::from(w.is_fullscreen().map_err(e)?),
        "title" => Value::from(w.title().map_err(e)?),
        "bounds" | "contentBounds" => {
            let pos = if prop == "bounds" { w.outer_position() } else { w.inner_position() }.map_err(e)?.to_logical::<f64>(scale);
            let size = if prop == "bounds" { w.outer_size() } else { w.inner_size() }.map_err(e)?.to_logical::<f64>(scale);
            json!({ "x": pos.x, "y": pos.y, "width": size.width, "height": size.height })
        }
        "focusedId" => Value::from(
            app.webview_windows().values().find(|w| w.is_focused().unwrap_or(false)).map(|w| id_of(w.label())),
        ),
        "allIds" => Value::from(app.webview_windows().keys().map(|l| id_of(l)).collect::<Vec<_>>()),
        _ => return Err(crate::sync::err("EINVAL", format!("unknown window property {prop}"))),
    })
}
