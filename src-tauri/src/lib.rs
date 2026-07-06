// Echo desktop shell — Tauri v2 launcher.
//
// Responsibilities:
//   1. Pick a free localhost port.
//   2. Spawn the bundled Node runtime (sidecar) running the existing
//      Express backend (server.js), pointed at writable app-data paths
//      for the SQLite DB and the @xenova model cache.
//   3. Poll the backend until it responds, then navigate the main window
//      from the bundled loading page to http://127.0.0.1:<port>/.
//   4. Kill the sidecar when the window closes / the app exits.
//
// NOTE: this file cannot be compiled in this environment (no Rust/MSVC
// toolchain installed here). It has been written against the documented
// Tauri v2.11 / tauri-plugin-shell 2.x APIs but is UNVERIFIED until the
// first `cargo tauri dev` / `cargo build` on a machine with the toolchain.
// See DESKTOP.md for the specific API calls to double-check.

use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use tauri::{Manager, WindowEvent};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

/// Holds the running sidecar's child handle so it can be killed on window
/// close / app exit. `OnceLock` + `Mutex` because `run()` takes no `&mut
/// self` and the setup/event closures are `Fn`, not `FnMut`.
static BACKEND_CHILD: OnceLock<Mutex<Option<CommandChild>>> = OnceLock::new();

fn backend_child_slot() -> &'static Mutex<Option<CommandChild>> {
  BACKEND_CHILD.get_or_init(|| Mutex::new(None))
}

/// Try to find a free TCP port on 127.0.0.1, starting at `start` and
/// scanning up to `start + tries`. Binds and immediately drops the
/// listener so the port is free again by the time the sidecar binds it
/// (small TOCTOU window, acceptable for a local dev-machine handshake).
fn find_free_port(start: u16, tries: u16) -> u16 {
  for offset in 0..tries {
    let port = start.saturating_add(offset);
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    if TcpListener::bind(addr).is_ok() {
      return port;
    }
  }
  // Fall back to the preferred default even if we couldn't prove it free —
  // the sidecar spawn will simply fail loudly and the loading page reports it.
  start
}

/// Poll `127.0.0.1:<port>` until a TCP connection succeeds (server is up)
/// or the timeout elapses. Runs on a background thread so it never blocks
/// the Tauri event loop.
fn wait_for_backend_ready(port: u16, timeout: Duration) -> bool {
  let addr: SocketAddr = ([127, 0, 0, 1], port).into();
  let deadline = std::time::Instant::now() + timeout;
  while std::time::Instant::now() < deadline {
    if TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok() {
      return true;
    }
    std::thread::sleep(Duration::from_millis(250));
  }
  false
}

/// Spawn the Node sidecar running the bundled `server.js`, wire up its
/// env (port + writable app-data paths), and once it responds, navigate
/// the main window from the loading page to the live app.
fn start_backend(app_handle: tauri::AppHandle) {
  let port = find_free_port(8737, 100);

  let resource_dir = app_handle
    .path()
    .resource_dir()
    .expect("failed to resolve resource_dir");
  let app_data_dir = app_handle
    .path()
    .app_data_dir()
    .expect("failed to resolve app_data_dir");

  let db_path: PathBuf = app_data_dir.join("library.db");
  let models_dir: PathBuf = app_data_dir.join("models");

  if let Err(err) = std::fs::create_dir_all(&app_data_dir) {
    log::error!("[echo] failed to create app data dir: {err}");
  }
  if let Err(err) = std::fs::create_dir_all(&models_dir) {
    log::error!("[echo] failed to create models dir: {err}");
  }

  let server_entry = resource_dir.join("server.js");

  let sidecar_cmd = app_handle
    .shell()
    .sidecar("binaries/node")
    .expect("failed to resolve node sidecar")
    .current_dir(resource_dir.clone())
    .args([server_entry.to_string_lossy().to_string()])
    .env("PORT", port.to_string())
    .env("ECHO_DB_PATH", db_path.to_string_lossy().to_string())
    .env("ECHO_MODELS_DIR", models_dir.to_string_lossy().to_string())
    .env("ECHO_MODE", "desktop");

  let (mut rx, child) = match sidecar_cmd.spawn() {
    Ok(pair) => pair,
    Err(err) => {
      log::error!("[echo] failed to spawn node sidecar: {err}");
      show_startup_error(&app_handle, &format!("Failed to start Echo backend: {err}"));
      return;
    }
  };

  *backend_child_slot().lock().unwrap() = Some(child);

  // Forward sidecar stdout/stderr into the Rust log for debugging.
  tauri::async_runtime::spawn(async move {
    use tauri_plugin_shell::process::CommandEvent;
    while let Some(event) = rx.recv().await {
      match event {
        CommandEvent::Stdout(line) => {
          log::info!("[echo-backend] {}", String::from_utf8_lossy(&line));
        }
        CommandEvent::Stderr(line) => {
          log::warn!("[echo-backend] {}", String::from_utf8_lossy(&line));
        }
        CommandEvent::Error(err) => {
          log::error!("[echo-backend] error: {err}");
        }
        CommandEvent::Terminated(payload) => {
          log::info!("[echo-backend] terminated: {:?}", payload);
        }
        _ => {}
      }
    }
  });

  // Poll for readiness off the main thread, then hop back onto the
  // window to navigate it once the backend responds.
  let handle_for_wait = app_handle.clone();
  std::thread::spawn(move || {
    let ready = wait_for_backend_ready(port, Duration::from_secs(30));
    if !ready {
      log::error!("[echo] backend did not become ready on port {port} within 30s");
      show_startup_error(
        &handle_for_wait,
        "Echo's backend did not start in time. Check that Node and its \
         dependencies are bundled correctly, then restart the app.",
      );
      return;
    }

    if let Some(window) = handle_for_wait.get_webview_window("main") {
      let url = format!("http://127.0.0.1:{port}/");
      match tauri::Url::parse(&url) {
        Ok(parsed) => {
          if let Err(err) = window.navigate(parsed) {
            log::error!("[echo] failed to navigate window to backend: {err}");
          }
        }
        Err(err) => {
          log::error!("[echo] failed to parse backend URL {url}: {err}");
        }
      }
    }
  });
}

/// Replace the loading page's contents with a plain-text error message.
/// Best-effort — if the window is already gone this silently no-ops.
fn show_startup_error(app_handle: &tauri::AppHandle, message: &str) {
  if let Some(window) = app_handle.get_webview_window("main") {
    let escaped = message.replace('\\', "\\\\").replace('`', "\\`");
    let script = format!(
      "document.body.innerHTML = `<div style=\"font-family:sans-serif;padding:2rem;color:#e6e6e6\"><h2>Echo failed to start</h2><p>{escaped}</p></div>`;"
    );
    let _ = window.eval(&script);
  }
}

/// Kill the running backend sidecar, if any. Safe to call multiple times.
fn kill_backend() {
  if let Ok(mut guard) = backend_child_slot().lock() {
    if let Some(child) = guard.take() {
      if let Err(err) = child.kill() {
        log::warn!("[echo] failed to kill backend sidecar: {err}");
      }
    }
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      start_backend(app.handle().clone());

      Ok(())
    })
    .on_window_event(|_window, event| {
      if matches!(event, WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed) {
        kill_backend();
      }
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
