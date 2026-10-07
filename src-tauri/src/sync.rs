//! Synchronous operations behind the `ridesync://` scheme. The webview shim
//! calls these with synchronous XHR wherever RIDE's code expects Node's or
//! Electron's synchronous APIs (fs.*Sync, dialog *Sync, window getters).
//!
//! Request: `ridesync://localhost/<op>` with a JSON argument object as the
//! POST body or, for GETs, the `a` query parameter. Response: JSON, either
//! `{"ok": value}` or `{"err": {"code": "ENOENT", "message": "..."}}`, the
//! shape the shim turns back into a returned value or a Node-style error.

use serde_json::{json, Value};
use std::fs;
use std::io::{self, Write};
use std::path::Path;
use std::time::UNIX_EPOCH;

pub type Result = std::result::Result<Value, Value>;

pub fn err(code: &str, message: impl Into<String>) -> Value {
    json!({ "code": code, "message": message.into() })
}

fn io_err(e: io::Error, path: &str) -> Value {
    let code = match e.kind() {
        io::ErrorKind::NotFound => "ENOENT",
        io::ErrorKind::PermissionDenied => "EACCES",
        io::ErrorKind::AlreadyExists => "EEXIST",
        io::ErrorKind::IsADirectory => "EISDIR",
        io::ErrorKind::NotADirectory => "ENOTDIR",
        io::ErrorKind::DirectoryNotEmpty => "ENOTEMPTY",
        _ => "EIO",
    };
    err(code, format!("{code}: {e}, '{path}'"))
}

fn str_arg<'a>(a: &'a Value, k: &str) -> std::result::Result<&'a str, Value> {
    a.get(k).and_then(Value::as_str).ok_or_else(|| err("EINVAL", format!("missing argument {k}")))
}

fn ms(t: io::Result<std::time::SystemTime>) -> f64 {
    t.ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

pub fn fs_op(op: &str, a: &Value) -> Result {
    let path = str_arg(a, "path")?;
    let p = Path::new(path);
    match op {
        "readFile" => fs::read_to_string(p).map(Value::from).map_err(|e| io_err(e, path)),
        "writeFile" | "appendFile" => {
            let data = a.get("data").and_then(Value::as_str).unwrap_or("");
            let mut f = fs::OpenOptions::new()
                .create(true)
                .write(true)
                .append(op == "appendFile")
                .truncate(op == "writeFile")
                .open(p)
                .map_err(|e| io_err(e, path))?;
            f.write_all(data.as_bytes()).map_err(|e| io_err(e, path))?;
            Ok(Value::Null)
        }
        "exists" => Ok(Value::from(p.exists())),
        "stat" => {
            let m = fs::metadata(p).map_err(|e| io_err(e, path))?;
            Ok(json!({
                "size": m.len(),
                "isFile": m.is_file(),
                "isDirectory": m.is_dir(),
                "mtimeMs": ms(m.modified()),
                "ctimeMs": ms(m.created()),
            }))
        }
        "readdir" => {
            let mut names: Vec<String> = fs::read_dir(p)
                .map_err(|e| io_err(e, path))?
                .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
                .collect();
            names.sort();
            Ok(Value::from(names))
        }
        "mkdir" => {
            let recursive = a.get("recursive").and_then(Value::as_bool).unwrap_or(false);
            let r = if recursive { fs::create_dir_all(p) } else { fs::create_dir(p) };
            r.map(|_| Value::Null).map_err(|e| io_err(e, path))
        }
        "unlink" => fs::remove_file(p).map(|_| Value::Null).map_err(|e| io_err(e, path)),
        "rmdir" => fs::remove_dir(p).map(|_| Value::Null).map_err(|e| io_err(e, path)),
        "rename" => {
            let to = str_arg(a, "to")?;
            fs::rename(p, to).map(|_| Value::Null).map_err(|e| io_err(e, path))
        }
        _ => Err(err("ENOSYS", format!("unknown fs op {op}"))),
    }
}
