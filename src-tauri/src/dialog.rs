//! Native dialogs for the shim's dialog.*Sync calls, run synchronously from
//! the ridesync:// handler on the GTK main thread, as Electron's *Sync
//! dialogs block the caller.

use crate::sync;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Runtime};

#[cfg(target_os = "linux")]
fn parent<R: Runtime>(app: &AppHandle<R>, a: &Value) -> Option<gtk::ApplicationWindow> {
    let id = a.get("window").and_then(Value::as_u64).unwrap_or(1) as u32;
    app.get_webview_window(&crate::win::label_of(id))
        .or_else(|| app.get_webview_window("main"))
        .and_then(|w| w.gtk_window().ok())
}

fn s<'a>(a: &'a Value, k: &str) -> Option<&'a str> {
    a.get(k).and_then(Value::as_str).filter(|v| !v.is_empty())
}

/// showMessageBox options: type, title, message, detail, buttons, defaultId,
/// cancelId, checkboxLabel, checkboxChecked. Returns {response,
/// checkboxChecked}; closing the dialog answers cancelId.
#[cfg(target_os = "linux")]
pub fn message<R: Runtime>(app: &AppHandle<R>, a: &Value) -> sync::Result {
    use gtk::prelude::*;
    let kind = match s(a, "type") {
        Some("error") => gtk::MessageType::Error,
        Some("warning") => gtk::MessageType::Warning,
        Some("question") => gtk::MessageType::Question,
        Some("info") => gtk::MessageType::Info,
        _ => gtk::MessageType::Other,
    };
    let parent = parent(app, a);
    let d = gtk::MessageDialog::new(
        parent.as_ref(),
        gtk::DialogFlags::MODAL | gtk::DialogFlags::DESTROY_WITH_PARENT,
        kind,
        gtk::ButtonsType::None,
        s(a, "message").unwrap_or(""),
    );
    d.set_title(s(a, "title").unwrap_or("Ride"));
    // GTK makes a message dialog without a Cancel/Close-type button ignore
    // close requests; Electron answers them, and Escape, with cancelId.
    d.set_deletable(true);
    d.connect_delete_event(|d, _| {
        d.response(gtk::ResponseType::DeleteEvent);
        gtk::glib::Propagation::Stop
    });
    if let Some(detail) = s(a, "detail") {
        d.set_secondary_text(Some(detail));
    }
    let buttons: Vec<String> = a
        .get("buttons")
        .and_then(Value::as_array)
        .map(|b| b.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .filter(|b: &Vec<String>| !b.is_empty())
        .unwrap_or_else(|| vec!["OK".into()]);
    for (i, b) in buttons.iter().enumerate() {
        // Electron marks access keys with &, GTK with _.
        d.add_button(&b.replace('&', "_"), gtk::ResponseType::Other(i as u16));
    }
    if let Some(def) = a.get("defaultId").and_then(Value::as_u64) {
        d.set_default_response(gtk::ResponseType::Other(def as u16));
    }
    let check = s(a, "checkboxLabel").map(|label| {
        let c = gtk::CheckButton::with_label(label);
        c.set_active(a.get("checkboxChecked").and_then(Value::as_bool).unwrap_or(false));
        d.message_area().downcast::<gtk::Box>().ok().map(|area| area.add(&c));
        c.show();
        c
    });
    let debug = std::env::var_os("RIDE_TAURI_DEBUG").is_some();
    if debug {
        eprintln!("[dialog] message box running");
    }
    let r = d.run();
    if debug {
        eprintln!("[dialog] message box answered {r:?}");
    }
    let checked = check.map(|c| c.is_active()).unwrap_or(false);
    unsafe { d.destroy() };
    let cancel = a.get("cancelId").and_then(Value::as_u64).unwrap_or(0);
    let response = match r {
        gtk::ResponseType::Other(i) => i as u64,
        _ => cancel,
    };
    Ok(json!({ "response": response, "checkboxChecked": checked }))
}

/// showOpenDialog/showSaveDialog options: title, defaultPath, buttonLabel,
/// properties (openDirectory, multiSelections, showHiddenFiles), filters.
/// Returns the chosen paths, or null when cancelled.
#[cfg(target_os = "linux")]
pub fn file<R: Runtime>(app: &AppHandle<R>, a: &Value) -> sync::Result {
    use gtk::prelude::*;
    let save = a.get("save").and_then(Value::as_bool).unwrap_or(false);
    let props: Vec<&str> = a
        .get("properties")
        .and_then(Value::as_array)
        .map(|p| p.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let action = if save {
        gtk::FileChooserAction::Save
    } else if props.contains(&"openDirectory") {
        gtk::FileChooserAction::SelectFolder
    } else {
        gtk::FileChooserAction::Open
    };
    let parent = parent(app, a);
    let d = gtk::FileChooserDialog::new(s(a, "title"), parent.as_ref(), action);
    d.add_button("_Cancel", gtk::ResponseType::Cancel);
    let ok = s(a, "buttonLabel").unwrap_or(if save { "_Save" } else { "_Open" });
    d.add_button(ok, gtk::ResponseType::Accept);
    d.set_default_response(gtk::ResponseType::Accept);
    d.set_modal(true);
    d.set_select_multiple(props.contains(&"multiSelections"));
    d.set_show_hidden(props.contains(&"showHiddenFiles"));
    d.set_do_overwrite_confirmation(true);
    if let Some(p) = s(a, "defaultPath") {
        let path = std::path::Path::new(p);
        if path.is_dir() {
            d.set_current_folder(path);
        } else {
            if let Some(dir) = path.parent().filter(|d| d.is_dir()) {
                d.set_current_folder(dir);
            }
            if save {
                if let Some(name) = path.file_name() {
                    d.set_current_name(&name.to_string_lossy());
                }
            } else {
                d.set_filename(path);
            }
        }
    }
    for f in a.get("filters").and_then(Value::as_array).into_iter().flatten() {
        let filter = gtk::FileFilter::new();
        filter.set_name(f.get("name").and_then(Value::as_str));
        for ext in f.get("extensions").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
            filter.add_pattern(&if ext == "*" { "*".to_string() } else { format!("*.{ext}") });
        }
        d.add_filter(filter);
    }
    let r = d.run();
    let paths: Vec<String> = d.filenames().into_iter().map(|p| p.to_string_lossy().into_owned()).collect();
    unsafe { d.destroy() };
    Ok(if r == gtk::ResponseType::Accept && !paths.is_empty() { json!(paths) } else { Value::Null })
}

#[cfg(not(target_os = "linux"))]
pub fn message<R: Runtime>(_app: &AppHandle<R>, _a: &Value) -> sync::Result {
    Err(sync::err("ENOSYS", "native message boxes are only implemented on Linux"))
}

#[cfg(not(target_os = "linux"))]
pub fn file<R: Runtime>(_app: &AppHandle<R>, _a: &Value) -> sync::Result {
    Err(sync::err("ENOSYS", "native file dialogs are only implemented on Linux"))
}
