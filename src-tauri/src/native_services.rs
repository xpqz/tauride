use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::{DialogExt, FilePath, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::oneshot;

fn parent<R: Runtime>(app: &AppHandle<R>, options: &Value) -> Result<Option<tauri::WebviewWindow<R>>, String> {
    if let Some(id) = options.get("window").and_then(Value::as_u64) {
        return app.get_webview_window(&crate::win::label_of(id as u32)).map(Some)
            .ok_or_else(|| "Native dialog owner is no longer available".into());
    }
    Ok(app.get_webview_window("main"))
}

fn text<'a>(options: &'a Value, key: &str) -> &'a str {
    options.get(key).and_then(Value::as_str).unwrap_or("")
}

fn simple_buttons(options: &Value) -> Option<Vec<String>> {
    let labels: Vec<String> = options.get("buttons").and_then(Value::as_array)
        .map(|values| values.iter().filter_map(Value::as_str).map(String::from).collect())
        .unwrap_or_else(|| vec!["OK".into()]);
    if options.get("checkboxLabel").is_some() || options.get("checkboxChecked").is_some()
        || options.get("defaultId").is_some_and(|id| id.as_u64() != Some(0)) {
        return None;
    }
    match labels.len() {
        1 if options.get("cancelId").is_none_or(|id| id.as_i64() == Some(0)) => Some(labels),
        2 if labels[0] != labels[1] && options.get("cancelId").and_then(Value::as_i64) == Some(1) => Some(labels),
        _ => None,
    }
}

#[tauri::command]
pub async fn native_message<R: Runtime>(app: AppHandle<R>, options: Value) -> Result<Value, String> {
    let owner = parent(&app, &options)?;
    let Some(labels) = simple_buttons(&options) else {
        let (tx, rx) = oneshot::channel();
        let handle = app.clone();
        app.run_on_main_thread(move || {
            let result = parent(&handle, &options).and_then(|_| crate::dialog::message(&handle, &options).map_err(|error| error.to_string()));
            let _ = tx.send(result);
        }).map_err(|error| error.to_string())?;
        return rx.await.map_err(|_| "Native dialog closed without a response".to_string())?;
    };
    let mut content = text(&options, "message").to_string();
    if !text(&options, "detail").is_empty() { content.push_str(&format!("\n\n{}", text(&options, "detail"))); }
    let buttons = if labels.len() == 1 { MessageDialogButtons::OkCustom(labels[0].clone()) }
        else { MessageDialogButtons::OkCancelCustom(labels[0].clone(), labels[1].clone()) };
    let kind = match text(&options, "type") {
        "error" => MessageDialogKind::Error,
        "warning" => MessageDialogKind::Warning,
        _ => MessageDialogKind::Info,
    };
    let mut dialog = app.dialog().message(content).title(text(&options, "title")).kind(kind).buttons(buttons);
    if let Some(window) = owner { dialog = dialog.parent(&window); }
    #[cfg(feature = "ui-tests")]
    crate::dialog::trace_message(&options);
    let (tx, rx) = oneshot::channel();
    dialog.show(move |accepted| { let _ = tx.send(accepted); });
    let accepted = rx.await.map_err(|_| "Native dialog closed without a response".to_string())?;
    Ok(json!({ "response": if accepted || labels.len() == 1 { 0 } else { 1 }, "checkboxChecked": false }))
}

fn paths(paths: Option<Vec<FilePath>>) -> Result<Value, String> {
    match paths {
        Some(paths) if !paths.is_empty() => paths.into_iter().map(|path| {
            path.into_path().map(|path| path.to_string_lossy().into_owned()).map_err(|error| error.to_string())
        }).collect::<Result<Vec<_>, _>>().map(|paths| json!(paths)),
        _ => Ok(Value::Null),
    }
}

#[tauri::command]
pub async fn native_file<R: Runtime>(app: AppHandle<R>, options: Value) -> Result<Value, String> {
    #[cfg(target_os = "linux")]
    if options.get("buttonLabel").is_some() || options.get("properties").and_then(Value::as_array)
        .is_some_and(|properties| properties.iter().any(|property| property == "showHiddenFiles")) {
        parent(&app, &options)?;
        let (tx, rx) = oneshot::channel();
        let handle = app.clone();
        app.run_on_main_thread(move || {
            let result = parent(&handle, &options).and_then(|_| crate::dialog::file(&handle, &options).map_err(|error| error.to_string()));
            let _ = tx.send(result);
        }).map_err(|error| error.to_string())?;
        return rx.await.map_err(|_| "Native file picker closed without a response".to_string())?;
    }
    let mut dialog = app.dialog().file().set_title(text(&options, "title"));
    if let Some(window) = parent(&app, &options)? { dialog = dialog.set_parent(&window); }
    let default_path = std::path::Path::new(text(&options, "defaultPath"));
    if !default_path.as_os_str().is_empty() {
        if default_path.is_dir() { dialog = dialog.set_directory(default_path); }
        else {
            if let Some(directory) = default_path.parent().filter(|path| !path.as_os_str().is_empty()) {
                dialog = dialog.set_directory(directory);
            }
            if let Some(name) = default_path.file_name() { dialog = dialog.set_file_name(name.to_string_lossy()); }
        }
    }
    for filter in options.get("filters").and_then(Value::as_array).into_iter().flatten() {
        let extensions: Vec<&str> = filter.get("extensions").and_then(Value::as_array).into_iter().flatten()
            .filter_map(Value::as_str).collect();
        dialog = dialog.add_filter(text(filter, "name"), &extensions);
    }
    let properties: Vec<&str> = options.get("properties").and_then(Value::as_array).into_iter().flatten()
        .filter_map(Value::as_str).collect();
    #[cfg(feature = "ui-tests")]
    eprintln!("[ui-test-file] opening");
    let (tx, rx) = oneshot::channel();
    let reply = move |selection| { let _ = tx.send(paths(selection)); };
    if options.get("save").and_then(Value::as_bool).unwrap_or(false) {
        dialog.save_file(move |path| reply(path.map(|path| vec![path])));
    } else if properties.contains(&"openDirectory") {
        if properties.contains(&"multiSelections") { dialog.pick_folders(reply); }
        else { dialog.pick_folder(move |path| reply(path.map(|path| vec![path]))); }
    } else if properties.contains(&"multiSelections") { dialog.pick_files(reply); }
    else { dialog.pick_file(move |path| reply(path.map(|path| vec![path]))); }
    rx.await.map_err(|_| "Native file picker closed without a response".to_string())?
}

#[tauri::command]
pub fn native_open<R: Runtime>(app: AppHandle<R>, target: String, kind: String) -> Result<(), String> {
    match kind.as_str() {
        "url" => app.opener().open_url(target, None::<&str>),
        "path" => app.opener().open_path(target, None::<&str>),
        "reveal" => app.opener().reveal_item_in_dir(target),
        _ => return Err("Unknown native opener operation".into()),
    }.map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rich_dialog_options_keep_the_platform_dialog() {
        for options in [
            json!({ "buttons": ["Yes", "No", "Cancel"], "cancelId": -1 }),
            json!({ "buttons": ["One", "Two", "Three", "Four"] }),
            json!({ "buttons": ["Same", "Same"], "cancelId": 1 }),
            json!({ "buttons": ["OK"], "checkboxLabel": "Remember" }),
            json!({ "buttons": ["OK"], "cancelId": -1 }),
            json!({ "buttons": ["Yes", "No"], "defaultId": 1, "cancelId": 1 }),
        ] { assert!(simple_buttons(&options).is_none()); }
        assert_eq!(simple_buttons(&json!({ "buttons": ["Yes", "No"], "cancelId": 1 })), Some(vec!["Yes".into(), "No".into()]));
    }

    #[test]
    fn file_picker_results_preserve_spaces_and_cancellation() {
        assert_eq!(paths(None).unwrap(), Value::Null);
        assert_eq!(paths(Some(vec![])).unwrap(), Value::Null);
        assert_eq!(paths(Some(vec![std::path::PathBuf::from("/tmp/APL files/a.dws").into()])).unwrap(), json!(["/tmp/APL files/a.dws"]));
    }
}
