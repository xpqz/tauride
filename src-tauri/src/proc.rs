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

/// App exit: end every process RIDE spawned (the interpreter, and what its
/// wrapper script started) so none outlives Tauride, as Electron's children
/// did not. Each process tree is collected before any of it is signalled,
/// as a child whose parent has gone can no longer be found by parent. Dyalog
/// serving RIDE ignores SIGTERM (and SIGHUP and SIGINT), so whatever is left
/// after a moment gets SIGKILL: with the app gone nothing can reach it.
#[cfg(unix)]
pub fn kill_all<R: Runtime>(app: &AppHandle<R>) {
    fn tree(pid: u32, out: &mut Vec<i32>) {
        out.push(pid as i32);
        let children = std::process::Command::new("pgrep").args(["-P", &pid.to_string()]).output();
        for c in children.map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default().split_whitespace() {
            if let Ok(c) = c.parse() {
                tree(c, out);
            }
        }
    }
    let mut pids = Vec::new();
    for (pid, _) in app.state::<Procs>().running.lock().unwrap().values() {
        tree(*pid, &mut pids);
    }
    if pids.is_empty() {
        return;
    }
    for &p in &pids {
        unsafe { libc::kill(p, libc::SIGTERM) };
    }
    let alive = |p: i32| unsafe { libc::kill(p, 0) } == 0;
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
    while std::time::Instant::now() < deadline && pids.iter().any(|&p| alive(p)) {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    for &p in &pids {
        if alive(p) {
            unsafe { libc::kill(p, libc::SIGKILL) };
        }
    }
}

#[cfg(not(unix))]
pub fn kill_all<R: Runtime>(_app: &AppHandle<R>) {}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnOpts {
    cwd: Option<String>,
    /// The complete environment, as Node's `env` option replaces it.
    env: Option<HashMap<String, String>>,
    /// stdin, stdout, stderr: "pipe", "ignore" or "inherit".
    stdio: Option<Vec<String>>,
    #[cfg_attr(not(unix), allow(dead_code))]
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
        Ok(())
    }
    // As in Node, any signal terminates the process outright.
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
        let _ = signal;
        let h = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if h.is_null() {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let ok = TerminateProcess(h, 1);
        let err = std::io::Error::last_os_error();
        CloseHandle(h);
        if ok == 0 {
            return Err(err.to_string());
        }
        Ok(())
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (pid, signal);
        Err("kill is not supported on this platform".into())
    }
}

/// child_process.execSync, for the ridesync:// scheme: run `cmd` through the
/// shell as Node does, and answer its stdout. Ride uses it on Windows to find
/// installed interpreters (`reg query`).
pub fn exec_sync(a: &serde_json::Value) -> crate::sync::Result {
    use std::io::Read;
    use std::time::{Duration, Instant};
    let cmd = a.get("cmd").and_then(serde_json::Value::as_str).ok_or_else(|| crate::sync::err("EINVAL", "missing cmd"))?;
    #[cfg(windows)]
    let mut c = {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut c = std::process::Command::new("cmd.exe");
        c.raw_arg(format!("/d /s /c \"{cmd}\"")).creation_flags(CREATE_NO_WINDOW);
        c
    };
    #[cfg(not(windows))]
    let mut c = {
        let mut c = std::process::Command::new("/bin/sh");
        c.arg("-c").arg(cmd);
        c
    };
    if let Some(cwd) = a.get("cwd").and_then(serde_json::Value::as_str).filter(|c| !c.is_empty()) {
        c.current_dir(cwd);
    }
    let mut child = c
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| spawn_err(&e, cmd))?;
    // Drain the pipes on their own threads, so a chatty command cannot block.
    let drain = |r: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut r) = r {
                let _ = r.read_to_end(&mut buf);
            }
            String::from_utf8_lossy(&buf).into_owned()
        })
    };
    let out = drain(child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>));
    let err = drain(child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>));
    let timeout = a.get("timeout").and_then(serde_json::Value::as_u64).filter(|&t| t > 0).map(Duration::from_millis);
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if timeout.is_some_and(|t| start.elapsed() >= t) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(crate::sync::err("ETIMEDOUT", format!("spawnSync {cmd} ETIMEDOUT")));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(e) => return Err(crate::sync::err("EIO", e.to_string())),
        }
    };
    let (stdout, stderr) = (out.join().unwrap_or_default(), err.join().unwrap_or_default());
    if !status.success() {
        let mut e = crate::sync::err("ECMDFAIL", format!("Command failed: {cmd}\n{stderr}"));
        e["status"] = json!(status.code());
        e["stdout"] = json!(stdout);
        e["stderr"] = json!(stderr);
        return Err(e);
    }
    Ok(json!(stdout))
}
