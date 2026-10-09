//! The agent socket behind the frontend tap (src/agent.js): one Unix domain
//! socket per session window, `<userData>/agent/<label>.sock`, carrying
//! newline-delimited JSON frames. Rust only moves lines between the socket
//! and that window: each line read is a `ride-agent` event with the line as
//! its payload (`true` when a client connects, `null` when it goes), and
//! `agent_send` writes a line back. What a frame means is the tap's
//! business (tauri/agent-pairing.md).

#[cfg(unix)]
use serde_json::Value;
#[cfg(unix)]
use std::collections::HashMap;
#[cfg(unix)]
use std::path::PathBuf;
#[cfg(unix)]
use std::sync::Mutex;
use tauri::{AppHandle, Runtime};
#[cfg(unix)]
use tauri::{Emitter, EventTarget, Manager};
#[cfg(unix)]
use tokio::sync::mpsc;

/// The connection a port currently serves. Its task ends when `tx` is
/// dropped, which is how closing the port closes the connection.
#[cfg(unix)]
struct Conn {
    tx: mpsc::UnboundedSender<String>,
    /// Distinguishes this connection from a later one in the same slot, so a
    /// task ending late does not clear its successor.
    n: u64,
}

#[cfg(unix)]
struct Port {
    path: PathBuf,
    accept: tauri::async_runtime::JoinHandle<()>,
    conn: Option<Conn>,
}

#[derive(Default)]
pub struct Agent {
    #[cfg(unix)]
    ports: Mutex<HashMap<String, Port>>,
}

#[cfg(unix)]
const BUSY: &[u8] = b"{\"err\":{\"code\":\"busy\",\"message\":\"another agent is connected to this session\"}}\n";

#[cfg(unix)]
fn emit<R: Runtime>(app: &AppHandle<R>, label: &str, payload: Value) {
    let _ = app.emit_to(EventTarget::webview_window(label), "ride-agent", payload);
}

/// Serves one connection: lines in become events, lines from the channel go
/// out. Ends at EOF, on a write error, or when the port drops the sender.
#[cfg(unix)]
async fn serve<R: Runtime>(
    app: AppHandle<R>,
    label: String,
    stream: tokio::net::UnixStream,
    mut rx: mpsc::UnboundedReceiver<String>,
    n: u64,
) {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let (rd, mut wr) = stream.into_split();
    let mut lines = BufReader::new(rd).lines();
    loop {
        tokio::select! {
            l = lines.next_line() => match l {
                Ok(Some(line)) => emit(&app, &label, Value::String(line)),
                _ => break,
            },
            m = rx.recv() => match m {
                Some(line) => {
                    if wr.write_all(line.as_bytes()).await.is_err() {
                        break;
                    }
                }
                None => break,
            },
        }
    }
    let mine = {
        let agent = app.state::<Agent>();
        let mut ports = agent.ports.lock().unwrap();
        match ports.get_mut(&label) {
            Some(p) if p.conn.as_ref().is_some_and(|c| c.n == n) => {
                p.conn = None;
                true
            }
            _ => false,
        }
    };
    if mine {
        emit(&app, &label, Value::Null);
    }
}

/// Accepts connections for one port. A connection arriving while another is
/// served is told so and dropped, so the tap never sees two clients.
#[cfg(unix)]
async fn accept_loop<R: Runtime>(app: AppHandle<R>, label: String, listener: tokio::net::UnixListener) {
    use tokio::io::AsyncWriteExt;
    let mut n = 0u64;
    loop {
        let mut stream = match listener.accept().await {
            Ok((s, _)) => s,
            Err(e) => {
                eprintln!("tauride: agent socket {label}: accept: {e}");
                break;
            }
        };
        n += 1;
        let (tx, rx) = mpsc::unbounded_channel::<String>();
        let accepted = {
            let agent = app.state::<Agent>();
            let mut ports = agent.ports.lock().unwrap();
            match ports.get_mut(&label) {
                None => return,
                Some(p) if p.conn.is_some() => false,
                Some(p) => {
                    p.conn = Some(Conn { tx, n });
                    true
                }
            }
        };
        if !accepted {
            let _ = stream.write_all(BUSY).await;
            continue;
        }
        // The connect notice goes out before the connection's task can emit
        // its first line.
        emit(&app, &label, Value::Bool(true));
        tauri::async_runtime::spawn(serve(app.clone(), label.clone(), stream, rx, n));
    }
}

/// Opens the session window's socket and returns its path. Calling it again
/// for a label that already listens returns the same path.
#[cfg(unix)]
#[tauri::command]
pub async fn agent_listen<R: Runtime>(app: AppHandle<R>, label: String) -> Result<String, String> {
    use std::os::unix::fs::PermissionsExt;
    let agent = app.state::<Agent>();
    let mut ports = agent.ports.lock().unwrap();
    if let Some(p) = ports.get(&label) {
        return Ok(p.path.to_string_lossy().into_owned());
    }
    let dir = crate::user_data_dir().join("agent");
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).map_err(|e| format!("{}: {e}", dir.display()))?;
    let path = dir.join(format!("{label}.sock"));
    // A socket file left by a run that did not exit cleanly would refuse the bind.
    match std::fs::remove_file(&path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(format!("{}: {e}", path.display())),
        _ => {}
    }
    let listener = tokio::net::UnixListener::bind(&path).map_err(|e| format!("listen {}: {e}", path.display()))?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).map_err(|e| format!("{}: {e}", path.display()))?;
    let accept = tauri::async_runtime::spawn(accept_loop(app.clone(), label.clone(), listener));
    let shown = path.to_string_lossy().into_owned();
    ports.insert(label, Port { path, accept, conn: None });
    Ok(shown)
}

/// Closes the port and its connection and removes the socket file.
#[cfg(unix)]
#[tauri::command]
pub fn agent_close<R: Runtime>(app: AppHandle<R>, label: String) {
    let port = app.state::<Agent>().ports.lock().unwrap().remove(&label);
    if let Some(p) = port {
        p.accept.abort();
        let _ = std::fs::remove_file(&p.path);
    }
}

/// Writes one frame to the current connection.
#[cfg(unix)]
#[tauri::command]
pub fn agent_send<R: Runtime>(app: AppHandle<R>, label: String, line: String) -> Result<(), String> {
    let agent = app.state::<Agent>();
    let ports = agent.ports.lock().unwrap();
    let conn = ports.get(&label).and_then(|p| p.conn.as_ref()).ok_or_else(|| format!("no agent connected to {label}"))?;
    conn.tx.send(format!("{line}\n")).map_err(|_| format!("agent connection to {label} is closed"))
}

#[cfg(not(unix))]
#[tauri::command]
#[allow(unused_variables)]
pub async fn agent_listen<R: Runtime>(app: AppHandle<R>, label: String) -> Result<String, String> {
    Err("not supported".into())
}

#[cfg(not(unix))]
#[tauri::command]
#[allow(unused_variables)]
pub fn agent_close<R: Runtime>(app: AppHandle<R>, label: String) {}

#[cfg(not(unix))]
#[tauri::command]
#[allow(unused_variables)]
pub fn agent_send<R: Runtime>(app: AppHandle<R>, label: String, line: String) -> Result<(), String> {
    Err("not supported".into())
}
