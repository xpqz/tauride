//! The native theme of every window: the title bar, menu bar and the
//! controls a webview draws with the platform's widgets.
//!
//! The pages choose it as Electron's `nativeTheme.themeSource` does (see the
//! shim): "light" or "dark" to follow Ride's colour scheme, or "system" to
//! follow the OS. The choice is kept in winstate.json as `themeSource`, so a
//! window that opens before any page has run gets it too.
//!
//! GTK3 does not follow the desktop's dark preference by itself: on Linux the
//! OS setting is read from the XDG desktop portal and always applied
//! explicitly. GTK's dark preference is process-wide, so one window's theme
//! is every window's theme there.

use serde_json::Value;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, Runtime, Theme, Window};

/// The OS theme as the portal last reported it (Linux), or as windows last
/// reported it (macOS, Windows: used only to pass on changes); None until
/// known.
static SYSTEM: Mutex<Option<Theme>> = Mutex::new(None);

/// The page event for a change of the OS theme.
const EVENT: &str = "ride-system-theme";

/// Window backgrounds shown before a page paints, matching the themes'
/// window colour. macOS paints the title bar instead.
#[cfg(not(target_os = "macos"))]
const LIGHT_BG: tauri::window::Color = tauri::window::Color(0xf2, 0xf1, 0xf0, 0xff);
#[cfg(not(target_os = "macos"))]
const DARK_BG: tauri::window::Color = tauri::window::Color(0x1f, 0x24, 0x34, 0xff);

/// The theme source in effect.
pub fn source<R: Runtime>(app: &AppHandle<R>) -> String {
    let db = app.state::<crate::winstate::WinState>().get();
    // Before any page has set a source, the theme pages last used.
    db.get("themeSource").or_else(|| db.get("theme")).and_then(Value::as_str).unwrap_or("system").to_owned()
}

/// The OS theme, whatever theme the windows are set to.
fn system() -> Theme {
    #[cfg(target_os = "linux")]
    return SYSTEM.lock().unwrap().unwrap_or(Theme::Light);
    #[cfg(not(target_os = "linux"))]
    return os::theme();
}

/// Sync op theme/system: whether the OS theme is dark.
pub fn system_dark() -> bool {
    system() == Theme::Dark
}

/// The theme to set on windows; None leaves them to follow the OS.
pub fn native<R: Runtime>(app: &AppHandle<R>) -> Option<Theme> {
    match source(app).as_str() {
        "light" => Some(Theme::Light),
        "dark" => Some(Theme::Dark),
        _ if cfg!(target_os = "linux") => Some(system()),
        _ => None,
    }
}

/// Electron's `nativeTheme.shouldUseDarkColors`: the theme in effect.
pub fn dark<R: Runtime>(app: &AppHandle<R>) -> bool {
    native(app).unwrap_or_else(system) == Theme::Dark
}

#[cfg(not(target_os = "macos"))]
pub fn background<R: Runtime>(app: &AppHandle<R>) -> tauri::window::Color {
    if dark(app) { DARK_BG } else { LIGHT_BG }
}

/// A window that has just opened.
pub fn apply<R: Runtime>(w: &Window<R>) {
    let app = w.app_handle();
    let _ = w.set_theme(native(app));
}

fn apply_all<R: Runtime>(app: &AppHandle<R>) {
    let t = native(app);
    for w in app.webview_windows().values() {
        let _ = w.set_theme(t);
    }
}

/// Sync op theme/source: "light", "dark" or "system".
pub fn set_source<R: Runtime>(app: &AppHandle<R>, s: &str) {
    if !matches!(s, "light" | "dark" | "system") || source(app) == s {
        return;
    }
    app.state::<crate::winstate::WinState>().set("themeSource", Value::from(s));
    // What windows reported while their theme was set is not the OS theme.
    if cfg!(not(target_os = "linux")) {
        SYSTEM.lock().unwrap().take();
    }
    apply_all(app);
}

/// The OS theme changed: a window reported it (macOS, Windows) or the
/// portal did (Linux). Windows report it one by one, so only a change is
/// passed on.
pub fn system_changed<R: Runtime>(app: &AppHandle<R>, t: Theme) {
    let following = source(app) == "system";
    // A window with a theme set reports that theme, not the OS's.
    if !following && cfg!(not(target_os = "linux")) {
        return;
    }
    if SYSTEM.lock().unwrap().replace(t) == Some(t) || !following {
        return;
    }
    if cfg!(target_os = "linux") {
        apply_all(app);
    }
    let _ = app.emit(EVENT, t == Theme::Dark);
}

/// Start following the OS theme. On Linux this waits briefly for the
/// portal's first answer, so the first window opens in the right theme.
pub fn init<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(target_os = "linux")]
    portal::watch(app.clone());
    #[cfg(not(target_os = "linux"))]
    let _ = app;
}

#[cfg(target_os = "linux")]
mod portal {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;
    use zbus::blocking::{Connection, Proxy};
    use zbus::zvariant::{OwnedValue, Value as ZValue};

    const NS: &str = "org.freedesktop.appearance";
    const KEY: &str = "color-scheme";

    /// color-scheme: 1 prefers dark; 0 (no preference) and 2 prefer light.
    /// Read wraps the value in one more variant than ReadOne.
    fn theme_of(v: &ZValue) -> Option<Theme> {
        match v {
            ZValue::U32(n) => Some(if *n == 1 { Theme::Dark } else { Theme::Light }),
            ZValue::Value(inner) => theme_of(inner),
            _ => None,
        }
    }

    /// A GTK_THEME such as "Adwaita:dark" names a dark variant.
    fn from_env() -> Theme {
        match std::env::var("GTK_THEME") {
            Ok(t) if t.ends_with(":dark") || t.ends_with("-dark") => Theme::Dark,
            _ => Theme::Light,
        }
    }

    fn proxy() -> zbus::Result<Proxy<'static>> {
        Proxy::new_owned(
            Connection::session()?,
            "org.freedesktop.portal.Desktop",
            "/org/freedesktop/portal/desktop",
            "org.freedesktop.portal.Settings",
        )
    }

    fn read(p: &Proxy) -> Option<Theme> {
        let v: zbus::Result<OwnedValue> = p.call("ReadOne", &(NS, KEY));
        let v = v.or_else(|_| p.call::<_, _, OwnedValue>("Read", &(NS, KEY))).ok()?;
        theme_of(&v)
    }

    pub fn watch<R: Runtime>(app: AppHandle<R>) {
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let p = match proxy() {
                Ok(p) => p,
                Err(_) => {
                    let _ = tx.send(from_env());
                    return;
                }
            };
            let t = read(&p).unwrap_or_else(from_env);
            let _ = tx.send(t);
            // In case the wait below gave up first.
            system_changed(&app, t);
            let Ok(signals) = p.receive_signal("SettingChanged") else { return };
            for m in signals {
                let Ok((ns, key, v)) = m.body().deserialize::<(String, String, OwnedValue)>() else { continue };
                if ns == NS && key == KEY {
                    if let Some(t) = theme_of(&v) {
                        system_changed(&app, t);
                    }
                }
            }
        });
        // A missing portal can take D-Bus activation's full timeout to fail.
        let t = rx.recv_timeout(Duration::from_millis(500)).unwrap_or_else(|_| from_env());
        SYSTEM.lock().unwrap().get_or_insert(t);
    }
}

#[cfg(not(target_os = "linux"))]
mod os {
    use super::Theme;

    /// tao sets a window's theme on NSApp, so NSApp's appearance is the one
    /// Ride chose; the user default is the OS's. AppleInterfaceStyle is "Dark"
    /// while the OS is dark, Auto mode included, and absent while it is light.
    #[cfg(target_os = "macos")]
    pub fn theme() -> Theme {
        use objc2_foundation::{ns_string, NSUserDefaults};
        let style = NSUserDefaults::standardUserDefaults().stringForKey(ns_string!("AppleInterfaceStyle"));
        if style.is_some_and(|s| s.to_string() == "Dark") { Theme::Dark } else { Theme::Light }
    }

    /// The setting tao itself follows for a window with no theme set.
    #[cfg(windows)]
    pub fn theme() -> Theme {
        use windows_sys::Win32::Foundation::ERROR_SUCCESS;
        use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
        let wide = |s: &str| s.encode_utf16().chain([0]).collect::<Vec<u16>>();
        let key = wide(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
        let name = wide("AppsUseLightTheme");
        let mut light: u32 = 1;
        let mut size = std::mem::size_of::<u32>() as u32;
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                name.as_ptr(),
                RRF_RT_REG_DWORD,
                std::ptr::null_mut(),
                (&mut light as *mut u32).cast(),
                &mut size,
            )
        };
        if status == ERROR_SUCCESS && light == 0 { Theme::Dark } else { Theme::Light }
    }
}
