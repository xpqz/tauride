//! TCP sockets and servers behind the shim's `net` module.
//!
//! The webview names every socket and server with a string id it chooses, so
//! it can attach listeners before the async work finishes. A reader task per
//! socket emits `ride-net` events ({id, event, ...}); writes go through a
//! per-socket channel to a writer task, which keeps them in order. Accepted
//! connections are registered as `<server id>/<n>`.

use base64::Engine;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tauri::async_runtime::JoinHandle;

enum Out {
    Data(Vec<u8>),
    End,
}

#[derive(Default)]
pub struct Net {
    sockets: Mutex<HashMap<String, mpsc::UnboundedSender<Out>>>,
    servers: Mutex<HashMap<String, JoinHandle<()>>>,
}

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

fn emit<R: Runtime>(app: &AppHandle<R>, payload: Value) {
    let _ = app.emit("ride-net", payload);
}

/// Node's error codes, which RIDE's connect page checks.
fn code(e: &std::io::Error) -> &'static str {
    use std::io::ErrorKind::*;
    match e.kind() {
        ConnectionRefused => "ECONNREFUSED",
        ConnectionReset => "ECONNRESET",
        ConnectionAborted => "ECONNABORTED",
        TimedOut => "ETIMEDOUT",
        AddrInUse => "EADDRINUSE",
        AddrNotAvailable => "EADDRNOTAVAIL",
        BrokenPipe => "EPIPE",
        NotFound => "ENOTFOUND",
        PermissionDenied => "EACCES",
        _ => "EIO",
    }
}

fn err_value(e: &std::io::Error, what: &str) -> Value {
    json!({ "code": code(e), "message": format!("{what}: {e}") })
}

/// Registers a connected stream: a reader task emitting data/end/close and a
/// writer task fed by the socket's channel.
fn adopt<R: Runtime>(app: &AppHandle<R>, id: String, stream: TcpStream) {
    let (mut rd, mut wr) = stream.into_split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Out>();
    app.state::<Net>().sockets.lock().unwrap().insert(id.clone(), tx);

    tauri::async_runtime::spawn(async move {
        while let Some(m) = rx.recv().await {
            match m {
                Out::Data(d) => {
                    if wr.write_all(&d).await.is_err() {
                        break;
                    }
                }
                Out::End => {
                    let _ = wr.shutdown().await;
                    break;
                }
            }
        }
    });

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match rd.read(&mut buf).await {
                Ok(0) => {
                    emit(&app, json!({ "id": id, "event": "end" }));
                    break;
                }
                Ok(n) => emit(&app, json!({ "id": id, "event": "data", "data": B64.encode(&buf[..n]) })),
                Err(e) => {
                    emit(&app, json!({ "id": id, "event": "error", "error": err_value(&e, "read") }));
                    break;
                }
            }
        }
        app.state::<Net>().sockets.lock().unwrap().remove(&id);
        emit(&app, json!({ "id": id, "event": "close" }));
    });
}

#[tauri::command]
pub async fn net_connect<R: Runtime>(app: AppHandle<R>, id: String, host: String, port: u16) -> Result<Value, Value> {
    let host = if host.is_empty() { "localhost".to_string() } else { host };
    let stream = TcpStream::connect((host.as_str(), port))
        .await
        .map_err(|e| err_value(&e, &format!("connect {host}:{port}")))?;
    let _ = stream.set_nodelay(true);
    let local = stream.local_addr().ok();
    let remote = stream.peer_addr().ok();
    adopt(&app, id, stream);
    Ok(json!({
        "localAddress": local.map(|a| a.ip().to_string()),
        "localPort": local.map(|a| a.port()),
        "remoteAddress": remote.map(|a| a.ip().to_string()),
        "remotePort": remote.map(|a| a.port()),
    }))
}

#[tauri::command]
pub fn net_write<R: Runtime>(app: AppHandle<R>, id: String, data: String) -> Result<(), String> {
    let bytes = B64.decode(data).map_err(|e| e.to_string())?;
    let tx = app.state::<Net>().sockets.lock().unwrap().get(&id).cloned();
    tx.ok_or_else(|| format!("socket {id} is closed"))?
        .send(Out::Data(bytes))
        .map_err(|_| format!("socket {id} is closed"))
}

/// end(): half-close after queued writes. destroy(): drop the socket.
#[tauri::command]
pub fn net_end<R: Runtime>(app: AppHandle<R>, id: String, destroy: bool) {
    let net = app.state::<Net>();
    let mut sockets = net.sockets.lock().unwrap();
    if destroy {
        sockets.remove(&id);
    } else if let Some(tx) = sockets.get(&id) {
        let _ = tx.send(Out::End);
    }
}

#[tauri::command]
pub async fn net_listen<R: Runtime>(app: AppHandle<R>, id: String, host: String, port: u16) -> Result<Value, Value> {
    // Node's listen(port, '') binds every interface.
    let host = if host.is_empty() { "::".to_string() } else { host };
    let listener = match TcpListener::bind((host.as_str(), port)).await {
        Ok(l) => l,
        Err(_) if host == "::" => TcpListener::bind(("0.0.0.0", port))
            .await
            .map_err(|e| err_value(&e, &format!("listen {port}")))?,
        Err(e) => return Err(err_value(&e, &format!("listen {host}:{port}"))),
    };
    let addr = listener.local_addr().map_err(|e| err_value(&e, "listen"))?;
    let server_app = app.clone();
    let server_id = id.clone();
    let task = tauri::async_runtime::spawn(async move {
        let mut n = 0u32;
        loop {
            match listener.accept().await {
                Ok((stream, peer)) => {
                    n += 1;
                    let cid = format!("{server_id}/{n}");
                    let _ = stream.set_nodelay(true);
                    // Announce the connection before its reader can emit data,
                    // so the webview has the socket when the first bytes arrive.
                    emit(&server_app, json!({
                        "id": server_id, "event": "connection", "conn": cid,
                        "remoteAddress": peer.ip().to_string(), "remotePort": peer.port(),
                    }));
                    adopt(&server_app, cid, stream);
                }
                Err(e) => {
                    emit(&server_app, json!({ "id": server_id, "event": "error", "error": err_value(&e, "accept") }));
                    break;
                }
            }
        }
    });
    app.state::<Net>().servers.lock().unwrap().insert(id, task);
    Ok(json!({
        "address": addr.ip().to_string(),
        "family": if addr.is_ipv4() { "IPv4" } else { "IPv6" },
        "port": addr.port(),
    }))
}

#[tauri::command]
pub fn net_close_server<R: Runtime>(app: AppHandle<R>, id: String) {
    if let Some(task) = app.state::<Net>().servers.lock().unwrap().remove(&id) {
        task.abort();
        emit(&app, json!({ "id": id, "event": "close" }));
    }
}
