//! Child processes behind the shim's `child_process.spawn`, used to start a
//! local interpreter (RIDE_INIT=CONNECT:host:port) and to relaunch RIDE.
//! Events go out as `ride-proc` ({id, event, ...}) keyed by the id the
//! webview chose.

use serde::Deserialize;
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::process::Stdio;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, Runtime};

struct Spawned {
    pid: u32,
    /// The process group a detached spawn leads; its members include what the
    /// spawned process starts, such as the interpreter a wrapper script runs.
    #[cfg_attr(not(unix), allow(dead_code))]
    group: Option<i32>,
    /// The stdin RIDE keeps open as a pipe.
    _stdin: Option<tokio::process::ChildStdin>,
}

#[derive(Default)]
pub struct Procs {
    /// Spawned processes by webview id, until the process itself exits.
    running: Mutex<HashMap<String, Spawned>>,
    /// Process groups of detached spawns, kept until they are empty: a member
    /// can outlive its leader, and must still end when Tauride does. Only
    /// groups Tauride created are recorded, so an interpreter it merely
    /// connected to is never signalled.
    #[cfg(unix)]
    groups: Mutex<HashSet<i32>>,
}

impl Procs {
    fn insert(&self, id: &str, pid: u32, group: Option<i32>, stdin: Option<tokio::process::ChildStdin>) {
        #[cfg(unix)]
        if let Some(group) = group {
            self.track_group(group);
        }
        self.running.lock().unwrap().insert(id.into(), Spawned { pid, group, _stdin: stdin });
    }

    #[cfg(unix)]
    fn track_group(&self, group: i32) {
        self.groups.lock().unwrap().insert(group);
    }

    #[cfg(all(test, unix))]
    fn tracked_groups(&self) -> Vec<i32> {
        self.groups.lock().unwrap().iter().copied().collect()
    }

    /// Signals a detached spawn's whole group, otherwise the process alone.
    #[cfg(unix)]
    fn signal(&self, id: &str, sig: i32) -> Result<(), String> {
        let target = self
            .running
            .lock()
            .unwrap()
            .get(id)
            .map(|s| s.group.map_or(s.pid as i32, |g| -g))
            .ok_or_else(|| format!("process {id} is not running"))?;
        if unsafe { libc::kill(target, sig) } != 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(())
    }

    /// Waits until a group has no members, then forgets it, so its id is never
    /// signalled once the system may have given it to another process group.
    #[cfg(unix)]
    async fn release_group(&self, group: i32) {
        while unsafe { libc::kill(-group, 0) } == 0 {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
        self.groups.lock().unwrap().remove(&group);
    }

    /// App exit: end every process RIDE spawned, with what its wrapper script
    /// started, so none outlives Tauride, as Electron's children did not.
    /// Process trees are collected before any of it is signalled, as a child
    /// whose parent has gone can no longer be found by parent; recorded groups
    /// also reach members whose leader has already exited. Dyalog serving RIDE
    /// ignores SIGTERM (and SIGHUP and SIGINT), so whatever is left after a
    /// moment gets SIGKILL: with the app gone nothing can reach it.
    #[cfg(unix)]
    fn reap(&self) {
        fn tree(pid: u32, out: &mut Vec<i32>) {
            out.push(pid as i32);
            let children = std::process::Command::new("pgrep").args(["-P", &pid.to_string()]).output();
            for c in children.map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default().split_whitespace() {
                if let Ok(c) = c.parse() {
                    tree(c, out);
                }
            }
        }
        let mut targets = Vec::new();
        for spawned in self.running.lock().unwrap().values() {
            tree(spawned.pid, &mut targets);
        }
        // A group that cannot be signalled is empty, or its id now belongs to
        // a group Tauride did not create.
        targets.extend(
            self.groups
                .lock()
                .unwrap()
                .iter()
                .filter(|&&g| unsafe { libc::kill(-g, 0) } == 0)
                .map(|&g| -g),
        );
        if targets.is_empty() {
            return;
        }
        for &p in &targets {
            unsafe { libc::kill(p, libc::SIGTERM) };
        }
        let alive = |p: i32| unsafe { libc::kill(p, 0) } == 0;
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
        while std::time::Instant::now() < deadline && targets.iter().any(|&p| alive(p)) {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        for &p in &targets {
            if alive(p) {
                unsafe { libc::kill(p, libc::SIGKILL) };
            }
        }
    }
}

#[cfg(unix)]
pub fn kill_all<R: Runtime>(app: &AppHandle<R>) {
    app.state::<Procs>().reap();
}

#[cfg(all(windows, feature = "ui-tests"))]
pub fn kill_all<R: Runtime>(app: &AppHandle<R>) {
    for Spawned { pid, .. } in app.state::<Procs>().running.lock().unwrap().values() {
        match std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output()
        {
            Ok(output) if output.status.success() => {}
            Ok(output) => eprintln!("tauride: cannot end test interpreter {pid}: {} {}",
                output.status, String::from_utf8_lossy(&output.stderr)),
            Err(e) => eprintln!("tauride: cannot end test interpreter {pid}: {e}"),
        }
    }
}

#[cfg(all(not(unix), not(all(windows, feature = "ui-tests"))))]
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
    let detached = cfg!(unix) && opts.detached.unwrap_or(false);
    #[cfg(unix)]
    if detached {
        cmd.process_group(0);
    }
    let mut child = cmd.spawn().map_err(|e| spawn_err(&e, &exe))?;
    let pid = child.id().unwrap_or(0);
    let stdin = child.stdin.take();
    // A process put in its own group leads it, so the group id is its pid.
    let group = (detached && pid > 0).then_some(pid as i32);
    app.state::<Procs>().insert(&id, pid, group, stdin);

    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let status = child.wait().await;
        app2.state::<Procs>().running.lock().unwrap().remove(&id);
        #[cfg(unix)]
        if let Some(group) = group {
            let app3 = app2.clone();
            tauri::async_runtime::spawn(async move { app3.state::<Procs>().release_group(group).await });
        }
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

/// kill(signal): SIGTERM by default, as in Node. Unlike Node, a detached
/// spawn's whole process group is signalled, so the interpreter a wrapper
/// script started ends with the wrapper.
#[tauri::command]
pub fn proc_kill<R: Runtime>(app: AppHandle<R>, id: String, signal: Option<String>) -> Result<(), String> {
    #[cfg(unix)]
    {
        let sig = match signal.as_deref() {
            Some("SIGKILL") => libc::SIGKILL,
            Some("SIGINT") => libc::SIGINT,
            Some("SIGHUP") => libc::SIGHUP,
            _ => libc::SIGTERM,
        };
        app.state::<Procs>().signal(&id, sig)
    }
    #[cfg(not(unix))]
    let pid = app
        .state::<Procs>()
        .running
        .lock()
        .unwrap()
        .get(&id)
        .map(|s| s.pid)
        .ok_or_else(|| format!("process {id} is not running"))?;
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

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::time::{Duration, Instant};

    fn alive(pid: i32) -> bool {
        unsafe { libc::kill(pid, 0) == 0 }
    }

    fn gone_within(pid: i32, limit: Duration) -> bool {
        let deadline = Instant::now() + limit;
        while Instant::now() < deadline {
            if !alive(pid) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    /// Ends a test's process group when the test does, whether or not it passed.
    struct Cleanup(i32);

    impl Drop for Cleanup {
        fn drop(&mut self) {
            unsafe { libc::kill(-self.0, libc::SIGKILL) };
        }
    }

    /// A detached leader whose one member, started in the background, reports its pid.
    /// `member` is the member's shell body.
    fn group(leader: &str, member: &str) -> (std::process::Child, i32, Cleanup) {
        use std::os::unix::process::CommandExt;
        let script = format!("({member}) & echo $!; {leader}");
        let mut child = std::process::Command::new("/bin/sh")
            .args(["-c", &script])
            .stdout(Stdio::piped())
            .process_group(0)
            .spawn()
            .unwrap();
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap()).read_line(&mut line).unwrap();
        let member = line.trim().parse().unwrap();
        assert!(alive(member));
        let cleanup = Cleanup(child.id() as i32);
        (child, member, cleanup)
    }

    const IGNORES_TERM: &str = "trap '' TERM; while :; do sleep 1; done";

    #[test]
    fn reap_ends_a_group_whose_leader_has_exited() {
        let procs = Procs::default();
        let (mut leader, member, _cleanup) = group("exit 0", IGNORES_TERM);
        let pgid = leader.id() as i32;
        procs.track_group(pgid);
        leader.wait().unwrap();
        assert!(alive(member), "the member outlives its leader");
        procs.reap();
        assert!(gone_within(member, Duration::from_secs(3)), "reap ends a member that ignores SIGTERM");
    }

    #[test]
    fn signal_reaches_every_member_of_a_detached_spawn() {
        let procs = Procs::default();
        let (mut leader, member, _cleanup) = group("wait", "sleep 600");
        let pid = leader.id();
        procs.insert("p1", pid, Some(pid as i32), None);
        procs.signal("p1", libc::SIGTERM).unwrap();
        assert!(gone_within(member, Duration::from_secs(3)), "the member receives the signal");
        leader.wait().unwrap();
        assert!(procs.signal("missing", libc::SIGTERM).is_err());
    }

    #[test]
    fn signal_reaches_only_the_process_of_a_spawn_without_its_own_group() {
        let procs = Procs::default();
        let (mut leader, member, _cleanup) = group("wait", "sleep 600");
        let pid = leader.id();
        procs.insert("p1", pid, None, None);
        procs.signal("p1", libc::SIGTERM).unwrap();
        leader.wait().unwrap();
        assert!(!gone_within(member, Duration::from_millis(500)), "only the recorded process is signalled");
    }

    #[tokio::test]
    async fn a_group_is_forgotten_once_it_is_empty() {
        let procs = std::sync::Arc::new(Procs::default());
        let (mut leader, member, _cleanup) = group("exit 0", "sleep 600");
        let pgid = leader.id() as i32;
        procs.track_group(pgid);
        leader.wait().unwrap();
        let watching = procs.clone();
        let released = tokio::spawn(async move { watching.release_group(pgid).await });
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(procs.tracked_groups(), vec![pgid], "a group with a live member stays tracked");
        unsafe { libc::kill(member, libc::SIGKILL) };
        tokio::time::timeout(Duration::from_secs(5), released).await.unwrap().unwrap();
        assert!(procs.tracked_groups().is_empty());
    }
}
