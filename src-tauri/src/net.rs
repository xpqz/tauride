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

pub(crate) enum Out {
    Data(Vec<u8>),
    End,
}

#[derive(Default)]
pub struct Net {
    pub(crate) sockets: Mutex<HashMap<String, mpsc::UnboundedSender<Out>>>,
    servers: Mutex<HashMap<String, JoinHandle<()>>>,
}

pub(crate) const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

#[allow(non_snake_case)]
pub(crate) fn B64_encode(bytes: &[u8]) -> String {
    B64.encode(bytes)
}

pub(crate) fn emit<R: Runtime>(app: &AppHandle<R>, payload: Value) {
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
pub(crate) fn adopt<R: Runtime, S>(app: &AppHandle<R>, id: String, stream: S)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + 'static,
{
    let (mut rd, mut wr) = tokio::io::split(stream);
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

/// tls.connect options as RIDE builds them: PEM text of an optional client
/// certificate and key, and of the CA certificates to trust (system roots
/// when none are given).
#[derive(serde::Deserialize, Default)]
#[serde(default)]
pub struct TlsOpts {
    cert: Option<String>,
    key: Option<String>,
    ca: Vec<String>,
}

/// Verifies the chain but not the host name: RIDE replaces Node's name check
/// with its own checkServerIdentity (CN against host, only when asked to),
/// which the shim runs on the CN this connection reports. A server
/// certificate identical to one of the given CA certificates is accepted,
/// as OpenSSL accepts a self-signed certificate listed as a CA.
#[derive(Debug)]
struct ChainOnly {
    inner: std::sync::Arc<rustls::client::WebPkiServerVerifier>,
    pinned: Vec<Vec<u8>>,
}

impl rustls::client::danger::ServerCertVerifier for ChainOnly {
    fn verify_server_cert(
        &self,
        end_entity: &rustls::pki_types::CertificateDer<'_>,
        intermediates: &[rustls::pki_types::CertificateDer<'_>],
        server_name: &rustls::pki_types::ServerName<'_>,
        ocsp: &[u8],
        now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        use rustls::{CertificateError as C, Error as E};
        match self.inner.verify_server_cert(end_entity, intermediates, server_name, ocsp, now) {
            Ok(v) => Ok(v),
            Err(E::InvalidCertificate(C::NotValidForName | C::NotValidForNameContext { .. })) => {
                Ok(rustls::client::danger::ServerCertVerified::assertion())
            }
            Err(e) if self.pinned.iter().any(|p| p.as_slice() == end_entity.as_ref()) => {
                let _ = e;
                Ok(rustls::client::danger::ServerCertVerified::assertion())
            }
            Err(e) => Err(e),
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.inner.supported_verify_schemes()
    }
}

fn tls_err(message: impl std::fmt::Display) -> Value {
    json!({ "code": "ERR_TLS", "message": message.to_string() })
}

fn tls_config(o: &TlsOpts) -> Result<rustls::ClientConfig, Value> {
    use rustls::pki_types::pem::PemObject;
    use rustls::pki_types::{CertificateDer, PrivateKeyDer};
    let provider = std::sync::Arc::new(rustls::crypto::ring::default_provider());
    let mut roots = rustls::RootCertStore::empty();
    let mut pinned = vec![];
    if o.ca.is_empty() {
        for c in rustls_native_certs::load_native_certs().certs {
            let _ = roots.add(c);
        }
    } else {
        for pem in &o.ca {
            for c in CertificateDer::pem_slice_iter(pem.as_bytes()).flatten() {
                pinned.push(c.as_ref().to_vec());
                let _ = roots.add(c);
            }
        }
    }
    let inner = rustls::client::WebPkiServerVerifier::builder_with_provider(std::sync::Arc::new(roots), provider.clone())
        .build()
        .map_err(tls_err)?;
    let builder = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(tls_err)?
        .dangerous()
        .with_custom_certificate_verifier(std::sync::Arc::new(ChainOnly { inner, pinned }));
    match (&o.cert, &o.key) {
        (Some(cert), Some(key)) => {
            let chain: Vec<CertificateDer<'static>> =
                CertificateDer::pem_slice_iter(cert.as_bytes()).collect::<Result<_, _>>().map_err(tls_err)?;
            let key = PrivateKeyDer::from_pem_slice(key.as_bytes()).map_err(tls_err)?;
            builder.with_client_auth_cert(chain, key).map_err(tls_err)
        }
        _ => Ok(builder.with_no_client_auth()),
    }
}

fn common_name(der: &[u8]) -> Option<String> {
    let (_, cert) = x509_parser::parse_x509_certificate(der).ok()?;
    let cn = cert.subject().iter_common_name().next()?.as_str().ok()?.to_string();
    Some(cn)
}

#[tauri::command]
pub async fn net_connect_tls<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    host: String,
    port: u16,
    tls: TlsOpts,
) -> Result<Value, Value> {
    let host = if host.is_empty() { "localhost".to_string() } else { host };
    let config = tls_config(&tls)?;
    let tcp = TcpStream::connect((host.as_str(), port))
        .await
        .map_err(|e| err_value(&e, &format!("connect {host}:{port}")))?;
    let _ = tcp.set_nodelay(true);
    let name = rustls::pki_types::ServerName::try_from(host.clone()).map_err(tls_err)?;
    let stream = tokio_rustls::TlsConnector::from(std::sync::Arc::new(config))
        .connect(name, tcp)
        .await
        .map_err(|e| tls_err(format!("TLS handshake with {host}:{port}: {e}")))?;
    let cn = stream.get_ref().1.peer_certificates().and_then(|c| c.first()).and_then(|c| common_name(c.as_ref()));
    let remote = stream.get_ref().0.peer_addr().ok();
    adopt(&app, id, stream);
    Ok(json!({
        "remoteAddress": remote.map(|a| a.ip().to_string()),
        "remotePort": remote.map(|a| a.port()),
        "peerCertificate": { "subject": { "CN": cn } },
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
