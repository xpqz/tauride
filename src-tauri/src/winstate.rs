//! winstate.json: theme and window geometry, ported from Electron RIDE's
//! main.js. The main window opens with the launch page's geometry, switches
//! to the main page's on the renderer's `save-win`, and saves its content
//! bounds (throttled to 2s) under whichever page is showing.

use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

pub struct WinState {
    db: Mutex<Value>,
    on_launch_page: AtomicBool,
    save_pending: AtomicBool,
}

fn file() -> PathBuf {
    let name = std::env::var("RIDE_CONF").unwrap_or_else(|_| "winstate".into());
    crate::user_data_dir().join(format!("{name}.json"))
}

impl WinState {
    pub fn load() -> Self {
        let mut db: Value = std::fs::read_to_string(file())
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({}));
        if db.get("theme").is_none() {
            db["theme"] = json!("light");
        }
        if db.get("launchWin").is_none() {
            db["launchWin"] = json!({ "expandedWidth": 900, "width": 400, "height": 400, "expanded": false });
        }
        if db.get("mainWin").is_none() {
            db["mainWin"] = json!({ "width": 800, "height": 600 });
        }
        WinState { db: Mutex::new(db), on_launch_page: AtomicBool::new(true), save_pending: AtomicBool::new(false) }
    }

    pub fn get(&self) -> Value {
        self.db.lock().unwrap().clone()
    }

    pub fn set(&self, key: &str, value: Value) {
        self.db.lock().unwrap()[key] = value;
        self.write();
    }

    fn write(&self) {
        let db = self.db.lock().unwrap();
        if let Err(e) = std::fs::write(file(), serde_json::to_vec(&*db).unwrap()) {
            eprintln!("ride: cannot save {}: {e}", file().display());
        }
    }
}

/// Saved geometry for `page`: (position, width, height). A position that is
/// now mostly off screen is dropped and the size clamped to the screen.
pub fn restore<R: Runtime>(app: &AppHandle<R>, page: &str) -> (Option<(f64, f64)>, f64, f64) {
    let db = app.state::<WinState>().get();
    let p = &db[page];
    let num = |k: &str| p.get(k).and_then(Value::as_f64);
    let mut width = num("width").unwrap_or(800.0);
    let height = num("height").unwrap_or(600.0);
    if page == "launchWin" && p.get("expanded").and_then(Value::as_bool).unwrap_or(false) {
        width = num("expandedWidth").unwrap_or(width);
    }
    let pos = num("x").zip(num("y"));
    let screen = app.primary_monitor().ok().flatten().map(|m| {
        let s = m.scale_factor();
        let a = m.work_area();
        (a.position.x as f64 / s, a.position.y as f64 / s, a.size.width as f64 / s, a.size.height as f64 / s)
    });
    match (pos, screen) {
        (Some((x, y)), Some((bx, by, bw, bh))) => {
            let vw = ((x + width).min(bx + bw) - x.max(bx)).max(0.0);
            let vh = ((y + height).min(by + bh) - y.max(by)).max(0.0);
            if width * height > 2.0 * vw * vh {
                (None, width.min(bw), height.min(bh))
            } else {
                (Some((x, y)), width, height)
            }
        }
        (pos, _) => (pos, width, height),
    }
}

pub fn apply<R: Runtime>(w: &WebviewWindow<R>, geometry: (Option<(f64, f64)>, f64, f64)) {
    let (pos, width, height) = geometry;
    let _ = w.set_size(tauri::LogicalSize::new(width, height));
    if let Some((x, y)) = pos {
        let _ = w.set_position(tauri::LogicalPosition::new(x, y));
    }
}

pub fn save_now<R: Runtime>(app: &AppHandle<R>) {
    let Some(w) = app.get_webview_window("main") else { return };
    let ws = app.state::<WinState>();
    let on_launch = ws.on_launch_page.load(Ordering::Relaxed);
    let page = if on_launch { "launchWin" } else { "mainWin" };
    let (Ok(scale), Ok(pos), Ok(size)) = (w.scale_factor(), w.inner_position(), w.inner_size()) else { return };
    let pos = pos.to_logical::<f64>(scale);
    let size = size.to_logical::<f64>(scale);
    {
        let mut db = ws.db.lock().unwrap();
        let expanded = db["launchWin"].get("expanded").and_then(Value::as_bool).unwrap_or(false);
        if !db[page].is_object() {
            db[page] = json!({});
        }
        let win = &mut db[page];
        win["x"] = json!(pos.x);
        win["y"] = json!(pos.y);
        if !on_launch || !expanded {
            win["width"] = json!(size.width);
        } else {
            win["expandedWidth"] = json!(size.width);
        }
        win["height"] = json!(size.height);
        win["maximized"] = json!(w.is_maximized().unwrap_or(false));
        db["devTools"] = json!(w.is_devtools_open());
    }
    ws.write();
}

/// Moves and resizes save at most every two seconds.
pub fn schedule_save<R: Runtime>(app: &AppHandle<R>) {
    let ws = app.state::<WinState>();
    if ws.save_pending.swap(true, Ordering::Relaxed) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        app.state::<WinState>().save_pending.store(false, Ordering::Relaxed);
        save_now(&app);
    });
}

/// The renderer's ipcRenderer.send('save-win', onLaunch): save, and on a
/// switch between the launch page and a session restore the main page's
/// geometry, as main.js did.
#[tauri::command]
pub fn save_win<R: Runtime>(app: AppHandle<R>, on_launch: bool) {
    schedule_save(&app);
    let ws = app.state::<WinState>();
    if ws.on_launch_page.swap(on_launch, Ordering::Relaxed) != on_launch {
        if let Some(w) = app.get_webview_window("main") {
            apply(&w, restore(&app, "mainWin"));
            if ws.get()["mainWin"].get("maximized").and_then(Value::as_bool).unwrap_or(false) {
                let _ = w.maximize();
            }
        }
    }
}
