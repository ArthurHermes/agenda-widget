//! Posição, tamanho, camada (área de trabalho / normal / topo) e janelas extras.

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const MAIN: &str = "main";

fn main_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    app.get_webview_window(MAIN).ok_or_else(|| "janela principal não encontrada".into())
}

/// Define (ou remove) o Progman como "dono" da janela. Com ele, a janela fica
/// presa à área de trabalho e sobrevive ao Win+D.
#[cfg(windows)]
fn set_desktop_owner(win: &WebviewWindow, pinned: bool) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{FindWindowW, SetWindowLongPtrW, GWLP_HWNDPARENT};
    let Ok(hwnd) = win.hwnd() else { return };
    let class: Vec<u16> = "Progman\0".encode_utf16().collect();
    unsafe {
        let owner = if pinned { FindWindowW(class.as_ptr(), std::ptr::null()) as isize } else { 0 };
        SetWindowLongPtrW(hwnd.0 as _, GWLP_HWNDPARENT, owner);
    }
}

#[cfg(not(windows))]
fn set_desktop_owner(_win: &WebviewWindow, _pinned: bool) {}

pub fn apply_options(win: &WebviewWindow, layer: &str, locked: bool) {
    match layer {
        "top" => {
            set_desktop_owner(win, false);
            let _ = win.set_always_on_bottom(false);
            let _ = win.set_always_on_top(true);
        }
        "normal" => {
            set_desktop_owner(win, false);
            let _ = win.set_always_on_bottom(false);
            let _ = win.set_always_on_top(false);
        }
        _ => {
            let _ = win.set_always_on_top(false);
            let _ = win.set_always_on_bottom(true);
            set_desktop_owner(win, true);
        }
    }
    let _ = win.set_resizable(!locked);
}

#[tauri::command]
pub fn apply_window_options(app: AppHandle, layer: String, locked: bool) -> Result<(), String> {
    apply_options(&main_window(&app)?, &layer, locked);
    Ok(())
}

pub fn geometry(win: &WebviewWindow) -> Value {
    let scale = win.scale_factor().unwrap_or(1.0);
    let pos = win.outer_position().unwrap_or_default().to_logical::<f64>(scale);
    let size = win.inner_size().unwrap_or_default().to_logical::<f64>(scale);
    json!({ "x": pos.x.round(), "y": pos.y.round(), "width": size.width.round(), "height": size.height.round() })
}

#[tauri::command]
pub fn get_widget_geometry(app: AppHandle) -> Result<Value, String> {
    Ok(geometry(&main_window(&app)?))
}

#[tauri::command]
pub fn set_widget_geometry(app: AppHandle, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    let win = main_window(&app)?;
    win.set_size(tauri::LogicalSize::new(width.max(200.0), height.max(120.0)))
        .map_err(|e| e.to_string())?;
    win.set_position(tauri::LogicalPosition::new(x, y)).map_err(|e| e.to_string())
}

/// Encosta a janela num canto da área útil do monitor em que ela está.
pub fn move_to_corner(win: &WebviewWindow, corner: &str) {
    let monitor = win
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| win.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else { return };
    let Ok(size) = win.outer_size() else { return };
    let area = monitor.work_area();
    let margin = (24.0 * monitor.scale_factor()) as i32;
    let left = area.position.x + margin;
    let right = area.position.x + area.size.width as i32 - size.width as i32 - margin;
    let top = area.position.y + margin;
    let bottom = area.position.y + area.size.height as i32 - size.height as i32 - margin;
    let (x, y) = match corner {
        "top-left" => (left, top),
        "bottom-left" => (left, bottom),
        "bottom-right" => (right, bottom),
        _ => (right, top),
    };
    let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
}

#[tauri::command]
pub fn move_widget_to(app: AppHandle, corner: String) -> Result<(), String> {
    move_to_corner(&main_window(&app)?, &corner);
    Ok(())
}

/// Abre (ou traz para frente) uma janela comum: configurações ou editor de evento.
pub fn open(app: &AppHandle, label: &str, url: &str, title: &str, width: f64, height: f64) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.unminimize();
        let _ = w.show();
        return w.set_focus().map_err(|e| e.to_string());
    }
    let w = WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(width, height)
        .min_inner_size(360.0, 360.0)
        .center()
        .focused(true)
        .build()
        .map_err(|e| e.to_string())?;
    // Garante que a janela apareça na frente (às vezes nasce minimizada
    // quando o app está em segundo plano).
    let _ = w.unminimize();
    let _ = w.show();
    let _ = w.set_focus();
    Ok(())
}

#[tauri::command]
pub async fn open_window(
    app: AppHandle,
    label: String,
    url: String,
    title: String,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if label == MAIN {
        return Err("rótulo reservado".into());
    }
    open(&app, &label, &url, &title, width, height)
}
