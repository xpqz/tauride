//! Native dialogs for the shim's dialog.*Sync calls, run synchronously from
//! the ridesync:// handler on the main (GTK or Win32 UI) thread, as
//! Electron's *Sync dialogs block the caller.

use crate::sync;
use serde_json::Value;
use tauri::{AppHandle, Runtime};
#[cfg(any(target_os = "linux", windows))]
use {serde_json::json, tauri::Manager};

#[cfg(any(target_os = "linux", windows))]
fn parent_window<R: Runtime>(app: &AppHandle<R>, a: &Value) -> Option<tauri::WebviewWindow<R>> {
    let id = a.get("window").and_then(Value::as_u64).unwrap_or(1) as u32;
    app.get_webview_window(&crate::win::label_of(id)).or_else(|| app.get_webview_window("main"))
}

#[cfg(target_os = "linux")]
fn parent<R: Runtime>(app: &AppHandle<R>, a: &Value) -> Option<gtk::ApplicationWindow> {
    parent_window(app, a).and_then(|w| w.gtk_window().ok())
}

#[cfg(any(target_os = "linux", windows))]
fn s<'a>(a: &'a Value, k: &str) -> Option<&'a str> {
    a.get(k).and_then(Value::as_str).filter(|v| !v.is_empty())
}

#[cfg(any(target_os = "linux", windows))]
fn buttons(a: &Value) -> Vec<String> {
    a.get("buttons")
        .and_then(Value::as_array)
        .map(|b| b.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .filter(|b: &Vec<String>| !b.is_empty())
        .unwrap_or_else(|| vec!["OK".into()])
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
    for (i, b) in buttons(a).iter().enumerate() {
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

/// showMessageBox as a task dialog, as Electron does on Windows: title in
/// the caption, message as the main instruction, detail as the content,
/// checkboxLabel as the verification checkbox. Closing the dialog (Escape,
/// the close box) answers cancelId.
#[cfg(windows)]
pub fn message<R: Runtime>(app: &AppHandle<R>, a: &Value) -> sync::Result {
    use windows_sys::Win32::UI::Controls::*;
    use windows_sys::Win32::UI::WindowsAndMessaging::IDCANCEL;
    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }
    // Button ids clear of IDOK, IDCANCEL and the other common ones.
    const FIRST: i32 = 100;
    let labels: Vec<Vec<u16>> = buttons(a).iter().map(|b| wide(b)).collect();
    let tbuttons: Vec<TASKDIALOG_BUTTON> = labels
        .iter()
        .enumerate()
        .map(|(i, l)| TASKDIALOG_BUTTON { nButtonID: FIRST + i as i32, pszButtonText: l.as_ptr() })
        .collect();
    let title = wide(s(a, "title").unwrap_or("Ride"));
    let main = s(a, "message").map(wide);
    let detail = s(a, "detail").map(wide);
    let check = s(a, "checkboxLabel").map(wide);
    let hwnd = parent_window(app, a).and_then(|w| w.hwnd().ok()).map_or(std::ptr::null_mut(), |h| h.0 as _);

    let mut c: TASKDIALOGCONFIG = unsafe { std::mem::zeroed() };
    c.cbSize = std::mem::size_of::<TASKDIALOGCONFIG>() as u32;
    c.hwndParent = hwnd;
    c.dwFlags = TDF_ALLOW_DIALOG_CANCELLATION | TDF_POSITION_RELATIVE_TO_WINDOW;
    if a.get("checkboxChecked").and_then(Value::as_bool).unwrap_or(false) {
        c.dwFlags |= TDF_VERIFICATION_FLAG_CHECKED;
    }
    c.pszWindowTitle = title.as_ptr();
    c.Anonymous1.pszMainIcon = match s(a, "type") {
        Some("error") => TD_ERROR_ICON,
        Some("warning") => TD_WARNING_ICON,
        Some("info" | "question") => TD_INFORMATION_ICON,
        _ => std::ptr::null(),
    };
    c.pszMainInstruction = main.as_ref().map_or(std::ptr::null(), |m| m.as_ptr());
    c.pszContent = detail.as_ref().map_or(std::ptr::null(), |d| d.as_ptr());
    c.cButtons = tbuttons.len() as u32;
    c.pButtons = tbuttons.as_ptr();
    c.nDefaultButton = FIRST + a.get("defaultId").and_then(Value::as_u64).unwrap_or(0) as i32;
    c.pszVerificationText = check.as_ref().map_or(std::ptr::null(), |v| v.as_ptr());

    let (mut pressed, mut checked) = (0i32, 0i32);
    let hr = unsafe { TaskDialogIndirect(&c, &mut pressed, std::ptr::null_mut(), &mut checked) };
    if hr < 0 {
        return Err(sync::err("EIO", format!("TaskDialogIndirect failed: {hr:#x}")));
    }
    let cancel = a.get("cancelId").and_then(Value::as_u64).unwrap_or(0);
    let response = match pressed {
        IDCANCEL => cancel,
        n if n >= FIRST => (n - FIRST) as u64,
        _ => cancel,
    };
    Ok(json!({ "response": response, "checkboxChecked": checked != 0 }))
}

/// showOpenDialog/showSaveDialog through the common item dialogs. Windows
/// has no counterpart to buttonLabel or showHiddenFiles.
#[cfg(windows)]
pub fn file<R: Runtime>(app: &AppHandle<R>, a: &Value) -> sync::Result {
    let save = a.get("save").and_then(Value::as_bool).unwrap_or(false);
    let props: Vec<&str> = a
        .get("properties")
        .and_then(Value::as_array)
        .map(|p| p.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let mut d = rfd::FileDialog::new();
    if let Some(w) = parent_window(app, a) {
        d = d.set_parent(&w);
    }
    if let Some(t) = s(a, "title") {
        d = d.set_title(t);
    }
    if let Some(p) = s(a, "defaultPath") {
        let path = std::path::Path::new(p);
        if path.is_dir() {
            d = d.set_directory(path);
        } else {
            if let Some(dir) = path.parent().filter(|d| d.is_dir()) {
                d = d.set_directory(dir);
            }
            if let Some(name) = path.file_name() {
                d = d.set_file_name(name.to_string_lossy());
            }
        }
    }
    for f in a.get("filters").and_then(Value::as_array).into_iter().flatten() {
        let exts: Vec<&str> =
            f.get("extensions").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
        d = d.add_filter(f.get("name").and_then(Value::as_str).unwrap_or(""), &exts);
    }
    let multi = props.contains(&"multiSelections");
    let paths = if save {
        d.save_file().map(|p| vec![p])
    } else if props.contains(&"openDirectory") {
        if multi { d.pick_folders() } else { d.pick_folder().map(|p| vec![p]) }
    } else if multi {
        d.pick_files()
    } else {
        d.pick_file().map(|p| vec![p])
    };
    Ok(match paths {
        Some(p) if !p.is_empty() => json!(p.iter().map(|p| p.to_string_lossy()).collect::<Vec<_>>()),
        _ => Value::Null,
    })
}

#[cfg(not(any(target_os = "linux", windows)))]
pub fn message<R: Runtime>(_app: &AppHandle<R>, _a: &Value) -> sync::Result {
    Err(sync::err("ENOSYS", "native message boxes are only implemented on Linux and Windows"))
}

#[cfg(not(any(target_os = "linux", windows)))]
pub fn file<R: Runtime>(_app: &AppHandle<R>, _a: &Value) -> sync::Result {
    Err(sync::err("ENOSYS", "native file dialogs are only implemented on Linux and Windows"))
}
