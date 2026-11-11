//! Travar e "atravessar cliques".
//!
//! - Destravado (modo edição): o widget é totalmente clicável, arrasta e redimensiona.
//! - Travado: não move nem redimensiona. Se "atravessar cliques" estiver ligado,
//!   os cliques passam para o que está atrás; segurando Ctrl com o mouse em cima,
//!   o widget volta a responder (para clicar num evento, por exemplo).

use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::Duration,
};
use tauri::{menu::CheckMenuItem, AppHandle, Emitter, Manager, Wry};

use crate::{read_config, window::MAIN, write_config};

/// Estado efetivo: atravessa cliques = click_through && locked.
#[derive(Clone, Default)]
pub struct ClickThrough {
    active: Arc<AtomicBool>,
}

impl ClickThrough {
    fn is_active(&self) -> bool {
        self.active.load(Ordering::Relaxed)
    }
}

/// Itens da bandeja, para manter os ✓ sincronizados com a config.
pub struct TrayItems {
    pub locked: CheckMenuItem<Wry>,
    pub click_through: CheckMenuItem<Wry>,
}

/// Aplica travar + atravessar cliques (chamado na inicialização e pelo widget).
pub fn apply(app: &AppHandle, click_through: bool, locked: bool) {
    app.state::<ClickThrough>()
        .active
        .store(click_through && locked, Ordering::Relaxed);
    if let Some(items) = app.try_state::<TrayItems>() {
        let _ = items.locked.set_checked(locked);
        let _ = items.click_through.set_checked(click_through);
    }
    if let Some(win) = app.get_webview_window(MAIN) {
        let _ = win.set_resizable(!locked);
    }
}

#[tauri::command]
pub fn apply_interaction(app: AppHandle, click_through: bool, locked: bool) {
    apply(&app, click_through, locked);
}

/// Inverte appearance.<key> na config, grava e avisa as janelas.
pub fn toggle_flag(app: &AppHandle, key: &str) {
    let mut cfg = read_config(app);
    if !cfg.is_object() {
        cfg = json!({});
    }
    if !cfg["appearance"].is_object() {
        cfg["appearance"] = json!({});
    }
    let current = cfg["appearance"][key].as_bool().unwrap_or(false);
    cfg["appearance"][key] = Value::Bool(!current);
    let ct = cfg["appearance"]["click_through"].as_bool().unwrap_or(false);
    let locked = cfg["appearance"]["locked"].as_bool().unwrap_or(false);
    apply(app, ct, locked);
    if write_config(app, &cfg).is_ok() {
        let _ = app.emit("config-changed", cfg);
    }
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
        // (ignorando cliques?, mouse em cima?, ativo?)
        let mut last: Option<(bool, bool, bool)> = None;
        loop {
            thread::sleep(Duration::from_millis(40));
            let active = state.is_active();
            let (over, ctrl) = if active { cursor_and_ctrl(hwnd) } else { (false, false) };
            let ignoring = active && !(over && ctrl);
            let now = (ignoring, over, active);
            if last == Some(now) {
                continue;
            }
            if last.map(|l| l.0) != Some(ignoring) {
                let _ = win.set_ignore_cursor_events(ignoring);
            }
            let _ = app.emit_to(
                MAIN,
                "pointer-state",
                json!({ "enabled": active, "over": over, "interactive": !ignoring }),
            );
            last = Some(now);
        }
    });
}
