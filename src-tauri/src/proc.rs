//! Child processes behind the shim's `child_process.spawn`, used to start a
//! local interpreter (RIDE_INIT=CONNECT:host:port) and to relaunch RIDE.
//! Events go out as `ride-proc` ({id, event, ...}) keyed by the id the
//! webview chose.

use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, Runtime};

#[derive(Default)]
pub struct Procs {
    /// Process ids by webview id, with the stdin RIDE keeps open as a pipe.
    running: Mutex<HashMap<String, (u32, Option<tokio::process::ChildStdin>)>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnOpts {
    cwd: Option<String>,
    /// The complete environment, as Node's `env` option replaces it.
    env: Option<HashMap<String, String>>,
    /// stdin, stdout, stderr: "pipe", "ignore" or "inherit".
    stdio: Option<Vec<String>>,
    detached: Option<bool>,
}

fn stdio(kind: Option<&String>) -> Stdio {
    match kind.map(String::as_str) {
        Some("pipe") => Stdio::piped(),
        Some("inherit") => Stdio::inherit(),
        _ => Stdio::null(),
    }
}

fn spawn_err(e: &std::io::Error, exe: &str) -> serde_json::Value {
    let code = match e.kind() {
        std::io::ErrorKind::NotFound => "ENOENT",
        std::io::ErrorKind::PermissionDenied => "EACCES",
        _ => "EIO",
    };
    json!({ "code": code, "message": format!("spawn {exe} {code}: {e}") })
}

#[tauri::command]
pub async fn proc_spawn<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    exe: String,
    args: Vec<String>,
    opts: SpawnOpts,
) -> Result<u32, serde_json::Value> {
    let mut cmd = tokio::process::Command::new(&exe);
    cmd.args(&args);
    if let Some(cwd) = opts.cwd.as_deref().filter(|c| !c.is_empty()) {
        cmd.current_dir(cwd);
    }
    if let Some(env) = &opts.env {
        cmd.env_clear().envs(env);
    }
    let io = opts.stdio.unwrap_or_default();
    cmd.stdin(stdio(io.first())).stdout(stdio(io.get(1))).stderr(stdio(io.get(2)));
    #[cfg(unix)]
    if opts.detached.unwrap_or(false) {
        cmd.process_group(0);
    }
    let mut child = cmd.spawn().map_err(|e| spawn_err(&e, &exe))?;
    let pid = child.id().unwrap_or(0);
    let stdin = child.stdin.take();
    app.state::<Procs>().running.lock().unwrap().insert(id.clone(), (pid, stdin));

    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let status = child.wait().await;
        app2.state::<Procs>().running.lock().unwrap().remove(&id);
        let (code, signal) = match status {
            Ok(s) => {
                #[cfg(unix)]
                let sig = std::os::unix::process::ExitStatusExt::signal(&s).map(signal_name);
                #[cfg(not(unix))]
                let sig: Option<&str> = None;
                (s.code(), sig)
            }
            Err(_) => (None, None),
        };
        let _ = app2.emit("ride-proc", json!({ "id": id, "event": "exit", "code": code, "signal": signal }));
    });
    Ok(pid)
}

#[cfg(unix)]
fn signal_name(n: i32) -> &'static str {
    match n {
        libc::SIGTERM => "SIGTERM",
        libc::SIGKILL => "SIGKILL",
        libc::SIGINT => "SIGINT",
        libc::SIGHUP => "SIGHUP",
        libc::SIGSEGV => "SIGSEGV",
        libc::SIGABRT => "SIGABRT",
        _ => "SIGUNKNOWN",
    }
}

/// kill(signal): SIGTERM by default, as in Node.
#[tauri::command]
pub fn proc_kill<R: Runtime>(app: AppHandle<R>, id: String, signal: Option<String>) -> Result<(), String> {
    let pid = app
        .state::<Procs>()
        .running
        .lock()
        .unwrap()
        .get(&id)
        .map(|(pid, _)| *pid)
        .ok_or_else(|| format!("process {id} is not running"))?;
    #[cfg(unix)]
    {
        let sig = match signal.as_deref() {
            Some("SIGKILL") => libc::SIGKILL,
            Some("SIGINT") => libc::SIGINT,
            Some("SIGHUP") => libc::SIGHUP,
            _ => libc::SIGTERM,
        };
        if unsafe { libc::kill(pid as i32, sig) } != 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (pid, signal);
        return Err("kill is not supported on this platform".into());
    }
    Ok(())
}
