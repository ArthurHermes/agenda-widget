#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod clickthrough;
mod google;
mod window;

use serde_json::Value;
use std::{fs, path::PathBuf, time::Duration};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

// ---------- Configuração (JSON livre; os padrões ficam no frontend) ----------

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("config.json"))
}

pub fn read_config(app: &AppHandle) -> Value {
    config_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| Value::Object(Default::default()))
}

#[tauri::command]
fn get_config(app: AppHandle) -> Value {
    read_config(&app)
}

pub fn write_config(app: &AppHandle, config: &Value) -> Result<(), String> {
    let path = config_path(app)?;
    let text = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    fs::write(path, text).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_config(app: AppHandle, config: Value) -> Result<(), String> {
    write_config(&app, &config)
}

// ---------- Agendas iCal (download no Rust para evitar CORS) ----------

#[tauri::command]
async fn fetch_ics(url: String) -> Result<String, String> {
    let url = url.trim();
    let url = match url.strip_prefix("webcal://") {
        Some(rest) => format!("https://{rest}"),
        None => url.to_string(),
    };
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("A URL precisa começar com https://".into());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("agenda-widget/0.2")
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    resp.text().await.map_err(|e| e.to_string())
}

// ---------- Bandeja ----------

fn open_settings(app: &AppHandle) {
    let _ = window::open(app, "settings", "settings.html", "Agenda Widget: configurações", 640.0, 720.0);
}

fn toggle_widget(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(window::MAIN) {
        if w.is_visible().unwrap_or(true) {
            let _ = w.hide();
        } else {
            let _ = w.show();
        }
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);
    let click_through_on = app.state::<clickthrough::ClickThrough>().is_enabled();

    let toggle = MenuItem::with_id(app, "toggle", "Mostrar/esconder widget", true, None::<&str>)?;
    let click_through = CheckMenuItem::with_id(
        app,
        "click-through",
        "Atravessar cliques (Ctrl para usar)",
        true,
        click_through_on,
        None::<&str>,
    )?;
    app.manage(clickthrough::TrayToggle(click_through.clone()));

    let refresh = MenuItem::with_id(app, "refresh", "Atualizar agora", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Configurações…", true, None::<&str>)?;
    let reset = MenuItem::with_id(app, "reset", "Trazer para o canto", true, None::<&str>)?;
    let autostart =
        CheckMenuItem::with_id(app, "autostart", "Iniciar com o Windows", true, autostart_on, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Sair", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[&toggle, &click_through, &sep, &refresh, &settings, &reset, &sep, &autostart, &sep, &quit],
    )?;

    let autostart_item = autostart.clone();
    TrayIconBuilder::with_id("tray")
        .icon(app.default_window_icon().cloned().unwrap())
        .tooltip("Agenda Widget")
        .menu(&menu)
        .show_menu_on_left_click(false)
        // Clique esquerdo no ícone: mostra/esconde o widget.
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                toggle_widget(tray.app_handle());
            }
        })
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "toggle" => toggle_widget(app),
            "click-through" => {
                let on = !app.state::<clickthrough::ClickThrough>().is_enabled();
                clickthrough::set(app, on, true);
            }
            "refresh" => {
                let _ = app.emit("events-changed", ());
            }
            "settings" => open_settings(app),
            "reset" => {
                if let Some(w) = app.get_webview_window(window::MAIN) {
                    let _ = w.set_size(tauri::LogicalSize::new(340.0, 520.0));
                    window::move_to_corner(&w, "top-right");
                    let _ = w.show();
                }
            }
            "autostart" => {
                let al = app.autolaunch();
                let enabled = al.is_enabled().unwrap_or(false);
                let _ = if enabled { al.disable() } else { al.enable() };
                let _ = autostart_item.set_checked(al.is_enabled().unwrap_or(false));
            }
            "quit" => {
                let _ = app.save_window_state(StateFlags::POSITION | StateFlags::SIZE);
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        // Abrir o app de novo só traz o widget existente (evita duplicatas).
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window(window::MAIN) {
                let _ = w.show();
            }
        }))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::POSITION | StateFlags::SIZE)
                // Só o widget lembra posição/tamanho; configurações e editores não.
                .with_filter(|label| label == window::MAIN)
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_opener::init())
        .manage(google::Tokens::default())
        .manage(clickthrough::ClickThrough::default())
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            fetch_ics,
            google::google_login,
            google::google_logout,
            google::google_request,
            window::apply_window_options,
            window::get_widget_geometry,
            window::set_widget_geometry,
            window::move_widget_to,
            window::open_window,
            clickthrough::set_click_through,
            clickthrough::get_click_through,
        ])
        .on_window_event(|win, event| {
            if win.label() != window::MAIN {
                return;
            }
            if matches!(event, WindowEvent::Moved(_) | WindowEvent::Resized(_)) {
                if let Some(w) = win.app_handle().get_webview_window(window::MAIN) {
                    let _ = win.app_handle().emit("widget-geometry", window::geometry(&w));
                }
            }
        })
        .setup(|app| {
            let cfg = read_config(app.handle());
            let click_through = cfg["appearance"]["click_through"].as_bool().unwrap_or(false);
            clickthrough::set(app.handle(), click_through, false);
            build_tray(app.handle())?;
            if let Some(win) = app.get_webview_window(window::MAIN) {
                // Primeira execução (sem posição salva): canto superior direito.
                let saved = app
                    .path()
                    .app_config_dir()
                    .map(|d| d.join(".window-state.json").exists())
                    .unwrap_or(false);
                if !saved {
                    window::move_to_corner(&win, "top-right");
                }
                let layer = cfg["appearance"]["layer"].as_str().unwrap_or("desktop");
                let locked = cfg["appearance"]["locked"].as_bool().unwrap_or(false);
                window::apply_options(&win, layer, locked);
                win.show()?;
            }
            clickthrough::start(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o app");
}
