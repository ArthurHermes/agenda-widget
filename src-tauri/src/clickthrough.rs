//! Modo "atravessar cliques": o widget deixa os cliques passarem para o que
//! está atrás (ícones da área de trabalho, outras janelas). Segurando Ctrl com
//! o mouse em cima dele, o widget volta a responder normalmente.

use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::Duration,
};
use tauri::{menu::CheckMenuItem, AppHandle, Emitter, Manager, State, Wry};

use crate::{read_config, window::MAIN, write_config};

#[derive(Clone, Default)]
pub struct ClickThrough {
    enabled: Arc<AtomicBool>,
}

/// Item "Atravessar cliques" do menu da bandeja, para manter o ✓ sincronizado.
pub struct TrayToggle(pub CheckMenuItem<Wry>);

impl ClickThrough {
    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }
}

/// Liga/desliga o modo, atualiza o ✓ da bandeja e (opcionalmente) grava na config.
pub fn set(app: &AppHandle, enabled: bool, persist: bool) {
    app.state::<ClickThrough>().enabled.store(enabled, Ordering::Relaxed);
    if let Some(item) = app.try_state::<TrayToggle>() {
        let _ = item.0.set_checked(enabled);
    }
    if persist {
        let mut cfg = read_config(app);
        if !cfg.is_object() {
            cfg = json!({});
        }
        if !cfg["appearance"].is_object() {
            cfg["appearance"] = json!({});
        }
        cfg["appearance"]["click_through"] = Value::Bool(enabled);
        if write_config(app, &cfg).is_ok() {
            let _ = app.emit("config-changed", cfg);
        }
    }
}

#[tauri::command]
pub fn set_click_through(app: AppHandle, enabled: bool) {
    set(&app, enabled, false);
}

#[tauri::command]
pub fn get_click_through(state: State<'_, ClickThrough>) -> bool {
    state.is_enabled()
}

#[cfg(windows)]
fn cursor_and_ctrl(hwnd: isize) -> (bool, bool) {
    use windows_sys::Win32::{
        Foundation::{POINT, RECT},
        UI::{
            Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL},
            WindowsAndMessaging::{GetCursorPos, GetWindowRect},
        },
    };
    unsafe {
        let mut p = POINT { x: 0, y: 0 };
        let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        if GetCursorPos(&mut p) == 0 || GetWindowRect(hwnd as _, &mut r) == 0 {
            return (false, false);
        }
        let over = p.x >= r.left && p.x < r.right && p.y >= r.top && p.y < r.bottom;
        let ctrl = (GetAsyncKeyState(VK_CONTROL as i32) as u16 & 0x8000) != 0;
        (over, ctrl)
    }
}

#[cfg(not(windows))]
fn cursor_and_ctrl(_hwnd: isize) -> (bool, bool) {
    (false, false)
}

/// Thread que acompanha cursor + Ctrl e liga/desliga o "ignorar mouse" da janela.
pub fn start(app: AppHandle) {
    let Some(win) = app.get_webview_window(MAIN) else { return };
    #[cfg(windows)]
    let hwnd = match win.hwnd() {
        Ok(h) => h.0 as isize,
        Err(_) => return,
    };
    #[cfg(not(windows))]
    let hwnd = 0isize;
    let state = app.state::<ClickThrough>().inner().clone();

    thread::spawn(move || {
        // (ignorando cliques?, mouse em cima?, interativo?)
        let mut last: Option<(bool, bool, bool)> = None;
        loop {
            thread::sleep(Duration::from_millis(40));
            let enabled = state.is_enabled();
            let (over, ctrl) = if enabled { cursor_and_ctrl(hwnd) } else { (false, false) };
            let interactive = !enabled || (over && ctrl);
            let now = (!interactive, over, interactive);
            if last == Some(now) {
                continue;
            }
            if last.map(|l| l.0) != Some(now.0) {
                let _ = win.set_ignore_cursor_events(now.0);
            }
            let _ = app.emit_to(
                MAIN,
                "pointer-state",
                json!({ "enabled": enabled, "over": over, "interactive": interactive }),
            );
            last = Some(now);
        }
    });
}
