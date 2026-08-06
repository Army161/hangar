#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
//! Hangar desktop shell.
//!
//! The dashboard is the same HTML/CSS/JS that shipped on the Node stack,
//! moved across byte-identical. What changes is the transport: the browser
//! build talked to `127.0.0.1:7420` over HTTP; this build talks to the same
//! logic over Tauri IPC.
//!
//! **There is no TCP listener in the shipped app.** That was a dev affordance
//! and it is gone — a tool that reads your process table should not be
//! reachable over a socket, even a loopback one.
//!
//! Every write still passes the same three gates as the Node build: dry-run
//! plan, typed confirmation phrase, re-evaluation against a fresh process
//! table, manifest written before the first change.

mod state;

use hangar_core::{collect, executor};
use state::AppState;
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};

// ---------------------------------------------------------------------------
// Read commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn snapshot(app: tauri::State<'_, Mutex<AppState>>) -> Result<serde_json::Value, String> {
    let mut st = app.lock().map_err(|e| e.to_string())?;
    st.snapshot()
}

#[tauri::command]
fn manifests(app: tauri::State<'_, Mutex<AppState>>) -> Result<serde_json::Value, String> {
    let st = app.lock().map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "manifests": st.store.list() }))
}

#[tauri::command]
fn health() -> serde_json::Value {
    serde_json::json!({
        "ok": true,
        "readOnly": false,
        "version": env!("CARGO_PKG_VERSION"),
        "engine": "rust",
        "elevated": executor::is_elevated(),
    })
}

// ---------------------------------------------------------------------------
// Write commands — each one is gated
// ---------------------------------------------------------------------------

#[tauri::command]
fn plan(
    app: tauri::State<'_, Mutex<AppState>>,
    pids: Vec<u32>,
    include_tree: Option<bool>,
) -> Result<serde_json::Value, String> {
    let mut st = app.lock().map_err(|e| e.to_string())?;
    st.plan_kill(&pids, include_tree.unwrap_or(true))
}

#[tauri::command]
fn execute(
    app: tauri::State<'_, Mutex<AppState>>,
    plan_id: String,
    confirm: String,
) -> Result<serde_json::Value, String> {
    let mut st = app.lock().map_err(|e| e.to_string())?;
    st.execute_kill(&plan_id, &confirm)
}

#[tauri::command]
fn persist_plan(
    app: tauri::State<'_, Mutex<AppState>>,
    ids: Vec<String>,
    mode: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut st = app.lock().map_err(|e| e.to_string())?;
    st.plan_persistence(&ids, mode.as_deref().unwrap_or("disable"))
}

#[tauri::command]
fn persist_execute(
    app: tauri::State<'_, Mutex<AppState>>,
    plan_id: String,
    confirm: String,
) -> Result<serde_json::Value, String> {
    let mut st = app.lock().map_err(|e| e.to_string())?;
    st.execute_persistence(&plan_id, &confirm)
}

#[tauri::command]
fn restore(
    app: tauri::State<'_, Mutex<AppState>>,
    manifest_id: String,
) -> Result<serde_json::Value, String> {
    let mut st = app.lock().map_err(|e| e.to_string())?;
    st.restore(&manifest_id)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Mutex::new(AppState::new()))
        .invoke_handler(tauri::generate_handler![
            snapshot,
            manifests,
            health,
            plan,
            execute,
            persist_plan,
            persist_execute,
            restore,
        ])
        .setup(|app| {
            // Tray shows live pressure without opening the window — the whole
            // point is noticing sprawl before it becomes a 30 GB surprise.
            let open = MenuItem::with_id(app, "open", "Open Hangar", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;

            TrayIconBuilder::with_id("hangar-tray")
                .menu(&menu)
                .tooltip("Hangar — starting…")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            // Refresh the tooltip on a slow cadence. The collector is ~75 ms,
            // so this is cheap, but there is no reason to run it at 1 Hz when
            // nobody is looking at the window.
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(15));
                let procs = collect::processes();
                let (total_kb, free_kb, _) = collect::memory();
                let used_gb = (total_kb.saturating_sub(free_kb)) as f64 / 1_048_576.0;
                let total_gb = total_kb as f64 / 1_048_576.0;
                if let Some(tray) = handle.tray_by_id("hangar-tray") {
                    let _ = tray.set_tooltip(Some(&format!(
                        "Hangar — {} processes · {:.1}/{:.0} GB",
                        procs.len(),
                        used_gb,
                        total_gb
                    )));
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Hangar");
}
