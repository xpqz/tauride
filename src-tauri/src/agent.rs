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

/// Tells a connection that arrived while another is served that the port is
/// busy. A client writes its request as soon as it connects, which on a
/// Unix socket is before this side has accepted; dropping the stream right
/// after the frame would turn that write into EPIPE on the client, and a
/// Node client then closes without reading the frame. So the write half is
/// shut down and the client's bytes are drained until it closes (or a
/// second passes), which lets its request land and the refusal be read.
#[cfg(unix)]
async fn refuse(mut stream: tokio::net::UnixStream) {
    use tokio::io::AsyncWriteExt;
    if stream.write_all(BUSY).await.is_err() || stream.shutdown().await.is_err() {
        return;
    }
    let mut sink = tokio::io::sink();
    let drain = tokio::io::copy(&mut stream, &mut sink);
    let _ = tokio::time::timeout(std::time::Duration::from_secs(1), drain).await;
}

/// Accepts connections for one port. A connection arriving while another is
/// served is told so and dropped, so the tap never sees two clients.
#[cfg(unix)]
async fn accept_loop<R: Runtime>(app: AppHandle<R>, label: String, listener: tokio::net::UnixListener) {
    let mut n = 0u64;
    loop {
        let stream = match listener.accept().await {
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
        // Spawned so a client that never closes cannot hold up the accepts.
        if !accepted {
            tauri::async_runtime::spawn(refuse(stream));
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

// Windows transport: no Unix domain sockets, so each session window listens on
// a loopback TCP port named in `<userData>/agent/<label>.port` as
// `127.0.0.1:<port> <token>`. Any local process can reach the port, so a
// connection counts only once its first frame is `{"auth": "<token>"}`; that
// frame is not passed on to the tap. Otherwise as on Unix: one connection per
// port, `ride-agent` events, `agent_send` and `agent_close`.

#[cfg(windows)]
struct TcpConn {
    tx: tokio::sync::mpsc::UnboundedSender<String>,
    /// As `Conn::n`: a task ending late does not clear its successor.
    n: u64,
}

#[cfg(windows)]
struct TcpPort {
    path: std::path::PathBuf,
    accept: tauri::async_runtime::JoinHandle<()>,
    conn: Option<TcpConn>,
}

#[cfg(windows)]
static TCP_PORTS: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, TcpPort>>> =
    std::sync::LazyLock::new(Default::default);

#[cfg(windows)]
const TCP_BUSY: &[u8] = b"{\"err\":{\"code\":\"busy\",\"message\":\"another agent is connected to this session\"}}\n";
#[cfg(windows)]
const TCP_UNAUTHORIZED: &[u8] = b"{\"err\":{\"code\":\"unauthorized\",\"message\":\"the first frame must be {\\\"auth\\\": <token from the .port file>}\"}}\n";

#[cfg(windows)]
fn tcp_emit<R: Runtime>(app: &AppHandle<R>, label: &str, payload: serde_json::Value) {
    use tauri::Emitter;
    let _ = app.emit_to(tauri::EventTarget::webview_window(label), "ride-agent", payload);
}

#[cfg(windows)]
fn tcp_token() -> Result<String, String> {
    let mut b = [0u8; 32];
    getrandom::fill(&mut b).map_err(|e| format!("agent token: {e}"))?;
    Ok(b.iter().map(|x| format!("{x:02x}")).collect())
}

/// Whether `line` is `{"auth": token}`, compared without an early exit.
#[cfg(windows)]
fn tcp_auth_ok(line: &str, token: &str) -> bool {
    let v: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return false,
    };
    let Some(given) = v.get("auth").and_then(serde_json::Value::as_str) else { return false };
    given.len() == token.len() && given.bytes().zip(token.bytes()).fold(0u8, |d, (a, b)| d | (a ^ b)) == 0
}

/// Sends a refusal and closes. Closing a Windows socket with unread input
/// resets the connection, which can discard the frame before the client reads
/// it; so the write half is shut down and the client's bytes are drained
/// until it closes (or a second passes).
#[cfg(windows)]
async fn tcp_refuse(
    mut rd: tokio::io::BufReader<tokio::net::tcp::OwnedReadHalf>,
    mut wr: tokio::net::tcp::OwnedWriteHalf,
    frame: &[u8],
) {
    use tokio::io::AsyncWriteExt;
    if wr.write_all(frame).await.is_err() || wr.shutdown().await.is_err() {
        return;
    }
    let mut sink = tokio::io::sink();
    let _ = tokio::time::timeout(std::time::Duration::from_secs(1), tokio::io::copy(&mut rd, &mut sink)).await;
}

/// One accepted connection: authenticate, take the port's slot, then move
/// lines both ways until either side ends.
#[cfg(windows)]
async fn tcp_serve<R: Runtime>(app: AppHandle<R>, label: String, stream: tokio::net::TcpStream, token: String, n: u64) {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let _ = stream.set_nodelay(true);
    let (rd, mut wr) = stream.into_split();
    let mut rd = BufReader::new(rd);
    let mut first = String::new();
    let authed = matches!(
        tokio::time::timeout(std::time::Duration::from_secs(10), rd.read_line(&mut first)).await,
        Ok(Ok(k)) if k > 0 && tcp_auth_ok(first.trim_end(), &token)
    );
    if !authed {
        tcp_refuse(rd, wr, TCP_UNAUTHORIZED).await;
        return;
    }
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let claimed = match TCP_PORTS.lock().unwrap().get_mut(&label) {
        None => return,
        Some(p) if p.conn.is_some() => false,
        Some(p) => {
            p.conn = Some(TcpConn { tx, n });
            true
        }
    };
    if !claimed {
        tcp_refuse(rd, wr, TCP_BUSY).await;
        return;
    }
    // The connect notice goes out before the first line can.
    tcp_emit(&app, &label, serde_json::Value::Bool(true));
    let mut lines = rd.lines();
    loop {
        tokio::select! {
            l = lines.next_line() => match l {
                Ok(Some(line)) => tcp_emit(&app, &label, serde_json::Value::String(line)),
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
    let mine = match TCP_PORTS.lock().unwrap().get_mut(&label) {
        Some(p) if p.conn.as_ref().is_some_and(|c| c.n == n) => {
            p.conn = None;
            true
        }
        _ => false,
    };
    if mine {
        tcp_emit(&app, &label, serde_json::Value::Null);
    }
}

/// Accepts connections for one port; each is authenticated on its own task,
/// so a client that never sends a frame cannot hold up the others.
#[cfg(windows)]
async fn tcp_accept_loop<R: Runtime>(app: AppHandle<R>, label: String, listener: tokio::net::TcpListener, token: String) {
    let mut n = 0u64;
    loop {
        let stream = match listener.accept().await {
            Ok((s, _)) => s,
            Err(e) => {
                eprintln!("tauride: agent port {label}: accept: {e}");
                break;
            }
        };
        n += 1;
        tauri::async_runtime::spawn(tcp_serve(app.clone(), label.clone(), stream, token.clone(), n));
    }
}

/// Opens the session window's port and returns the path of its `.port` file.
/// Calling it again for a label that already listens returns the same path.
#[cfg(windows)]
#[tauri::command]
pub async fn agent_listen<R: Runtime>(app: AppHandle<R>, label: String) -> Result<String, String> {
    if let Some(p) = TCP_PORTS.lock().unwrap().get(&label) {
        return Ok(p.path.to_string_lossy().into_owned());
    }
    let dir = crate::user_data_dir().join("agent");
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let path = dir.join(format!("{label}.port"));
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| format!("agent port: {e}"))?;
    let addr = listener.local_addr().map_err(|e| format!("agent port: {e}"))?;
    let token = tcp_token()?;
    let mut ports = TCP_PORTS.lock().unwrap();
    // A concurrent call for the same label got there first: keep its port and file.
    if let Some(p) = ports.get(&label) {
        return Ok(p.path.to_string_lossy().into_owned());
    }
    // Overwrites a file left by a run that did not exit cleanly.
    std::fs::write(&path, format!("{addr} {token}\n")).map_err(|e| format!("{}: {e}", path.display()))?;
    let accept = tauri::async_runtime::spawn(tcp_accept_loop(app, label.clone(), listener, token));
    let shown = path.to_string_lossy().into_owned();
    ports.insert(label, TcpPort { path, accept, conn: None });
    Ok(shown)
}

/// Closes the port and its connection and removes the `.port` file.
#[cfg(windows)]
#[tauri::command]
pub fn agent_close<R: Runtime>(_app: AppHandle<R>, label: String) {
    let port = TCP_PORTS.lock().unwrap().remove(&label);
    if let Some(p) = port {
        p.accept.abort();
        let _ = std::fs::remove_file(&p.path);
    }
}

/// Writes one frame to the current connection.
#[cfg(windows)]
#[tauri::command]
pub fn agent_send<R: Runtime>(_app: AppHandle<R>, label: String, line: String) -> Result<(), String> {
    let ports = TCP_PORTS.lock().unwrap();
    let conn = ports.get(&label).and_then(|p| p.conn.as_ref()).ok_or_else(|| format!("no agent connected to {label}"))?;
    conn.tx.send(format!("{line}\n")).map_err(|_| format!("agent connection to {label} is closed"))
}

#[cfg(not(any(unix, windows)))]
#[tauri::command]
#[allow(unused_variables)]
pub async fn agent_listen<R: Runtime>(app: AppHandle<R>, label: String) -> Result<String, String> {
    Err("not supported".into())
}

#[cfg(not(any(unix, windows)))]
#[tauri::command]
#[allow(unused_variables)]
pub fn agent_close<R: Runtime>(app: AppHandle<R>, label: String) {}

#[cfg(not(any(unix, windows)))]
#[tauri::command]
#[allow(unused_variables)]
pub fn agent_send<R: Runtime>(app: AppHandle<R>, label: String, line: String) -> Result<(), String> {
    Err("not supported".into())
}

/// Closes every port and removes its socket file. Called when the process
/// exits, where no session window is left to call `agent_close`, so a
/// socket file does not outlive the run that made it.
#[cfg(unix)]
pub fn cleanup_all<R: Runtime>(app: &AppHandle<R>) {
    let ports: Vec<Port> = app.state::<Agent>().ports.lock().unwrap().drain().map(|(_, p)| p).collect();
    for p in ports {
        p.accept.abort();
        let _ = std::fs::remove_file(&p.path);
    }
}

#[cfg(windows)]
pub fn cleanup_all<R: Runtime>(_app: &AppHandle<R>) {
    let ports: Vec<TcpPort> = TCP_PORTS.lock().unwrap().drain().map(|(_, p)| p).collect();
    for p in ports {
        p.accept.abort();
        let _ = std::fs::remove_file(&p.path);
    }
}

#[cfg(not(any(unix, windows)))]
pub fn cleanup_all<R: Runtime>(_app: &AppHandle<R>) {}
