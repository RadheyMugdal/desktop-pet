// Hide the console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;

use serde::Deserialize;
use tauri::{
    menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, State, Wry,
};

const TRAY_ID: &str = "main";
/// Radio-style groups in the tray menu. Item ids are "<group>:<choice id>".
const GROUPS: [&str; 3] = ["pet", "color", "outfit"];

#[derive(Deserialize)]
struct Choice {
    id: String,
    name: String,
}

/// Check items for each radio group, kept so we can make each group behave
/// like radio buttons.
#[derive(Default)]
struct TrayState {
    groups: Vec<(&'static str, Vec<CheckMenuItem<Wry>>)>,
    roam: Option<CheckMenuItem<Wry>>,
}

fn build_menu(app: &AppHandle, extra: &[&dyn IsMenuItem<Wry>]) -> tauri::Result<Menu<Wry>> {
    let nap = MenuItem::with_id(app, "sleep", "Nap time", true, None::<&str>)?;
    let reset = MenuItem::with_id(app, "reset", "Bring pet back", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;

    let mut items: Vec<&dyn IsMenuItem<Wry>> = vec![&nap, &reset, &sep1];
    items.extend_from_slice(extra);
    if !extra.is_empty() {
        items.push(&sep2);
    }
    items.push(&quit);
    Menu::with_items(app, &items)
}

fn as_items(items: &[CheckMenuItem<Wry>]) -> Vec<&dyn IsMenuItem<Wry>> {
    items.iter().map(|i| i as &dyn IsMenuItem<Wry>).collect()
}

/// Called by the frontend once it has loaded the pet, with the saved choices.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
fn set_menu(
    app: AppHandle,
    state: State<Mutex<TrayState>>,
    pets: Vec<Choice>,
    pet: String,
    colors: Vec<Choice>,
    color: String,
    outfits: Vec<Choice>,
    outfit: String,
    roam: bool,
) -> tauri::Result<()> {
    let group = |name: &str, choices: &[&Choice], selected: &str| {
        choices
            .iter()
            .map(|c| CheckMenuItem::with_id(&app, format!("{name}:{}", c.id), &c.name, true, c.id == selected, None::<&str>))
            .collect::<tauri::Result<Vec<_>>>()
    };

    let none = Choice { id: String::new(), name: "None".into() };
    let pet_items = group("pet", &pets.iter().collect::<Vec<_>>(), &pet)?;
    let color_items = group("color", &colors.iter().collect::<Vec<_>>(), &color)?;
    let outfit_items = group("outfit", &std::iter::once(&none).chain(&outfits).collect::<Vec<_>>(), &outfit)?;

    let pet_menu = Submenu::with_items(&app, "Pet", true, &as_items(&pet_items))?;
    let color_menu = Submenu::with_items(&app, "Color", true, &as_items(&color_items))?;
    let outfit_menu = Submenu::with_items(&app, "Outfit", true, &as_items(&outfit_items))?;
    let roam_item = CheckMenuItem::with_id(&app, "roam", "Roam freely", true, roam, None::<&str>)?;

    // Only show the Color and Outfit menus when this pet has a choice to make.
    let mut extra: Vec<&dyn IsMenuItem<Wry>> = vec![&pet_menu];
    if colors.len() > 1 {
        extra.push(&color_menu);
    }
    if !outfits.is_empty() {
        extra.push(&outfit_menu);
    }
    extra.push(&roam_item);

    let menu = build_menu(&app, &extra)?;
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_menu(Some(menu))?;
    }
    *state.lock().unwrap() = TrayState {
        groups: vec![("pet", pet_items), ("color", color_items), ("outfit", outfit_items)],
        roam: Some(roam_item),
    };
    Ok(())
}

fn on_menu_event(app: &AppHandle, id: &str) {
    if let Some((group, choice)) = id.split_once(':').filter(|(g, _)| GROUPS.contains(g)) {
        // Check the clicked item and uncheck the rest of its group. Clicking an
        // already checked item would otherwise uncheck it.
        let state = app.state::<Mutex<TrayState>>();
        if let Some((_, items)) = state.lock().unwrap().groups.iter().find(|(g, _)| *g == group) {
            for item in items {
                let _ = item.set_checked(item.id().as_ref() == id);
            }
        }
        let _ = app.emit(group, choice);
        return;
    }
    match id {
        "quit" => app.exit(0),
        "roam" => {
            let state = app.state::<Mutex<TrayState>>();
            let on = state.lock().unwrap().roam.as_ref().and_then(|i| i.is_checked().ok());
            if let Some(on) = on {
                let _ = app.emit("roam", on);
            }
        }
        _ => {
            let _ = app.emit("tray", id);
        }
    }
}

fn main() {
    tauri::Builder::default()
        .manage(Mutex::new(TrayState::default()))
        .manage(hit::Hitbox::default())
        .invoke_handler(tauri::generate_handler![set_menu, hit::set_hitbox, hit::hold_cursor])
        .setup(|app| {
            let menu = build_menu(app.handle(), &[])?;
            TrayIconBuilder::with_id(TRAY_ID)
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Desktop Pet")
                .menu(&menu)
                .on_menu_event(|app, event| on_menu_event(app, event.id.as_ref()))
                .build(app)?;

            hit::watch(app.handle().clone());
            #[cfg(windows)]
            fullscreen::watch(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running desktop pet");
}

/// The pet window covers the whole work area so the pet can move inside it
/// without the window ever moving (which is expensive for a webview). The window
/// ignores the mouse, so clicks go to whatever is underneath, except while the
/// cursor is over the pet's hitbox, which the frontend keeps up to date.
mod hit {
    use std::{
        sync::{
            atomic::{AtomicBool, Ordering},
            Mutex,
        },
        thread,
        time::Duration,
    };
    use tauri::{AppHandle, Manager, State};

    #[derive(Default)]
    pub struct Hitbox {
        /// x, y, width, height in physical screen pixels.
        rect: Mutex<(f64, f64, f64, f64)>,
        /// Keep receiving the mouse while dragging, even if the cursor outruns the cat.
        hold: AtomicBool,
    }

    #[tauri::command]
    pub fn set_hitbox(hitbox: State<Hitbox>, x: f64, y: f64, w: f64, h: f64) {
        *hitbox.rect.lock().unwrap() = (x, y, w, h);
    }

    #[tauri::command]
    pub fn hold_cursor(hitbox: State<Hitbox>, hold: bool) {
        hitbox.hold.store(hold, Ordering::Relaxed);
    }

    pub fn watch(app: AppHandle) {
        let Some(window) = app.get_webview_window("main") else { return };
        let _ = window.set_ignore_cursor_events(true);
        thread::spawn(move || {
            let mut catching = false;
            loop {
                thread::sleep(Duration::from_millis(50));
                let Ok(cursor) = app.cursor_position() else { continue };
                let hitbox = app.state::<Hitbox>();
                let (x, y, w, h) = *hitbox.rect.lock().unwrap();
                let over = cursor.x >= x && cursor.x < x + w && cursor.y >= y && cursor.y < y + h;
                let want = over || hitbox.hold.load(Ordering::Relaxed);
                if want != catching {
                    catching = want;
                    let _ = window.set_ignore_cursor_events(!catching);
                }
            }
        });
    }
}

/// Hides the pet (and pauses its animation loop) while a fullscreen app such as
/// a game or video player is in front, so it never costs anything there.
#[cfg(windows)]
mod fullscreen {
    use std::{mem, thread, time::Duration};
    use tauri::{AppHandle, Emitter, Manager};
    use windows_sys::Win32::{
        Foundation::RECT,
        Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST},
        UI::WindowsAndMessaging::{
            GetClassNameW, GetDesktopWindow, GetForegroundWindow, GetShellWindow, GetWindowRect,
        },
    };

    fn foreground_is_fullscreen(own: isize) -> bool {
        unsafe {
            let hwnd = GetForegroundWindow();
            // The pet's own window covers the work area, so it never counts either.
            if hwnd.is_null() || hwnd as isize == own || hwnd == GetShellWindow() || hwnd == GetDesktopWindow() {
                return false;
            }
            // The desktop itself covers the whole monitor; don't count it.
            let mut buf = [0u16; 64];
            let len = GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
            let class = String::from_utf16_lossy(&buf[..len.max(0) as usize]);
            if class == "WorkerW" || class == "Progman" {
                return false;
            }
            let mut rect: RECT = mem::zeroed();
            if GetWindowRect(hwnd, &mut rect) == 0 {
                return false;
            }
            let mut info: MONITORINFO = mem::zeroed();
            info.cbSize = mem::size_of::<MONITORINFO>() as u32;
            if GetMonitorInfoW(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST), &mut info) == 0 {
                return false;
            }
            let m = info.rcMonitor;
            rect.left <= m.left && rect.top <= m.top && rect.right >= m.right && rect.bottom >= m.bottom
        }
    }

    pub fn watch(app: AppHandle) {
        let own = app
            .get_webview_window("main")
            .and_then(|w| w.hwnd().ok())
            .map_or(0, |h| h.0 as isize);
        thread::spawn(move || {
            let mut last = false;
            loop {
                thread::sleep(Duration::from_millis(1500));
                let fullscreen = foreground_is_fullscreen(own);
                if fullscreen == last {
                    continue;
                }
                last = fullscreen;
                if let Some(window) = app.get_webview_window("main") {
                    let _ = if fullscreen { window.hide() } else { window.show() };
                }
                let _ = app.emit("fullscreen", fullscreen);
            }
        });
    }
}
