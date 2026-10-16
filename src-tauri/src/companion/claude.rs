use super::{
    executable_path, Descriptor, ExecutableSearch, PrivateDir, Prompt, Provider, ProviderEmit,
    ProviderFuture, Settings, SetupGuidance, SetupStatus, MAX_LINE,
};
use serde_json::Value;
use std::path::Path;
use std::process::{ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdout, Command};

const MAX_STDERR: usize = 4096;
const MAX_ERROR: usize = 1024;
const EXIT_GRACE: Duration = Duration::from_secs(3);
const TOOL: &str = "Claude Code requested a tool; error explanations allow none";

pub(super) static CLAUDE: Descriptor = Descriptor {
    id: "claude",
    name: "Claude Code",
    warm: false,
    enforces_no_tools: true,
    supports_model: true,
    docs_url: Some("https://code.claude.com/docs/en/quickstart"),
    guidance: SetupGuidance {
        missing: "Install Claude Code, then run claude auth login in a terminal to sign in.",
        signin: "Run claude auth login in a terminal to sign in. Check your executable in Preferences if Claude Code cannot be reached.",
        unavailable: "Update Claude Code and check its executable in Preferences, then check again.",
    },
};

static CLAUDE_EXECUTABLE: ExecutableSearch = ExecutableSearch {
    name: "Claude Code",
    binary: if cfg!(windows) {
        "claude.exe"
    } else {
        "claude"
    },
    locations: &["/opt/homebrew/bin/claude", "/usr/local/bin/claude"],
    home_locations: if cfg!(windows) {
        &[".local/bin/claude.exe", "AppData/Roaming/npm/claude.cmd"]
    } else {
        &[".local/bin/claude", ".claude/local/claude"]
    },
};

/// Every flag that keeps tools, MCP servers, user and project settings
/// (including hooks and plugins), slash commands and session history out of
/// the run. `--bare` is not used: it never reads the claude.ai sign-in.
fn arguments(prompt: &Prompt, model: &str) -> Vec<String> {
    let mut args: Vec<String> = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--tools",
        "",
        "--strict-mcp-config",
        "--setting-sources",
        "",
        "--no-session-persistence",
        "--disable-slash-commands",
        "--system-prompt",
    ]
    .map(String::from)
    .into();
    args.push(format!(
        "{}\n\n{}",
        prompt.base_instructions, prompt.developer_instructions
    ));
    let model = model.trim();
    if !model.is_empty() {
        // One argument, so a model beginning with '-' is never parsed as an option.
        args.push(format!("--model={model}"));
    }
    args
}

fn bounded(text: &str) -> &str {
    let mut end = text.len().min(MAX_ERROR);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

fn is_tool(block: &Value) -> bool {
    block["type"]
        .as_str()
        .is_some_and(|kind| kind.ends_with("tool_use") || kind.ends_with("tool_result"))
}

fn check_isolated(init: &Value) -> Result<(), String> {
    if !init["tools"].is_array() || !init["mcp_servers"].is_array() {
        return Err("Claude Code did not report its tools and MCP servers; update Claude Code".into());
    }
    if !init["tools"].as_array().is_some_and(Vec::is_empty) {
        return Err("Claude Code started with tools enabled; error explanations allow none".into());
    }
    if !init["mcp_servers"].as_array().is_some_and(Vec::is_empty) {
        return Err(
            "Claude Code started with MCP servers enabled; error explanations allow none".into(),
        );
    }
    Ok(())
}

async fn read_message(output: &mut BufReader<ChildStdout>) -> Result<Option<Value>, String> {
    loop {
        let mut bytes = Vec::new();
        let count = (&mut *output)
            .take((MAX_LINE + 1) as u64)
            .read_until(b'\n', &mut bytes)
            .await
            .map_err(|e| format!("Cannot read from Claude Code: {e}"))?;
        if count == 0 {
            return Ok(None);
        }
        if bytes.len() > MAX_LINE {
            return Err("Claude Code returned an oversized protocol message".into());
        }
        if bytes.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|_| "Claude Code returned invalid protocol data")?;
        if !value.is_object() {
            return Err("Claude Code returned invalid protocol data".into());
        }
        return Ok(Some(value));
    }
}

/// Drains stderr so a chatty process cannot block, keeping its first non-blank line.
async fn first_stderr_line(mut stderr: ChildStderr) -> String {
    let mut kept = Vec::new();
    let mut buf = [0; 4096];
    while let Ok(n) = stderr.read(&mut buf).await {
        if n == 0 {
            break;
        }
        let room = MAX_STDERR.saturating_sub(kept.len());
        kept.extend_from_slice(&buf[..n.min(room)]);
    }
    String::from_utf8_lossy(&kept)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| bounded(line).to_owned())
        .unwrap_or_default()
}

/// Waits up to `grace` for the process to exit by itself, then kills it; always reaps.
async fn reap(mut child: Child, grace: Duration) -> Option<ExitStatus> {
    if let Ok(status) = tokio::time::timeout(grace, child.wait()).await {
        return status.ok();
    }
    let _ = child.start_kill();
    match tokio::time::timeout(EXIT_GRACE, child.wait()).await {
        Ok(status) => status.ok(),
        Err(_) => {
            tauri::async_runtime::spawn(async move {
                let _ = child.wait().await;
            });
            None
        }
    }
}

pub(super) struct ClaudeProvider {
    executable: String,
    child: Arc<Mutex<Option<Child>>>,
}

impl ClaudeProvider {
    pub(super) fn new(settings: &Settings, child: Arc<Mutex<Option<Child>>>) -> Self {
        Self {
            executable: settings.executable.clone(),
            child,
        }
    }

    async fn release(&mut self, grace: Duration) -> Option<ExitStatus> {
        let child = self.child.lock().unwrap().take();
        match child {
            Some(child) => reap(child, grace).await,
            None => None,
        }
    }

    async fn run(
        &mut self,
        cwd: &PrivateDir,
        prompt: &Prompt,
        model: &str,
        emit: &mut ProviderEmit<'_>,
    ) -> Result<(), String> {
        let path = executable_path(&self.executable, &CLAUDE_EXECUTABLE)?;
        let mut command = Command::new(path);
        command
            .args(arguments(prompt, model))
            .current_dir(&cwd.0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command.spawn().map_err(|e| {
            format!("Cannot start Claude Code: {e}. Check the executable path and sign in with Claude Code.")
        })?;
        let input = child.stdin.take().ok_or("Claude Code stdin unavailable")?;
        let output = child
            .stdout
            .take()
            .ok_or("Claude Code stdout unavailable")?;
        let stderr = child
            .stderr
            .take()
            .ok_or("Claude Code stderr unavailable")?;
        *self.child.lock().unwrap() = Some(child);
        let stderr = tokio::spawn(first_stderr_line(stderr));
        let mut input = input;
        // A process that exits before reading its input is reported by its exit status.
        let _ = input.write_all(prompt.user_text().as_bytes()).await;
        drop(input);

        let mut output = BufReader::new(output);
        let mut initialised = false;
        let mut streamed = false;
        while let Some(message) = read_message(&mut output).await? {
            let kind = message["type"].as_str().unwrap_or_default();
            if kind == "system" && message["subtype"] == "init" {
                check_isolated(&message)?;
                initialised = true;
                emit("status", "Explaining".into())?;
                continue;
            }
            if !initialised && matches!(kind, "stream_event" | "assistant" | "result") {
                return Err("Claude Code responded before reporting its configuration".into());
            }
            match kind {
                "stream_event" => {
                    let event = &message["event"];
                    if is_tool(&event["content_block"]) {
                        return Err(TOOL.into());
                    }
                    if event["type"] == "content_block_delta" {
                        match event["delta"]["type"].as_str() {
                            Some("text_delta") => {
                                let text = event["delta"]["text"]
                                    .as_str()
                                    .ok_or("Claude Code returned an invalid text delta")?;
                                if !text.is_empty() {
                                    streamed = true;
                                    emit("delta", text.into())?;
                                }
                            }
                            Some("input_json_delta") => return Err(TOOL.into()),
                            _ => {}
                        }
                    }
                }
                "assistant" => {
                    if message["message"]["content"]
                        .as_array()
                        .is_some_and(|content| content.iter().any(is_tool))
                    {
                        return Err(TOOL.into());
                    }
                }
                "result" => {
                    let text = message["result"].as_str().unwrap_or_default();
                    if message["is_error"] != false {
                        let text = if text.is_empty() {
                            "request failed"
                        } else {
                            bounded(text)
                        };
                        return Err(format!("Claude Code: {text}"));
                    }
                    if !streamed {
                        if text.is_empty() {
                            return Err("Claude Code completed without an explanation".into());
                        }
                        emit("delta", text.into())?;
                    }
                    return Ok(());
                }
                _ => {}
            }
        }
        let status = self.release(EXIT_GRACE).await;
        let detail = tokio::time::timeout(Duration::from_secs(1), stderr)
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or_default();
        let detail = if detail.is_empty() {
            String::new()
        } else {
            format!(": {detail}")
        };
        Err(match status {
            Some(status) if !status.success() => match status.code() {
                Some(code) => format!("Claude Code exited with code {code}{detail}"),
                None => format!("Claude Code was terminated{detail}"),
            },
            _ => format!("Claude Code exited before completing the explanation{detail}"),
        })
    }
}

impl Provider for ClaudeProvider {
    fn descriptor(&self) -> &'static Descriptor {
        &CLAUDE
    }
    fn reusable(&self) -> bool {
        false
    }
    fn check(&mut self, timeout: Duration) -> ProviderFuture<'_, SetupStatus> {
        Box::pin(check_setup(self.executable.clone(), timeout))
    }
    fn explain<'a>(
        &'a mut self,
        prompt: &'a Prompt,
        model: &'a str,
        emit: &'a mut ProviderEmit<'_>,
    ) -> ProviderFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let cwd = PrivateDir::create()?;
            self.run(&cwd, prompt, model, emit).await
        })
    }
    fn stop(&mut self) -> ProviderFuture<'_, ()> {
        Box::pin(async move {
            self.release(Duration::ZERO).await;
        })
    }
}

async fn auth_status(path: &Path, timeout: Duration) -> Option<Value> {
    let cwd = PrivateDir::create().ok()?;
    let mut command = Command::new(path);
    command
        .args(["auth", "status", "--json"])
        .current_dir(&cwd.0)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let mut bytes = Vec::new();
    let read = tokio::time::timeout(
        timeout,
        (&mut stdout).take(MAX_LINE as u64).read_to_end(&mut bytes),
    )
    .await;
    drop(stdout);
    reap(child, Duration::ZERO).await;
    match read {
        Ok(Ok(_)) => serde_json::from_slice(&bytes).ok().filter(Value::is_object),
        _ => None,
    }
}

async fn check_setup(executable: String, timeout: Duration) -> SetupStatus {
    let path = executable_path(&executable, &CLAUDE_EXECUTABLE)
        .ok()
        .filter(|p| p.is_file());
    let Some(path) = path else {
        return SetupStatus {
            status: "missing",
            message: "Claude Code was not found. Install Claude Code or choose its executable in Preferences.",
            executable: None,
        };
    };
    let status = match auth_status(&path, timeout).await {
        Some(account) if account["loggedIn"] == true => "ready",
        Some(account) if account["loggedIn"] == false => "signin",
        _ => "unavailable",
    };
    SetupStatus {
        status,
        message: match status {
            "ready" => "Claude Code is ready to explain errors.",
            "signin" => "Sign in with Claude Code, then check again.",
            _ => "Could not check Claude Code. Update Claude Code, verify its executable in Preferences, and try again.",
        },
        executable: Some(path.to_string_lossy().into_owned()),
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
            "tauride-claude-fixture-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir(&dir).unwrap();
        let script = dir.join("claude");
        std::fs::write(&script, include_str!("../../tests/fixtures/fake-claude.py")).unwrap();
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

    async fn explain(
        session: &Session,
        executable: &str,
        model: &str,
        prompt: &Prompt,
    ) -> (Result<(), String>, String) {
        let config = json!({ "executable": executable, "model": model });
        let (candidate, settings) =
            configuration("claude", &config, session.child.clone()).unwrap();
        let (cancelled, completed) = session.begin("request").unwrap();
        let mut text = String::new();
        let result = session
            .execute(
                cancelled,
                completed,
                candidate,
                &settings,
                prompt,
                |event, delta| {
                    if event == "delta" {
                        text.push_str(&delta);
                    }
                },
            )
            .await;
        (result, text)
    }

    async fn gone(pid: i32) {
        tokio::time::timeout(Duration::from_secs(3), async {
            while unsafe { libc::kill(pid, 0) } == 0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the request's process must be killed and reaped");
    }

    fn pid(executable: &str) -> i32 {
        std::fs::read_to_string(format!("{executable}.pid"))
            .unwrap()
            .parse()
            .unwrap()
    }

    #[test]
    fn claude_is_registered_as_a_cold_tool_free_provider_with_a_model() {
        let registry = serde_json::to_value(companion_providers()).unwrap();
        assert_eq!(registry[0]["id"], "codex");
        let claude = registry
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["id"] == "claude")
            .expect("claude is registered");
        assert_eq!(claude["name"], "Claude Code");
        assert_eq!(claude["warm"], false);
        assert_eq!(claude["enforces_no_tools"], true);
        assert_eq!(claude["supports_model"], true);
        assert!(claude["docs_url"].as_str().unwrap().starts_with("https://"));
        for state in ["missing", "signin", "unavailable"] {
            assert!(
                !claude["guidance"][state].as_str().unwrap().is_empty(),
                "{state}"
            );
        }
        let (instance, settings) =
            configuration("claude", &json!({"model": "m"}), Arc::default()).unwrap();
        assert_eq!(instance.descriptor.id, "claude");
        assert!(std::ptr::eq(
            instance.provider.descriptor(),
            instance.descriptor
        ));
        assert!(!instance.provider.reusable());
        assert_eq!(
            settings.process_identity(instance.descriptor).provider,
            "claude"
        );
    }

    #[tokio::test]
    async fn claude_runs_isolated_with_instructions_as_system_prompt_and_the_snapshot_on_stdin() {
        let (dir, executable) = fixture();
        let context = json!({"id": 7, "message": "RANK ERROR"});
        let prompt = explanation_prompt(&context).unwrap();
        let session = Session::default();
        for model in [" model-one ", "--tools=Bash", ""] {
            let (result, text) = explain(&session, &executable, model, &prompt).await;
            result.unwrap();
            assert_eq!(text, "The array ranks differ. Check the operands.");
        }
        let recorded = requests(&executable);
        assert_eq!(recorded.len(), 3);
        let system = format!(
            "{}\n\n{}",
            prompt.base_instructions, prompt.developer_instructions
        );
        let isolated = [
            "-p",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--tools",
            "",
            "--strict-mcp-config",
            "--setting-sources",
            "",
            "--no-session-persistence",
            "--disable-slash-commands",
            "--system-prompt",
            system.as_str(),
        ];
        let argv = |model: Option<&str>| {
            let mut argv: Vec<Value> = isolated.iter().map(|a| json!(a)).collect();
            if let Some(model) = model {
                argv.push(json!(format!("--model={model}")));
            }
            Value::Array(argv)
        };
        assert_eq!(recorded[0]["argv"], argv(Some("model-one")));
        assert_eq!(
            recorded[1]["argv"],
            argv(Some("--tools=Bash")),
            "a model is always a value, never an option"
        );
        assert_eq!(recorded[2]["argv"], argv(None));
        let snapshot = serde_json::to_string(&context).unwrap();
        assert!(snapshot.contains("RANK ERROR"));
        let mut cwds = Vec::new();
        for request in &recorded {
            assert_eq!(
                request["stdin"],
                format!("{}{}", prompt.user_prefix, snapshot)
            );
            assert_eq!(request["cwdEntries"], json!([]));
            let cwd = PathBuf::from(request["cwd"].as_str().unwrap());
            assert!(cwd
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("tauride-companion-"));
            assert!(!cwd.exists(), "the private working directory is removed");
            cwds.push(cwd);
        }
        cwds.dedup();
        assert_eq!(cwds.len(), 3, "each request has its own working directory");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn claude_text_comes_from_stream_deltas_once_or_from_a_done_only_result() {
        let (dir, executable) = fixture();
        let session = Session::default();
        let (result, text) = explain(&session, &executable, "", &Prompt::raw("RANK ERROR")).await;
        result.unwrap();
        assert_eq!(text, "The array ranks differ. Check the operands.");
        let (result, text) =
            explain(&session, &executable, "", &Prompt::raw("FIXTURE_DONE_ONLY")).await;
        result.unwrap();
        assert_eq!(text, "Only the final text.");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn claude_failures_and_tool_use_never_become_explanations() {
        let (dir, executable) = fixture();
        let session = Session::default();
        for (marker, expected) in [
            ("FIXTURE_IS_ERROR", "Credit balance is too low"),
            ("FIXTURE_NONZERO", "unknown option '--tools'"),
            ("FIXTURE_TOOL", "tool"),
            ("FIXTURE_TOOLS_ENABLED", "tool"),
            ("FIXTURE_MCP_ENABLED", "MCP"),
            ("FIXTURE_TOOLS_UNREPORTED", "did not report"),
            ("FIXTURE_OVERSIZED", "oversized"),
            ("FIXTURE_MALFORMED", "invalid"),
            ("FIXTURE_NO_RESULT", "before completing"),
        ] {
            let (result, text) = explain(&session, &executable, "", &Prompt::raw(marker)).await;
            let error = result.expect_err(marker);
            assert!(error.starts_with("Claude"), "{marker}: {error}");
            assert!(error.contains(expected), "{marker}: {error}");
            assert!(!error.contains("second line"), "{marker}: {error}");
            assert!(
                text.is_empty() || marker == "FIXTURE_NO_RESULT",
                "{marker}: {text}"
            );
            assert!(session.child.lock().unwrap().is_none(), "{marker}");
            assert!(session.provider.lock().await.is_none(), "{marker}");
            gone(pid(&executable)).await;
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn claude_request_process_is_released_after_completion() {
        let (dir, executable) = fixture();
        let session = Session::default();
        for _ in 0..2 {
            let (result, _) = explain(&session, &executable, "", &Prompt::raw("RANK ERROR")).await;
            result.unwrap();
            assert!(session.child.lock().unwrap().is_none());
            assert!(session.provider.lock().await.is_none());
            assert!(session.active.lock().unwrap().is_none());
            gone(pid(&executable)).await;
        }
        assert_eq!(
            std::fs::read_to_string(format!("{executable}.log")).unwrap(),
            "explain\nexplain\n"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn claude_cancel_and_terminate_kill_the_running_request() {
        for terminate in [false, true] {
            let (dir, executable) = fixture();
            let session = Arc::new(Session::default());
            let running = session.clone();
            let path = executable.clone();
            let task = tokio::spawn(async move {
                explain(&running, &path, "", &Prompt::raw("FIXTURE_WAIT")).await
            });
            let pid = tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    if let Ok(text) = std::fs::read_to_string(format!("{executable}.pid")) {
                        if let Ok(pid) = text.parse::<i32>() {
                            break pid;
                        }
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
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
            assert!(session.child.lock().unwrap().is_none());
            assert!(session.active.lock().unwrap().is_none());
            gone(pid).await;
            assert!(session.begin("retry").is_ok());
            std::fs::remove_dir_all(dir).unwrap();
        }
    }

    #[tokio::test]
    async fn claude_setup_reads_auth_status_only_and_reaps_every_outcome() {
        for (mode, expected) in [
            ("ready", "ready"),
            ("signin", "signin"),
            ("malformed", "unavailable"),
            ("wait", "unavailable"),
        ] {
            let (dir, executable) = fixture();
            std::fs::write(format!("{executable}.account"), mode).unwrap();
            let (mut probe, _) = configuration(
                "claude",
                &json!({ "executable": executable }),
                Arc::default(),
            )
            .unwrap();
            let status = probe.provider.check(Duration::from_secs(2)).await;
            assert_eq!(status.status, expected, "{mode}");
            let serialized = serde_json::to_string(&status).unwrap();
            assert!(!serialized.contains("secret@example.com"), "{mode}");
            assert!(requests(&executable).is_empty(), "{mode}: no inference");
            assert_eq!(
                std::fs::read_to_string(format!("{executable}.log")).unwrap(),
                "auth\n",
                "{mode}"
            );
            gone(pid(&executable)).await;
            std::fs::remove_dir_all(dir).unwrap();
        }
        let (dir, executable) = fixture();
        let (mut probe, _) = configuration(
            "claude",
            &json!({ "executable": format!("{executable}-missing") }),
            Arc::default(),
        )
        .unwrap();
        assert_eq!(
            probe.provider.check(Duration::from_secs(2)).await.status,
            "missing"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
