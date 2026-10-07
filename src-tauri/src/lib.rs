use tauri::http::Response;
use tauri::{WebviewUrl, WebviewWindowBuilder};

#[tauri::command]
fn log(level: String, msg: String) {
    eprintln!("[webview {level}] {msg}");
}

const PROBE: &str = r#"
(function () {
  const out = (m) => window.__TAURI_INTERNALS__.invoke('log', { level: 'probe', msg: m });
  for (const url of ['ridesync://localhost/ping', 'src/cn.js']) {
    try {
      const x = new XMLHttpRequest();
      x.open('GET', url, false);
      x.send();
      out(url + ' -> status ' + x.status + ', ' + x.responseText.length + ' chars: ' + JSON.stringify(x.responseText.slice(0, 40)));
    } catch (e) {
      out(url + ' -> ' + e.name + ': ' + e.message);
    }
  }
})();
"#;

pub fn run() {
    tauri::Builder::default()
        .register_uri_scheme_protocol("ridesync", |_ctx, req| {
            let body = if req.uri().path() == "/ping" { "pong" } else { "?" };
            Response::builder()
                .header("Access-Control-Allow-Origin", "*")
                .body(body.as_bytes().to_vec())
                .unwrap()
        })
        .invoke_handler(tauri::generate_handler![log])
        .setup(|app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Ride")
                .inner_size(900.0, 650.0)
                .initialization_script(PROBE)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Ride");
}
