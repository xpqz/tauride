use enigo::{Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use std::time::Duration;
use tauri::WebviewWindow;

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

async fn focused(window: &WebviewWindow) -> Result<bool, String> {
    if !window.is_focused().map_err(input_error)? { return Ok(false); }
    #[cfg(target_os = "macos")]
    {
        let (send, receive) = tokio::sync::oneshot::channel();
        window.run_on_main_thread(move || {
            let marker = objc2::MainThreadMarker::new().expect("Tauri main thread");
            let active = objc2_app_kit::NSApplication::sharedApplication(marker).isActive();
            let _ = send.send(active);
        }).map_err(input_error)?;
        return receive.await.map_err(input_error);
    }
    #[cfg(not(target_os = "macos"))]
    Ok(true)
}

async fn focus(window: &WebviewWindow) -> Result<(), String> {
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
pub async fn ui_test_keys(window: WebviewWindow, keys: Vec<String>) -> Result<(), String> {
    let _lock = INPUT.lock().await;
    focus(&window).await?;
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
                input.key(Key::Unicode(ch), Direction::Click).map_err(input_error)?;
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
    let scale = window.scale_factor().map_err(input_error)?;
    let origin = window.inner_position().map_err(input_error)?;
    let size = window.inner_size().map_err(input_error)?;
    if x < 0.0 || y < 0.0 || x * scale >= f64::from(size.width) || y * scale >= f64::from(size.height) {
        return Err("Pointer target is outside the webview".into());
    }
    // CoreGraphics uses screen points; X11 and Windows use physical pixels.
    let unit = if cfg!(target_os = "macos") { 1.0 / scale } else { 1.0 };
    let screen_x = (f64::from(origin.x) + x * scale) * unit;
    let screen_y = (f64::from(origin.y) + y * scale) * unit;
    native_input()?.move_mouse(screen_x.round() as i32, screen_y.round() as i32, Coordinate::Abs).map_err(input_error)
}
