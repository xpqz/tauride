use super::{
    configured_executable, Descriptor, PrivateDir, Prompt, Provider, ProviderEmit, ProviderFuture,
    SetupGuidance, SetupStatus, Settings,
};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStderr, Command};

const MAX_STDERR: usize = 4096;
const EXIT_GRACE: Duration = Duration::from_secs(3);

pub(super) static COMMAND: Descriptor = Descriptor {
    id: "command",
    name: "Custom command",
    warm: false,
    enforces_no_tools: false,
    supports_model: false,
    supports_args: true,
    docs_url: None,
    guidance: SetupGuidance {
        missing: "Choose the command's executable, and its arguments one per line, in Preferences.",
        signin: "Sign in to the command's service as its documentation describes, then check again.",
        unavailable: "Check the command's executable and arguments in Preferences.",
    },
};

/// One program argument per line (`lines` also drops a trailing `\r`); no
/// shell. Blank lines are skipped.
fn arguments(args: &str) -> Vec<String> {
    args.lines()
        .filter(|line| !line.trim().is_empty())
        .map(String::from)
        .collect()
}

fn resolve(executable: &str) -> Option<PathBuf> {
    let executable = executable.trim();
    if executable.is_empty() {
        return None;
    }
    configured_executable(executable, std::env::var_os("PATH").as_deref()).filter(|p| p.is_file())
}

/// The longest prefix of `bytes` that is complete UTF-8, decoded; invalid
/// sequences become U+FFFD. Bytes of a character still arriving stay in `bytes`.
fn decode(bytes: &mut Vec<u8>) -> String {
    let mut text = String::new();
    loop {
        match std::str::from_utf8(bytes) {
            Ok(valid) => {
                text.push_str(valid);
                bytes.clear();
                return text;
            }
            Err(e) => {
                let valid = e.valid_up_to();
                text.push_str(std::str::from_utf8(&bytes[..valid]).unwrap());
                match e.error_len() {
                    Some(invalid) => {
                        text.push('\u{FFFD}');
                        bytes.drain(..valid + invalid);
                    }
                    None => {
                        bytes.drain(..valid);
                        return text;
                    }
                }
            }
        }
    }
}

/// Drains stderr so a chatty command cannot block, keeping its first bytes.
async fn stderr_head(mut stderr: ChildStderr) -> String {
    let mut kept = Vec::new();
    let mut buf = [0; 4096];
    while let Ok(n) = stderr.read(&mut buf).await {
        if n == 0 {
            break;
        }
        let room = MAX_STDERR.saturating_sub(kept.len());
        kept.extend_from_slice(&buf[..n.min(room)]);
    }
    String::from_utf8_lossy(&kept).trim().to_owned()
}

pub(super) struct CommandProvider {
    executable: String,
    args: String,
    child: Arc<Mutex<Option<Child>>>,
    group: Option<i32>,
}

impl CommandProvider {
    pub(super) fn new(settings: &Settings, child: Arc<Mutex<Option<Child>>>) -> Self {
        Self {
            executable: settings.executable.clone(),
            args: settings.args.clone(),
            child,
            group: None,
        }
    }

    /// Ends the command with everything it started, and reaps it.
    async fn release(&mut self) {
        #[cfg(unix)]
        if let Some(group) = self.group.take() {
            unsafe { libc::kill(-group, libc::SIGKILL) };
        }
        let child = self.child.lock().unwrap().take();
        if let Some(mut child) = child {
            let _ = child.start_kill();
            let _ = tokio::time::timeout(EXIT_GRACE, child.wait()).await;
        }
    }

    async fn run(
        &mut self,
        cwd: &PrivateDir,
        prompt: &Prompt,
        emit: &mut ProviderEmit<'_>,
    ) -> Result<(), String> {
        let path = resolve(&self.executable)
            .ok_or("Choose the custom command's executable in Preferences")?;
        let mut command = Command::new(path);
        command
            .args(arguments(&self.args))
            .current_dir(&cwd.0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        command.process_group(0);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command
            .spawn()
            .map_err(|e| format!("Cannot start the custom command: {e}"))?;
        let input = child.stdin.take().ok_or("The custom command's stdin is unavailable")?;
        let mut output = child.stdout.take().ok_or("The custom command's stdout is unavailable")?;
        let stderr = child.stderr.take().ok_or("The custom command's stderr is unavailable")?;
        // A process put in its own group leads it, so the group id is its pid.
        self.group = child.id().map(|pid| pid as i32);
        *self.child.lock().unwrap() = Some(child);
        let stderr = tokio::spawn(stderr_head(stderr));
        let mut input = input;
        // A command that exits before reading its input is reported by its exit status.
        let _ = input
            .write_all(
                format!(
                    "{}\n\n{}\n\n{}",
                    prompt.base_instructions,
                    prompt.developer_instructions,
                    prompt.user_text()
                )
                .as_bytes(),
            )
            .await;
        drop(input);

        let mut streamed = false;
        let mut pending = Vec::new();
        let mut buf = [0; 8192];
        loop {
            let n = output
                .read(&mut buf)
                .await
                .map_err(|e| format!("Cannot read from the custom command: {e}"))?;
            if n == 0 {
                break;
            }
            pending.extend_from_slice(&buf[..n]);
            let text = decode(&mut pending);
            if !text.is_empty() {
                streamed = true;
                emit("delta", text)?;
            }
        }
        if !pending.is_empty() {
            streamed = true;
            emit("delta", String::from_utf8_lossy(&pending).into_owned())?;
        }

        let child = self.child.lock().unwrap().take();
        let status = match child {
            Some(mut child) => match tokio::time::timeout(EXIT_GRACE, child.wait()).await {
                Ok(status) => status.ok(),
                Err(_) => {
                    *self.child.lock().unwrap() = Some(child);
                    return Err("The custom command closed its output but did not exit".into());
                }
            },
            None => None,
        };
        let detail = tokio::time::timeout(Duration::from_secs(1), stderr)
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or_default();
        let detail = if detail.is_empty() { String::new() } else { format!(": {detail}") };
        match status {
            Some(status) if status.success() && streamed => Ok(()),
            Some(status) if status.success() => {
                Err(format!("The custom command finished without an explanation{detail}"))
            }
            Some(status) => Err(match status.code() {
                Some(code) => format!("The custom command exited with code {code}{detail}"),
                None => format!("The custom command was terminated{detail}"),
            }),
            None => Err(format!("The custom command did not report its exit status{detail}")),
        }
    }
}

impl Provider for CommandProvider {
    fn descriptor(&self) -> &'static Descriptor {
        &COMMAND
    }
    fn reusable(&self) -> bool {
        false
    }
    fn check(&mut self, _timeout: Duration) -> ProviderFuture<'_, SetupStatus> {
        let resolved = resolve(&self.executable);
        Box::pin(async move {
            match resolved {
                Some(path) => SetupStatus {
                    status: "ready",
                    message: "The custom command is ready to explain errors.",
                    executable: Some(path.to_string_lossy().into_owned()),
                },
                None => SetupStatus {
                    status: "missing",
                    message: "The custom command's executable was not found. Choose it in Preferences.",
                    executable: None,
                },
            }
        })
    }
    fn explain<'a>(
        &'a mut self,
        prompt: &'a Prompt,
        _model: &'a str,
        emit: &'a mut ProviderEmit<'_>,
    ) -> ProviderFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let cwd = PrivateDir::create()?;
            self.run(&cwd, prompt, emit).await
        })
    }
    fn stop(&mut self) -> ProviderFuture<'_, ()> {
        Box::pin(async move {
            self.release().await;
        })
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::super::*;
    use serde_json::json;

    fn fixture() -> (PathBuf, String) {
        use std::os::unix::fs::PermissionsExt;
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let dir = std::env::temp_dir().join(format!(
            "tauride-command-fixture-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir(&dir).unwrap();
        let script = dir.join("explain");
        std::fs::write(&script, include_str!("../../tests/fixtures/fake-command.py")).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        // Linux refuses to exec a file that a concurrently forked child still holds
        // open for writing (ETXTBSY); after one successful exec no such copy remains.
        for _ in 0..200 {
            match std::process::Command::new(&script)
                .arg("--fixture-ready")
                .stdin(Stdio::null())
                .status()
            {
                Err(e) if e.raw_os_error() == Some(libc::ETXTBSY) => {
                    std::thread::sleep(Duration::from_millis(10))
                }
                result => {
                    assert!(result.unwrap().success());
                    break;
                }
            }
        }
        (dir, script.to_string_lossy().into_owned())
    }

    fn requests(executable: &str) -> Vec<Value> {
        std::fs::read_to_string(format!("{executable}.requests"))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn pid(executable: &str, suffix: &str) -> i32 {
        std::fs::read_to_string(format!("{executable}.{suffix}"))
            .unwrap()
            .trim()
            .parse()
            .unwrap()
    }

    async fn gone(pid: i32) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while unsafe { libc::kill(pid, 0) } == 0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the command's process must be killed and reaped");
    }

    /// Kills a process a test started indirectly, whether or not the test passed.
    struct Cleanup(i32);

    impl Drop for Cleanup {
        fn drop(&mut self) {
            unsafe { libc::kill(self.0, libc::SIGKILL) };
        }
    }

    async fn explain(
        session: &Session,
        executable: &str,
        args: &str,
        prompt: &Prompt,
    ) -> (Result<(), String>, String) {
        let config = json!({ "executable": executable, "args": args });
        let (candidate, settings) =
            configuration("command", &config, session.child.clone()).unwrap();
        let (cancelled, completed) = session.begin("request").unwrap();
        let mut text = String::new();
        let result = session
            .execute(cancelled, completed, candidate, &settings, prompt, |event, delta| {
                if event == "delta" {
                    text.push_str(&delta);
                }
            })
            .await;
        (result, text)
    }

    #[test]
    fn command_is_registered_without_enforced_isolation_and_takes_arguments() {
        let registry = serde_json::to_value(companion_providers()).unwrap();
        let command = registry
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["id"] == "command")
            .expect("command is registered");
        assert_eq!(command["name"], "Custom command");
        assert_eq!(command["warm"], false);
        assert_eq!(command["enforces_no_tools"], false);
        assert_eq!(command["supports_model"], false);
        assert_eq!(command["supports_args"], true);
        assert!(command["docs_url"].is_null());
        for state in ["missing", "unavailable"] {
            assert!(!command["guidance"][state].as_str().unwrap().is_empty(), "{state}");
        }
        for other in ["codex", "claude"] {
            let provider = registry.as_array().unwrap().iter().find(|p| p["id"] == other).unwrap();
            assert_eq!(provider["supports_args"], false, "{other}");
            assert!(configuration(other, &json!({"args": "x"}), Arc::default()).is_err(), "{other}");
        }
        let (instance, settings) =
            configuration("command", &json!({"executable": "/bin/echo", "args": "a\nb"}), Arc::default()).unwrap();
        assert_eq!(instance.descriptor.id, "command");
        assert!(!instance.provider.reusable());
        assert_eq!(settings.args, "a\nb");
        for invalid in [
            json!({"model": "m"}),
            json!({"args": 3}),
            json!({"args": "x".repeat(4097)}),
            json!({"args": "a\u{0}b"}),
        ] {
            assert!(configuration("command", &invalid, Arc::default()).is_err(), "{invalid}");
        }
    }

    #[tokio::test]
    async fn command_runs_its_arguments_with_the_whole_prompt_on_stdin() {
        let (dir, executable) = fixture();
        let context = json!({"id": 7, "message": "RANK ERROR"});
        let prompt = explanation_prompt(&context).unwrap();
        let session = Session::default();
        let (result, text) =
            explain(&session, &executable, "stream\r\n\n--flag=a b\n-x\n", &prompt).await;
        result.unwrap();
        assert_eq!(text, "The array ranks differ. Check the operands.");
        let recorded = requests(&executable);
        assert_eq!(recorded.len(), 1);
        assert_eq!(
            recorded[0]["argv"],
            json!(["stream", "--flag=a b", "-x"]),
            "one argument per line, no shell, blank lines skipped"
        );
        let snapshot = serde_json::to_string(&context).unwrap();
        assert!(snapshot.contains("RANK ERROR"));
        assert_eq!(
            recorded[0]["stdin"],
            format!(
                "{}\n\n{}\n\n{}{}",
                prompt.base_instructions, prompt.developer_instructions, prompt.user_prefix, snapshot
            )
        );
        assert_eq!(recorded[0]["cwdEntries"], json!([]));
        let cwd = PathBuf::from(recorded[0]["cwd"].as_str().unwrap());
        assert!(cwd.file_name().unwrap().to_string_lossy().starts_with("tauride-companion-"));
        assert!(!cwd.exists(), "the private working directory is removed");
        assert!(session.child.lock().unwrap().is_none());
        assert!(session.provider.lock().await.is_none());
        gone(pid(&executable, "pid")).await;
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn command_output_is_streamed_as_text_without_splitting_characters() {
        let (dir, executable) = fixture();
        let session = Session::default();
        let (result, text) = explain(&session, &executable, "utf8", &Prompt::raw("RANK ERROR")).await;
        result.unwrap();
        assert_eq!(text, "Use ⍴ to check.");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn command_failures_never_become_explanations() {
        let (dir, executable) = fixture();
        let session = Session::default();
        let (result, _) = explain(&session, &executable, "fail", &Prompt::raw("E")).await;
        let error = result.unwrap_err();
        assert!(error.contains("exited with code 3"), "{error}");
        assert!(error.contains("model not found"), "{error}");
        assert!(error.len() < 4096 + 200, "stderr is bounded: {} bytes", error.len());
        let (result, _) = explain(&session, &executable, "silent", &Prompt::raw("E")).await;
        assert!(result.unwrap_err().contains("without an explanation"));
        let (result, _) = explain(&session, &executable, "linger", &Prompt::raw("E")).await;
        assert!(result.unwrap_err().contains("did not exit"));
        gone(pid(&executable, "pid")).await;
        let missing = format!("{executable}-missing");
        let (result, _) = explain(&session, &missing, "stream", &Prompt::raw("E")).await;
        assert!(result.is_err());
        let (result, _) = explain(&session, "", "stream", &Prompt::raw("E")).await;
        assert!(result.is_err(), "a command needs an executable");
        assert!(session.child.lock().unwrap().is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn cancel_and_terminate_end_the_command_and_what_it_started() {
        for terminate in [false, true] {
            let (dir, executable) = fixture();
            let session = Arc::new(Session::default());
            let running = session.clone();
            let path = executable.clone();
            let task = tokio::spawn(async move {
                explain(&running, &path, "grandchild", &Prompt::raw("E")).await
            });
            let grandchild = tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    if let Ok(text) = std::fs::read_to_string(format!("{executable}.grandchild")) {
                        if let Ok(pid) = text.trim().parse::<i32>() {
                            break pid;
                        }
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            let _cleanup = Cleanup(grandchild);
            let command = pid(&executable, "pid");
            if terminate {
                session.terminate();
            } else {
                let mut completed = session.cancel("request").unwrap();
                if !*completed.borrow() {
                    completed.changed().await.unwrap();
                }
            }
            let (result, _) = tokio::time::timeout(Duration::from_secs(5), task)
                .await
                .unwrap()
                .unwrap();
            assert!(result.is_err());
            gone(command).await;
            gone(grandchild).await;
            assert!(session.child.lock().unwrap().is_none());
            assert!(session.begin("retry").is_ok());
            std::fs::remove_dir_all(dir).unwrap();
        }
    }

    #[tokio::test]
    async fn command_setup_checks_only_that_the_executable_resolves() {
        let (dir, executable) = fixture();
        for (path, expected) in [
            (executable.clone(), "ready"),
            (format!("{executable}-missing"), "missing"),
            (String::new(), "missing"),
        ] {
            let (mut probe, _) =
                configuration("command", &json!({ "executable": path }), Arc::default()).unwrap();
            assert_eq!(probe.provider.check(Duration::from_secs(2)).await.status, expected, "{path}");
        }
        assert!(requests(&executable).is_empty(), "the setup check never runs the command");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
