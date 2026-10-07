//! SSH behind the shim's `ssh2` module (russh, ring): connecting through a
//! direct-tcpip tunnel, starting a remote interpreter that connects back
//! through a remote port forward, and running commands. Tunnelled channels
//! become ordinary sockets (net::adopt), so RIDE's protocol code reads them
//! like TCP; an exec channel's output arrives as `ride-net` data and its exit
//! as `close` with the exit code or signal, as ssh2 reports them.
//!
//! Host keys are accepted unverified: RIDE never asked ssh2 to verify them.

use crate::net::{adopt, emit, Net, Out};
use russh::client;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};
use tokio::sync::mpsc;

#[derive(Default)]
pub struct Ssh {
    clients: Mutex<HashMap<String, Arc<client::Handle<Handler>>>>,
}

pub struct Handler {
    app: AppHandle,
    id: String,
    forwarded: Arc<AtomicU32>,
}

impl client::Handler for Handler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }

    /// A connection to a remote forward (forwardIn): announced as ssh2's
    /// 'tcp connection' before its first bytes, then read as a socket.
    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<client::Msg>,
        connected_address: &str,
        connected_port: u32,
        originator_address: &str,
        originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        let n = self.forwarded.fetch_add(1, Ordering::Relaxed) + 1;
        let conn = format!("{}/fwd{n}", self.id);
        let _ = tauri::Emitter::emit(&self.app, "ride-ssh", json!({
            "id": self.id, "event": "tcp connection", "conn": conn,
            "info": {
                "destIP": connected_address, "destPort": connected_port,
                "srcIP": originator_address, "srcPort": originator_port,
            },
        }));
        adopt(&self.app, conn, channel.into_stream());
        Ok(())
    }
}

fn ssh_err(message: impl std::fmt::Display) -> Value {
    json!({ "code": "ERR_SSH", "message": message.to_string() })
}

fn handle(app: &AppHandle, id: &str) -> Result<Arc<client::Handle<Handler>>, Value> {
    app.state::<Ssh>()
        .clients
        .lock()
        .unwrap()
        .get(id)
        .cloned()
        .ok_or_else(|| ssh_err(format!("ssh client {id} is not connected")))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ssh_connect(
    app: AppHandle,
    id: String,
    host: String,
    port: u16,
    username: String,
    password: Option<String>,
    private_key: Option<String>,
    passphrase: Option<String>,
    try_keyboard: bool,
) -> Result<(), Value> {
    let config = Arc::new(client::Config::default());
    let handler = Handler { app: app.clone(), id: id.clone(), forwarded: Arc::new(AtomicU32::new(0)) };
    let mut h = client::connect(config, (host.as_str(), port), handler)
        .await
        .map_err(|e| ssh_err(format!("ssh {host}:{port}: {e}")))?;

    let ok = if let Some(pem) = private_key.filter(|k| !k.is_empty()) {
        let key = russh::keys::decode_secret_key(&pem, passphrase.as_deref().filter(|p| !p.is_empty()))
            .map_err(|e| match e {
                russh::keys::Error::KeyIsEncrypted => ssh_err("Encrypted private key detected, but no passphrase given"),
                e => ssh_err(format!("private key: {e}")),
            })?;
        let hash = h.best_supported_rsa_hash().await.map_err(ssh_err)?.flatten();
        let key = russh::keys::PrivateKeyWithHashAlg::new(Arc::new(key), hash);
        h.authenticate_publickey(&username, key).await.map_err(ssh_err)?.success()
    } else {
        let pass = password.unwrap_or_default();
        let mut ok = h.authenticate_password(&username, &pass).await.map_err(ssh_err)?.success();
        if !ok && try_keyboard {
            // ssh2's tryKeyboard, answered with the password as RIDE does.
            let mut r = h.authenticate_keyboard_interactive_start(&username, None).await.map_err(ssh_err)?;
            loop {
                match r {
                    client::KeyboardInteractiveAuthResponse::Success => { ok = true; break; }
                    client::KeyboardInteractiveAuthResponse::Failure { .. } => break,
                    client::KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                        let answers = prompts.iter().map(|_| pass.clone()).collect();
                        r = h.authenticate_keyboard_interactive_respond(answers).await.map_err(ssh_err)?;
                    }
                }
            }
        }
        ok
    };
    if !ok {
        return Err(ssh_err("All configured authentication methods failed"));
    }
    app.state::<Ssh>().clients.lock().unwrap().insert(id, Arc::new(h));
    Ok(())
}

/// exec(cmd, {pty}): output as data, exit as close(code, signal); writes and
/// end() go through the socket channel registered under `chan`.
#[tauri::command]
pub async fn ssh_exec(app: AppHandle, id: String, chan: String, cmd: String, pty: bool, term: String) -> Result<(), Value> {
    let h = handle(&app, &id)?;
    let channel = h.channel_open_session().await.map_err(ssh_err)?;
    if pty {
        channel.request_pty(false, &term, 80, 24, 0, 0, &[]).await.map_err(ssh_err)?;
    }
    channel.exec(true, cmd).await.map_err(ssh_err)?;
    let (mut rd, wr) = channel.split();

    let (tx, mut rx) = mpsc::unbounded_channel::<Out>();
    app.state::<Net>().sockets.lock().unwrap().insert(chan.clone(), tx);
    tauri::async_runtime::spawn(async move {
        while let Some(m) = rx.recv().await {
            match m {
                Out::Data(d) => {
                    if wr.data_bytes(d).await.is_err() {
                        break;
                    }
                }
                Out::End => {
                    let _ = wr.eof().await;
                    break;
                }
            }
        }
    });

    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let (mut code, mut signal) = (Value::Null, Value::Null);
        while let Some(m) = rd.wait().await {
            match m {
                russh::ChannelMsg::Data { data } | russh::ChannelMsg::ExtendedData { data, .. } => {
                    emit(&app2, json!({ "id": chan, "event": "data", "data": crate::net::B64_encode(&data) }));
                }
                russh::ChannelMsg::Eof => emit(&app2, json!({ "id": chan, "event": "end" })),
                russh::ChannelMsg::ExitStatus { exit_status } => code = json!(exit_status),
                russh::ChannelMsg::ExitSignal { signal_name, .. } => signal = json!(format!("SIG{signal_name:?}").to_uppercase()),
                russh::ChannelMsg::Close => break,
                _ => {}
            }
        }
        app2.state::<Net>().sockets.lock().unwrap().remove(&chan);
        emit(&app2, json!({ "id": chan, "event": "close", "code": code, "signal": signal }));
    });
    Ok(())
}

/// forwardOut: a direct-tcpip channel to dst, read as a socket.
#[tauri::command]
pub async fn ssh_forward_out(
    app: AppHandle,
    id: String,
    chan: String,
    dst_host: String,
    dst_port: u32,
    src_host: String,
    src_port: u32,
) -> Result<(), Value> {
    let h = handle(&app, &id)?;
    let channel = h
        .channel_open_direct_tcpip(dst_host, dst_port, src_host, src_port)
        .await
        .map_err(ssh_err)?;
    adopt(&app, chan, channel.into_stream());
    Ok(())
}

/// forwardIn: the remote port the server listens on (it picks one for 0).
#[tauri::command]
pub async fn ssh_forward_in(app: AppHandle, id: String, bind_addr: String, bind_port: u32) -> Result<u32, Value> {
    let h = handle(&app, &id)?;
    let port = h.tcpip_forward(bind_addr, bind_port).await.map_err(ssh_err)?;
    Ok(if port == 0 { bind_port } else { port })
}

#[tauri::command]
pub async fn ssh_end(app: AppHandle, id: String) {
    let h = app.state::<Ssh>().clients.lock().unwrap().remove(&id);
    if let Some(h) = h {
        let _ = h.disconnect(russh::Disconnect::ByApplication, "", "en").await;
    }
    let _ = tauri::Emitter::emit(&app, "ride-ssh", json!({ "id": id, "event": "close" }));
}
