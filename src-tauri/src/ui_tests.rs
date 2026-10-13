use enigo::{Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use std::time::Duration;
use tauri::menu::MenuItemKind;
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

fn menu_command_item<R: Runtime>(items: Vec<MenuItemKind<R>>, command: &str) -> Result<Option<MenuItemKind<R>>, String> {
    let label = match command {
        "CVH" => "Clear Visible History",
        "TTB" => "Show Trace/Edit Toolbar",
        "LBR" => "Show Language Bar",
        "SBR" => "Show Status Bar",
        "WRP" => "Line Wrapping in Session",
        "PRF" => "Preferences...",
        "AGO" => "Observe Session",
        "AGC" => "Allow Control",
        _ => "",
    };
    for item in items {
        let text = if let Some(menu_item) = item.as_menuitem() {
            Some(menu_item.text().map_err(|e| e.to_string())?)
        } else if let Some(menu_item) = item.as_check_menuitem() {
            Some(menu_item.text().map_err(|e| e.to_string())?)
        } else {
            None
        };
        let matches_label = text.as_deref() == Some(label)
            || (command == "PRF" && text.as_deref() == Some("Settings…"));
        if item.id().as_ref().ends_with(&format!(":{command}")) || (!label.is_empty() && matches_label) {
            return Ok(Some(item));
        }
        if let Some(submenu) = item.as_submenu() {
            if let Some(found) = menu_command_item(submenu.items().map_err(|e| e.to_string())?, command)? {
                return Ok(Some(found));
            }
        }
    }
    Ok(None)
}

fn menu_item_labels<R: Runtime>(items: Vec<MenuItemKind<R>>) -> Result<Vec<String>, String> {
    let mut labels = Vec::new();
    for item in items {
        let text = if let Some(menu_item) = item.as_menuitem() {
            Some(menu_item.text().map_err(|e| e.to_string())?)
        } else if let Some(menu_item) = item.as_check_menuitem() {
            Some(menu_item.text().map_err(|e| e.to_string())?)
        } else { None };
        if let Some(text) = text { labels.push(format!("{}={text:?}", item.id().as_ref())); }
        if let Some(submenu) = item.as_submenu() {
            labels.extend(menu_item_labels(submenu.items().map_err(|e| e.to_string())?)?);
        }
    }
    Ok(labels)
}

fn installed_menu_command_item<R: Runtime>(app: &AppHandle<R>, command: &str) -> Result<MenuItemKind<R>, String> {
    if !["SC", "SA", "LBR", "SBR", "WRP", "PRF", "CVH", "TTB", "AGO", "AGC", "FX", "SI", "RP", "QCP", "TGC", "RD",
        "IT", "ITL", "ITF", "ITR", "ITA", "ITRES", "ITPL", "ITPF", "ITPR", "ITPA",
        "BXO", "BXN", "BXMIN", "BXMID", "BXMAX", "BXQ", "BXH", "RWO", "RWL", "RWC", "RWW", "RWFO",
        "RWF0", "RWF1", "RWF2", "RWF3", "RWF4", "RWF5", "RWF6", "RWF7", "RWF8", "RWF9", "RWQ", "RWH"].contains(&command) { return Err("Unsupported test menu command".into()); }
    let menu = app.menu().ok_or("No application menu")?;
    let items = menu.items().map_err(|e| e.to_string())?;
    if let Some(item) = menu_command_item(items.clone(), command)? { return Ok(item); }
    Err(format!("No application menu item for {command}; installed: {}", menu_item_labels(items)?.join(", ")))
}

#[tauri::command]
pub fn ui_test_menu_command<R: Runtime>(app: AppHandle<R>, command: String, dispatch: Option<bool>, expected_checked: Option<bool>, expected_enabled: Option<bool>) -> Result<String, String> {
    let item = installed_menu_command_item(&app, &command)?;
    let id = item.id().as_ref().to_string();
    let checked = item.as_check_menuitem()
        .map(|menu_item| menu_item.is_checked().map_err(|e| e.to_string())).transpose()?;
    if let Some(expected) = expected_checked {
        if checked != Some(expected) {
            return Err(format!("Installed menu {command} checked state is {checked:?}, expected {expected}"));
        }
    }
    if let Some(expected) = expected_enabled {
        let enabled = if let Some(menu_item) = item.as_menuitem() {
            menu_item.is_enabled().map_err(|e| e.to_string())?
        } else if let Some(menu_item) = item.as_check_menuitem() {
            menu_item.is_enabled().map_err(|e| e.to_string())?
        } else { return Err(format!("Menu {command} is not a command item")); };
        if enabled != expected {
            return Err(format!("Installed menu {command} enabled state is {enabled}, expected {expected}"));
        }
    }
    if dispatch.unwrap_or(true) {
        if let (Some(before), Some(checkbox)) = (checked, item.as_check_menuitem()) {
            checkbox.set_checked(!before).map_err(|e| e.to_string())?;
        }
        crate::menu::on_event(&app, &id);
    }
    Ok(id)
}

pub fn guard_parent(app: tauri::AppHandle) {
    if std::env::var("TAURI_UI_TEST_STDIN").as_deref() != Ok("1") { return; }
    std::thread::spawn(move || {
        use std::io::Read;
        let mut input = std::io::stdin().lock();
        let mut buffer = [0; 256];
        loop {
            match input.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
        }
        app.exit(0);
    });
}

static INPUT: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn input_error(error: impl std::fmt::Display) -> String {
    format!("Native UI input failed: {error}. Unlock the desktop and grant Tauride input/accessibility permission.")
}

#[cfg(target_os = "macos")]
pub async fn owned_sheet_focused(window: &WebviewWindow) -> Result<bool, String> {
    let target = window.clone();
    on_main_thread(window, move || {
        let marker = objc2::MainThreadMarker::new().expect("Tauri main thread");
        let app = objc2_app_kit::NSApplication::sharedApplication(marker);
        let pointer = target.ns_window().map_err(input_error)?;
        let parent = unsafe { &*(pointer as *const objc2_app_kit::NSWindow) };
        Ok(app.isActive() && app.keyWindow().is_some_and(|key| {
            key.isVisible() && key.sheetParent().is_some_and(|sheet_parent| std::ptr::eq(&*sheet_parent, parent))
        }))
    }).await
}

async fn focused(window: &WebviewWindow) -> Result<bool, String> {
    #[cfg(not(target_os = "macos"))]
    if !window.is_focused().map_err(input_error)? { return Ok(false); }
    #[cfg(target_os = "macos")]
    {
        let (send, receive) = tokio::sync::oneshot::channel();
        let target = window.clone();
        window.run_on_main_thread(move || {
            let marker = objc2::MainThreadMarker::new().expect("Tauri main thread");
            let app = objc2_app_kit::NSApplication::sharedApplication(marker);
            let owned = target.ns_window().ok().is_some_and(|pointer| {
                let parent = unsafe { &*(pointer as *const objc2_app_kit::NSWindow) };
                app.keyWindow().is_some_and(|key| {
                    std::ptr::eq(&*key, parent) || key.sheetParent().is_some_and(|sheet_parent| std::ptr::eq(&*sheet_parent, parent))
                })
            });
            let _ = send.send(app.isActive() && owned);
        }).map_err(input_error)?;
        return receive.await.map_err(input_error);
    }
    #[cfg(not(target_os = "macos"))]
    Ok(true)
}

async fn focus(window: &WebviewWindow) -> Result<(), String> {
    if focused(window).await? { return Ok(()); }
    window.set_focus().map_err(input_error)?;
    for _ in 0..40 {
        if focused(window).await? { return Ok(()); }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    Err(input_error("the target window could not receive desktop focus"))
}

fn native_input() -> Result<Enigo, String> {
    Enigo::new(&Settings {
        open_prompt_to_get_permissions: false,
        release_keys_when_dropped: true,
        ..Settings::default()
    }).map_err(input_error)
}

#[cfg(target_os = "macos")]
async fn on_main_thread<T: Send + 'static>(
    window: &WebviewWindow,
    action: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    window.run_on_main_thread(move || {
        let _ = send.send(action());
    }).map_err(input_error)?;
    receive.await.map_err(input_error)?
}

fn special_key(value: char) -> Option<(Key, bool)> {
    Some(match value {
        '\u{e008}' => (Key::Shift, true),
        '\u{e009}' => (Key::Control, true),
        '\u{e00a}' => (Key::Alt, true),
        '\u{e03d}' => (Key::Meta, true),
        '\u{e006}' | '\u{e007}' => (Key::Return, false),
        '\u{e00c}' => (Key::Escape, false),
        '\u{e032}' => (Key::F2, false),
        '\u{e003}' => (Key::Backspace, false),
        '\u{e004}' => (Key::Tab, false),
        _ => return None,
    })
}

#[tauri::command]
pub async fn ui_test_cancel_file_dialog(app: AppHandle, window: WebviewWindow, target_label: Option<String>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use objc2::ClassType;
        use objc2_foundation::NSObjectProtocol;
        let target = if let Some(label) = target_label {
            app.get_webview_window(&label).ok_or_else(|| format!("no window {label}"))?
        } else { window };
        let owner = target.clone();
        return on_main_thread(&target, move || {
            let marker = objc2::MainThreadMarker::new().expect("Tauri main thread");
            let application = objc2_app_kit::NSApplication::sharedApplication(marker);
            let key = application.keyWindow().ok_or("No native file picker is focused")?;
            let pointer = owner.ns_window().map_err(input_error)?;
            let parent = unsafe { &*(pointer as *const objc2_app_kit::NSWindow) };
            if !application.isActive() || !key.sheetParent().is_some_and(|sheet_parent| std::ptr::eq(&*sheet_parent, parent))
                || !key.isKindOfClass(objc2_app_kit::NSSavePanel::class()) {
                return Err("The focused native file picker does not belong to the target window".into());
            }
            let panel = unsafe { &*(objc2::rc::Retained::as_ptr(&key) as *const objc2_app_kit::NSSavePanel) };
            unsafe { panel.cancel(None); }
            Ok(())
        }).await;
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = (app, window, target_label); Err("Native file picker cancellation test is only supported on macOS".into()) }
}

#[tauri::command]
pub async fn ui_test_keys(app: AppHandle, window: WebviewWindow, keys: Vec<String>, target_label: Option<String>) -> Result<(), String> {
    let _lock = INPUT.lock().await;
    let target = if let Some(label) = target_label {
        app.get_webview_window(&label).ok_or_else(|| format!("no window {label}"))?
    } else { window };
    focus(&target).await?;
    #[cfg(target_os = "macos")]
    return on_main_thread(&target, move || send_keys(keys)).await;
    #[cfg(not(target_os = "macos"))]
    send_keys(keys)
}

fn character_key(ch: char) -> Key {
    #[cfg(target_os = "macos")]
    match ch {
        '/' => return Key::Other(0x2c),
        ',' => return Key::Other(0x2b),
        _ => {}
    }
    Key::Unicode(ch)
}

fn send_keys(keys: Vec<String>) -> Result<(), String> {
    // Enigo releases held modifiers on Drop, including after an input error.
    let mut input = native_input()?;
    let mut modifiers = Vec::new();
    for value in keys {
        for ch in value.chars() {
            if let Some((key, modifier)) = special_key(ch) {
                if modifier {
                    input.key(key, Direction::Press).map_err(input_error)?;
                    modifiers.push(key);
                } else {
                    input.key(key, Direction::Click).map_err(input_error)?;
                }
            } else if ('\u{e000}'..='\u{f8ff}').contains(&ch) {
                return Err(format!("Unsupported WebDriver key U+{:04X}", ch as u32));
            } else if !modifiers.is_empty() || ch.is_ascii_lowercase() || ch.is_ascii_digit() {
                input.key(character_key(ch), Direction::Click).map_err(input_error)?;
            } else {
                input.text(&ch.to_string()).map_err(input_error)?;
            }
        }
    }
    for modifier in modifiers.into_iter().rev() {
        input.key(modifier, Direction::Release).map_err(input_error)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn ui_test_move_to(window: WebviewWindow, x: f64, y: f64) -> Result<(), String> {
    if !x.is_finite() || !y.is_finite() { return Err("Pointer coordinates must be finite".into()); }
    let _lock = INPUT.lock().await;
    focus(&window).await?;
    #[cfg(target_os = "macos")]
    {
        let (send, receive) = tokio::sync::oneshot::channel();
        window.with_webview(move |webview| {
            let result = (|| {
                use objc2_app_kit::{NSScreen, NSView};
                use objc2_foundation::NSPoint;
                let marker = objc2::MainThreadMarker::new().expect("Tauri main thread");
                // Tauri supplies the live WKWebView on its main thread; use its own origin.
                let content = unsafe { &*(webview.inner().cast::<NSView>()) };
                let native = content.window().ok_or_else(|| input_error("webview has no window"))?;
                let bounds = content.bounds();
                let insets = content.safeAreaInsets();
                let width = bounds.size.width - insets.left - insets.right;
                let height = bounds.size.height - insets.top - insets.bottom;
                if x < 0.0 || y < 0.0 || x >= width || y >= height {
                    return Err("Pointer target is outside the webview".into());
                }
                // WebKit's CSS viewport starts inside the native view's safe area.
                let local_x = bounds.origin.x + insets.left + x;
                let top_y = insets.top + y;
                let local_y = if content.isFlipped() { bounds.origin.y + top_y }
                    else { bounds.origin.y + bounds.size.height - top_y };
                let point = content.convertPoint_toView(NSPoint::new(local_x, local_y), None);
                let screen = native.convertPointToScreen(point);
                // AppKit has a bottom-left origin; CoreGraphics uses the primary screen's top-left.
                let screens = NSScreen::screens(marker);
                if screens.count() == 0 { return Err(input_error("desktop has no screens")); }
                let primary = screens.objectAtIndex(0).frame();
                let screen_y = primary.origin.y + primary.size.height - screen.y;
                native_input()?.move_mouse(screen.x.round() as i32, screen_y.round() as i32, Coordinate::Abs).map_err(input_error)
            })();
            let _ = send.send(result);
        }).map_err(input_error)?;
        return receive.await.map_err(input_error)?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let scale = window.scale_factor().map_err(input_error)?;
        let origin = window.inner_position().map_err(input_error)?;
        let size = window.inner_size().map_err(input_error)?;
        if x < 0.0 || y < 0.0 || x * scale >= f64::from(size.width) || y * scale >= f64::from(size.height) {
            return Err("Pointer target is outside the webview".into());
        }
        let screen_x = f64::from(origin.x) + x * scale;
        let screen_y = f64::from(origin.y) + y * scale;
        native_input()?.move_mouse(screen_x.round() as i32, screen_y.round() as i32, Coordinate::Abs).map_err(input_error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(target_os = "macos")]
    fn modified_punctuation_uses_physical_keys() {
        assert_eq!(character_key('/'), Key::Other(0x2c));
        assert_eq!(character_key(','), Key::Other(0x2b));
        assert_eq!(character_key('s'), Key::Unicode('s'));
    }

    #[test]
    #[cfg(not(target_os = "macos"))]
    fn other_platform_character_mapping_is_unchanged() {
        assert_eq!(character_key('/'), Key::Unicode('/'));
        assert_eq!(character_key(','), Key::Unicode(','));
    }
}
