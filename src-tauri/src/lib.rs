mod dialog;
mod net;
mod proc;
mod sync;
mod win;
mod winstate;

use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::http::{Request, Response};
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

const SHIM: &str = include_str!("../../tauri/shim.js");

#[tauri::command]
fn log(level: String, msg: String) {
    eprintln!("[webview {level}] {msg}");
}

/// shell.openExternal: hand a URL or path to the desktop's opener.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    let mut cmd = std::process::Command::new("xdg-open");
    #[cfg(target_os = "macos")]
    let mut cmd = std::process::Command::new("open");
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "start", ""]);
        c
    };
    cmd.arg(&url).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Electron's app.getPath('userData') for this product, so the Tauri build
/// shares prefs.json, connections.json and winstate.json with Electron RIDE.
pub fn user_data_dir() -> PathBuf {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
        .unwrap_or_else(std::env::temp_dir);
    base.join("Ride-4.8")
}

fn network_interfaces() -> Value {
    let mut by_name = serde_json::Map::new();
    for iface in if_addrs::get_if_addrs().unwrap_or_default() {
        let family = if iface.ip().is_ipv4() { "IPv4" } else { "IPv6" };
        let entry = json!({ "address": iface.ip().to_string(), "family": family, "internal": iface.is_loopback() });
        by_name
            .entry(iface.name.clone())
            .or_insert_with(|| Value::Array(vec![]))
            .as_array_mut()
            .unwrap()
            .push(entry);
    }
    Value::Object(by_name)
}

/// Everything RIDE reads synchronously at startup, injected before any page
/// script runs.
fn init_payload() -> Value {
    let env: serde_json::Map<String, Value> =
        std::env::vars().map(|(k, v)| (k, Value::from(v))).collect();
    let user_data = user_data_dir();
    let _ = std::fs::create_dir_all(&user_data);
    json!({
        "env": env,
        "argv": std::env::args().collect::<Vec<_>>(),
        "pid": std::process::id(),
        "platform": std::env::consts::OS,
        "arch": if cfg!(target_arch = "x86_64") { "x64" } else { std::env::consts::ARCH },
        "cwd": std::env::current_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
        "paths": {
            "home": std::env::var("HOME").unwrap_or_default(),
            "temp": std::env::temp_dir().to_string_lossy(),
            "userData": user_data.to_string_lossy(),
            "exe": std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
        },
        "locale": std::env::var("LC_ALL").or_else(|_| std::env::var("LANG")).unwrap_or_else(|_| "en_US".into()),
        "networkInterfaces": network_interfaces(),
        "versions": { "tauri": tauri::VERSION },
    })
}

/// Every RIDE window gets the startup payload and the shim ahead of its own
/// scripts.
pub fn window_builder<'a, R: Runtime, M: Manager<R>>(
    manager: &'a M,
    label: &str,
    url: WebviewUrl,
) -> WebviewWindowBuilder<'a, R, M> {
    let script = format!("window.__RIDE__ = {};\n{}", init_payload(), SHIM);
    WebviewWindowBuilder::new(manager, label, url)
        .title("Ride")
        .initialization_script(&script)
}

fn sync_args(req: &Request<Vec<u8>>) -> Value {
    if !req.body().is_empty() {
        return serde_json::from_slice(req.body()).unwrap_or(Value::Null);
    }
    req.uri()
        .query()
        .and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("a=")))
        .map(|a| percent_encoding::percent_decode_str(a).decode_utf8_lossy().into_owned())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null)
}

fn sync_dispatch<R: Runtime>(app: &AppHandle<R>, path: &str, args: &Value) -> sync::Result {
    let mut parts = path.trim_start_matches('/').splitn(2, '/');
    match (parts.next(), parts.next()) {
        (Some("fs"), Some(op)) => sync::fs_op(op, args),
        (Some("dialog"), Some("message")) => dialog::message(app, args),
        (Some("dialog"), Some("file")) => dialog::file(app, args),
        (Some("win"), Some("alloc")) => Ok(Value::from(win::alloc())),
        (Some("win"), Some("get")) => win::get(app, args),
        (Some("winstate"), Some("get")) => Ok(app.state::<winstate::WinState>().get()),
        (Some("winstate"), Some("set")) => {
            let key = args.get("key").and_then(Value::as_str).ok_or_else(|| sync::err("EINVAL", "missing key"))?;
            app.state::<winstate::WinState>().set(key, args.get("value").cloned().unwrap_or(Value::Null));
            Ok(Value::Null)
        }
        _ => Err(sync::err("ENOSYS", format!("unknown sync op {path}"))),
    }
}

pub fn run() {
    tauri::Builder::default()
        .register_uri_scheme_protocol("ridesync", |ctx, req| {
            let body = match sync_dispatch(ctx.app_handle(), req.uri().path(), &sync_args(&req)) {
                Ok(v) => json!({ "ok": v }),
                Err(e) => json!({ "err": e }),
            };
            Response::builder()
                .header("Content-Type", "application/json")
                .header("Access-Control-Allow-Origin", "*")
                .body(serde_json::to_vec(&body).unwrap())
                .unwrap()
        })
        .manage(winstate::WinState::load())
        .manage(net::Net::default())
        .manage(proc::Procs::default())
        .invoke_handler(tauri::generate_handler![
            log,
            open_url,
            win::win_create,
            win::win_call,
            net::net_connect,
            net::net_write,
            net::net_end,
            net::net_listen,
            net::net_close_server,
            proc::proc_spawn,
            proc::proc_kill,
            winstate::save_win,
        ])
        .setup(|app| {
            let (pos, width, height) = winstate::restore(app.handle(), "launchWin");
            let mut b = window_builder(app.handle(), "main", WebviewUrl::App("index.html".into()))
                .inner_size(width, height)
                .background_color(tauri::window::Color(0x76, 0x88, 0xd9, 0xff));
            if let Some((x, y)) = pos {
                b = b.position(x, y);
            }
            let main = b.build()?;
            if app.state::<winstate::WinState>().get()["devTools"].as_bool().unwrap_or(false) {
                main.open_devtools();
            }
            win::watch(&main);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Ride");
}
