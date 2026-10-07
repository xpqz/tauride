mod dialog;
mod menu;
mod net;
mod proc;
mod ssh;
mod sync;
mod win;
mod winstate;

use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::http::{Request, Response};
use tauri::{AppHandle, Emitter, Manager, Runtime};

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
    #[cfg(windows)]
    let base = std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    #[cfg(not(windows))]
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
            "home": std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_default(),
            "temp": std::env::temp_dir().to_string_lossy(),
            "userData": user_data.to_string_lossy(),
            "exe": std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
        },
        "locale": std::env::var("LC_ALL").or_else(|_| std::env::var("LANG")).unwrap_or_else(|_| "en_US".into()),
        "networkInterfaces": network_interfaces(),
        "versions": { "tauri": tauri::VERSION },
    })
}

/// Every webview, whether Rust or a page created its window, gets the
/// startup payload and the shim ahead of its own scripts, and every window
/// the Rust-side handling in win.rs.
fn ride_plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    let script = format!("window.__RIDE__ = {};\n{}", init_payload(), SHIM);
    tauri::plugin::Builder::new("ride")
        .js_init_script(script)
        // Electron's did-finish-load: src/wm.js holds scripts meant for a new
        // window until its page has loaded.
        .on_page_load(|w, p| {
            if matches!(p.event(), tauri::webview::PageLoadEvent::Finished) {
                let _ = w.app_handle().emit("ride-page-load", json!({ "label": w.label() }));
            }
        })
        .on_window_ready(|w| win::watch(&w))
        .build()
}

/// ridefile://localhost/<path>: local files for windows RIDE points at a
/// file:// URL outside the app (3500⌶ writes its HTML to a temp file).
fn local_file(req: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let path = percent_encoding::percent_decode_str(req.uri().path()).decode_utf8_lossy().into_owned();
    // /C:/dir/file.html on Windows.
    #[cfg(windows)]
    let path = match path.as_bytes() {
        [b'/', _, b':', ..] => path[1..].to_string(),
        _ => path,
    };
    let mime = match std::path::Path::new(&path).extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("html" | "htm") => "text/html; charset=utf-8",
        Some("css") => "text/css",
        Some("js" | "mjs") => "text/javascript",
        Some("json") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("ttf") => "font/ttf",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    };
    match std::fs::read(&path) {
        Ok(bytes) => Response::builder().header("Content-Type", mime).body(bytes).unwrap(),
        Err(e) => Response::builder()
            .status(404)
            .header("Content-Type", "text/plain")
            .body(format!("{path}: {e}").into_bytes())
            .unwrap(),
    }
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
        (Some("proc"), Some("execSync")) => proc::exec_sync(args),
        (Some("dialog"), Some("message")) => dialog::message(app, args),
        (Some("dialog"), Some("file")) => dialog::file(app, args),
        (Some("session"), Some("env")) => Ok(win::session_env(args.get("label").and_then(Value::as_str).unwrap_or(""))),
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
        // One process for every session: starting Tauride again opens a new
        // session window in the running one, as with VS Code.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = win::open_session(&app, serde_json::Map::new()) {
                    eprintln!("tauride: cannot open a session window: {e}");
                }
            });
        }))
        .plugin(ride_plugin())
        .register_uri_scheme_protocol("ridefile", |_ctx, req| local_file(&req))
        .register_uri_scheme_protocol("ridesync", |ctx, req| {
            // On Windows the scheme is http://ridesync.localhost, cross-origin
            // to the page, so a JSON POST is preflighted.
            if req.method() == tauri::http::Method::OPTIONS {
                return Response::builder()
                    .header("Access-Control-Allow-Origin", "*")
                    .header("Access-Control-Allow-Methods", "GET, POST")
                    .header("Access-Control-Allow-Headers", "Content-Type")
                    .body(Vec::new())
                    .unwrap();
            }
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
        .manage(ssh::Ssh::default())
        .invoke_handler(tauri::generate_handler![
            log,
            open_url,
            win::win_op,
            win::session_new,
            net::net_connect,
            net::net_connect_tls,
            net::net_write,
            net::net_end,
            net::net_listen,
            net::net_close_server,
            proc::proc_spawn,
            proc::proc_kill,
            ssh::ssh_connect,
            ssh::ssh_exec,
            ssh::ssh_forward_out,
            ssh::ssh_forward_in,
            ssh::ssh_end,
            winstate::save_win,
            menu::popup_menu,
            menu::set_app_menu,
        ])
        .on_menu_event(|app, e| menu::on_event(app, e.id().as_ref()))
        .setup(|app| {
            let main = win::session_window(app, "main")?;
            if app.state::<winstate::WinState>().get()["devTools"].as_bool().unwrap_or(false) {
                main.open_devtools();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Tauride");
}
