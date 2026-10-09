//! The transcript file behind the frontend tap (src/agent.js): one JSON
//! event per line, appended as the session runs. The tap batches events and
//! hands each batch to `transcript_append`; Rust owns the file so no write
//! ever runs on the webview's thread. One writer task per path takes the
//! batches off a bounded queue, and everything queued while a write is in
//! progress goes out in the next one, so a burst of events costs few writes.
//! At 32 MB the file moves to `<path>.1` (one generation kept) and a new one
//! starts. Failures are logged, not reported per line: a lost transcript
//! line must never break the session (tauri/agent-pairing.md).

use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Runtime};
use tokio::sync::mpsc;

const LIMIT: u64 = 32 * 1024 * 1024;
/// Batches a writer may have waiting. Past this, `transcript_append` waits
/// for the writer instead of letting the queue grow without bound.
const QUEUE: usize = 64;

#[derive(Default)]
pub struct Transcript {
    writers: Mutex<HashMap<String, mpsc::Sender<Vec<String>>>>,
}

fn rotated_path(path: &Path) -> PathBuf {
    let mut p = path.as_os_str().to_owned();
    p.push(".1");
    PathBuf::from(p)
}

/// The open file for one path and how large it is, kept between batches so
/// a batch costs one write and no reopen.
struct Appender {
    path: PathBuf,
    file: Option<File>,
    size: u64,
}

impl Appender {
    fn new(path: PathBuf) -> Self {
        Appender { path, file: None, size: 0 }
    }

    fn open(&mut self) -> std::io::Result<&mut File> {
        if self.file.is_none() {
            if let Some(dir) = self.path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            let f = File::options().create(true).append(true).open(&self.path)?;
            self.size = f.metadata()?.len();
            self.file = Some(f);
        }
        Ok(self.file.as_mut().unwrap())
    }

    /// Moves the current file aside as `<path>.1`. The file is closed first:
    /// Windows refuses to rename a file this process holds open.
    fn rotate(&mut self) -> std::io::Result<()> {
        self.file = None;
        self.size = 0;
        std::fs::rename(&self.path, rotated_path(&self.path))
    }

    fn write(&mut self, lines: &[String]) -> std::io::Result<()> {
        let mut buf = Vec::with_capacity(lines.iter().map(|l| l.len() + 1).sum());
        for l in lines {
            buf.extend_from_slice(l.as_bytes());
            buf.push(b'\n');
        }
        self.open()?;
        if self.size > 0 && self.size + buf.len() as u64 > LIMIT {
            self.rotate()?;
        }
        let f = self.open()?;
        f.write_all(&buf)?;
        self.size += buf.len() as u64;
        Ok(())
    }

    fn append(&mut self, lines: &[String]) {
        if let Err(e) = self.write(lines) {
            eprintln!("tauride: transcript {}: {e}", self.path.display());
            // A failed descriptor is not trusted again; the next batch reopens.
            self.file = None;
        }
    }
}

/// Serves one path: takes a batch, adds whatever else has queued up behind
/// it, and writes the lot in one go off the async runtime's threads.
async fn writer(path: PathBuf, mut rx: mpsc::Receiver<Vec<String>>) {
    let mut appender = Appender::new(path.clone());
    while let Some(mut batch) = rx.recv().await {
        while let Ok(more) = rx.try_recv() {
            batch.extend(more);
        }
        appender = match tauri::async_runtime::spawn_blocking(move || {
            appender.append(&batch);
            appender
        })
        .await
        {
            Ok(a) => a,
            Err(e) => {
                eprintln!("tauride: transcript {}: writer: {e}", path.display());
                Appender::new(path.clone())
            }
        };
    }
}

/// Appends the lines, each with a newline, to the file at `path`. Returns
/// once the batch is queued; the write happens on the path's writer task.
#[tauri::command]
pub async fn transcript_append<R: Runtime>(app: AppHandle<R>, path: String, lines: Vec<String>) {
    if lines.is_empty() {
        return;
    }
    let tx = {
        let transcript = app.state::<Transcript>();
        let mut writers = transcript.writers.lock().unwrap();
        writers
            .entry(path.clone())
            .or_insert_with(|| {
                let (tx, rx) = mpsc::channel(QUEUE);
                tauri::async_runtime::spawn(writer(PathBuf::from(&path), rx));
                tx
            })
            .clone()
    };
    if tx.send(lines).await.is_err() {
        eprintln!("tauride: transcript {path}: writer is gone");
    }
}

/// The file's size on disk and whether a rotated generation exists.
#[tauri::command]
pub async fn transcript_status(path: String) -> Value {
    tauri::async_runtime::spawn_blocking(move || {
        let path = Path::new(&path);
        let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        json!({ "size": size, "rotated": rotated_path(path).exists() })
    })
    .await
    .unwrap_or_else(|_| json!({ "size": 0, "rotated": false }))
}
