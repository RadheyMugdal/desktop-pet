// Hide the console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;

use serde::Deserialize;
use tauri::{
    menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, State, Wry,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

const TRAY_ID: &str = "main";
/// Radio-style groups in the tray menu. Item ids are "<group>:<choice id>".
const GROUPS: [&str; 3] = ["pet", "color", "outfit"];

#[derive(Deserialize)]
struct Choice {
    id: String,
    name: String,
}

/// Menu items we need to reach after the menu is built. The same menu is used
/// for the tray icon and for right-clicking the pet.
#[derive(Default)]
struct TrayState {
    menu: Option<Menu<Wry>>,
    /// Check items for each radio group, so each group behaves like radio buttons.
    groups: Vec<(&'static str, Vec<CheckMenuItem<Wry>>)>,
    roam: Option<CheckMenuItem<Wry>>,
    autostart: Option<CheckMenuItem<Wry>>,
    breaks: Option<CheckMenuItem<Wry>>,
    update: Option<MenuItem<Wry>>,
}

/// Builds the full menu around the pet-specific items in `extra`, installs it
/// on the tray, and remembers the items we update later.
fn install_menu(app: &AppHandle, extra: &[&dyn IsMenuItem<Wry>], mut state: TrayState) -> tauri::Result<()> {
    let nap = MenuItem::with_id(app, "sleep", "Nap time", true, None::<&str>)?;
    let reset = MenuItem::with_id(app, "reset", "Bring pet back", true, None::<&str>)?;
    let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);
    let autostart = CheckMenuItem::with_id(app, "autostart", "Start with computer", true, autostart_on, None::<&str>)?;
    let breaks_on = app.state::<presence::Settings>().breaks.load(std::sync::atomic::Ordering::Relaxed);
    let breaks = CheckMenuItem::with_id(app, "breaks", "Break reminders", true, breaks_on, None::<&str>)?;
    let update = MenuItem::with_id(app, "update", updates::label(app), true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let sep3 = PredefinedMenuItem::separator(app)?;

    let mut items: Vec<&dyn IsMenuItem<Wry>> = vec![&nap, &reset, &sep1];
    items.extend_from_slice(extra);
    if !extra.is_empty() {
        items.push(&sep2);
    }
    items.extend([&breaks as &dyn IsMenuItem<Wry>, &autostart, &update, &sep3, &quit]);
    let menu = Menu::with_items(app, &items)?;

    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_menu(Some(menu.clone()))?;
    }
    state.menu = Some(menu);
    state.autostart = Some(autostart);
    state.breaks = Some(breaks);
    state.update = Some(update);
    *app.state::<Mutex<TrayState>>().lock().unwrap() = state;
    Ok(())
}

fn as_items(items: &[CheckMenuItem<Wry>]) -> Vec<&dyn IsMenuItem<Wry>> {
    items.iter().map(|i| i as &dyn IsMenuItem<Wry>).collect()
}

/// Called by the frontend once it has loaded the pet, with the saved choices.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
fn set_menu(
    app: AppHandle,
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

    let state = TrayState {
        groups: vec![("pet", pet_items), ("color", color_items), ("outfit", outfit_items)],
        roam: Some(roam_item.clone()),
        ..Default::default()
    };
    install_menu(&app, &extra, state)
}

/// Right-clicking the pet opens the same menu as the tray icon.
#[tauri::command]
fn show_pet_menu(window: tauri::Window, state: State<Mutex<TrayState>>) -> tauri::Result<()> {
    let menu = state.lock().unwrap().menu.clone();
    if let Some(menu) = menu {
        window.popup_menu(&menu)?;
    }
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
    let state = app.state::<Mutex<TrayState>>();
    match id {
        "quit" => app.exit(0),
        "roam" => {
            let on = state.lock().unwrap().roam.as_ref().and_then(|i| i.is_checked().ok());
            if let Some(on) = on {
                let _ = app.emit("roam", on);
            }
        }
        "autostart" => {
            let on = state.lock().unwrap().autostart.as_ref().and_then(|i| i.is_checked().ok());
            let launcher = app.autolaunch();
            let _ = match on {
                Some(true) => launcher.enable(),
                Some(false) => launcher.disable(),
                None => Ok(()),
            };
        }
        "breaks" => {
            let on = state.lock().unwrap().breaks.as_ref().and_then(|i| i.is_checked().ok());
            if let Some(on) = on {
                app.state::<presence::Settings>().breaks.store(on, std::sync::atomic::Ordering::Relaxed);
                let _ = app.emit("breaks", on); // the frontend remembers the choice
            }
        }
        "update" => updates::menu_clicked(app.clone()),
        _ => {
            let _ = app.emit("tray", id);
        }
    }
}

/// Turn "Start with computer" on the first time an installed copy runs.
/// Debug builds never touch it, so `npm run dev` doesn't register itself.
fn enable_autostart_once(app: &AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    let Ok(dir) = app.path().app_config_dir() else { return };
    let marker = dir.join("autostart-initialized");
    if marker.exists() {
        return;
    }
    let _ = app.autolaunch().enable();
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(marker, "");
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Mutex::new(TrayState::default()))
        .manage(updates::Pending::default())
        .manage(presence::Settings::default())
        .manage(hit::Hitbox::default())
        .invoke_handler(tauri::generate_handler![
            set_menu,
            show_pet_menu,
            hit::set_hitbox,
            hit::hold_cursor,
            presence::set_break_reminders
        ])
        .setup(|app| {
            TrayIconBuilder::with_id(TRAY_ID)
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Desktop Pet")
                .on_menu_event(|app, event| on_menu_event(app, event.id.as_ref()))
                .build(app)?;
            enable_autostart_once(app.handle());
            install_menu(app.handle(), &[], TrayState::default())?;

            hit::watch(app.handle().clone());
            updates::watch(app.handle().clone());
            presence::watch(app.handle().clone());
            #[cfg(windows)]
            fullscreen::watch(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running desktop pet");
}

/// Checks GitHub for a newer release, downloads it in the background, and
/// offers "Restart to update" in the menu. Nothing installs until the user
/// clicks it.
mod updates {
    use std::{sync::Mutex, thread, time::Duration};
    use tauri::{AppHandle, Manager};
    use tauri_plugin_updater::{Update, UpdaterExt};

    use super::TrayState;

    const EVERY: Duration = Duration::from_secs(6 * 60 * 60);

    /// A downloaded update waiting for the user, plus whether a check is running.
    #[derive(Default)]
    pub struct Pending {
        ready: Mutex<Option<(Update, Vec<u8>)>>,
        busy: Mutex<bool>,
    }

    pub fn label(app: &AppHandle) -> String {
        let pending = app.state::<Pending>();
        let ready = pending.ready.lock().unwrap();
        match ready.as_ref() {
            Some((u, _)) => format!("Restart to update to {}", u.version),
            None => "Check for updates".into(),
        }
    }

    fn set_label(app: &AppHandle, text: &str) {
        let item = app.state::<Mutex<TrayState>>().lock().unwrap().update.clone();
        if let Some(item) = item {
            let _ = item.set_text(text);
        }
    }

    /// Looks for an update and downloads it. Returns a message for the menu
    /// when there's nothing to install.
    async fn check(app: &AppHandle) -> Option<&'static str> {
        let pending = app.state::<Pending>();
        {
            let mut busy = pending.busy.lock().unwrap();
            if *busy || pending.ready.lock().unwrap().is_some() {
                return None;
            }
            *busy = true;
        }
        let found = match app.updater() {
            Ok(updater) => updater.check().await,
            Err(e) => Err(e),
        };
        let message = match found {
            Ok(None) => Some("Up to date"),
            Ok(Some(update)) => match update.download(|_, _| {}, || {}).await {
                Ok(bytes) => {
                    *pending.ready.lock().unwrap() = Some((update, bytes));
                    None
                }
                Err(_) => Some("Couldn't download the update"),
            },
            Err(_) => Some("Couldn't check for updates"),
        };
        *pending.busy.lock().unwrap() = false;
        set_label(app, &label(app));
        message
    }

    /// Check at startup and every few hours (installed builds only).
    pub fn watch(app: AppHandle) {
        if cfg!(debug_assertions) {
            return;
        }
        thread::spawn(move || loop {
            thread::sleep(Duration::from_secs(20)); // let the pet settle in first
            tauri::async_runtime::block_on(check(&app));
            thread::sleep(EVERY);
        });
    }

    pub fn menu_clicked(app: AppHandle) {
        let ready = app.state::<Pending>().ready.lock().unwrap().take();
        if let Some((update, bytes)) = ready {
            set_label(&app, "Installing update…");
            // On Windows the installer closes the app itself; elsewhere we restart into the new version.
            if update.install(bytes).is_ok() {
                app.restart();
            }
            set_label(&app, "Update failed, try again later");
            return;
        }
        tauri::async_runtime::spawn(async move {
            set_label(&app, "Checking for updates…");
            if let Some(message) = check(&app).await {
                set_label(&app, message);
            }
        });
    }
}

/// Notices when you step away (so the pet naps) and when you've been working a
/// long stretch without a break (so it can suggest one). It only reads how long
/// ago the last keyboard or mouse input happened, never what it was.
mod presence {
    use std::{
        sync::atomic::{AtomicBool, Ordering},
        thread,
        time::{Duration, Instant},
    };
    use tauri::{AppHandle, Emitter, Manager, State};

    /// Idle this long and the pet dozes off.
    const AWAY_AFTER: u64 = 3 * 60;
    /// Idle this long counts as having taken a break.
    const BREAK_TAKEN: u64 = 5 * 60;
    /// Suggest a break after this much work...
    const WORK_STRETCH: Duration = Duration::from_secs(50 * 60);
    /// ...and again this often until one is taken.
    const REMIND_EVERY: Duration = Duration::from_secs(15 * 60);

    pub struct Settings {
        pub breaks: AtomicBool,
    }

    impl Default for Settings {
        fn default() -> Self {
            Self { breaks: AtomicBool::new(true) }
        }
    }

    #[tauri::command]
    pub fn set_break_reminders(settings: State<Settings>, on: bool) {
        settings.breaks.store(on, Ordering::Relaxed);
    }

    #[cfg(windows)]
    fn idle_seconds() -> Option<u64> {
        use windows_sys::Win32::{
            System::SystemInformation::GetTickCount,
            UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO},
        };
        unsafe {
            let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
            if GetLastInputInfo(&mut info) == 0 {
                return None;
            }
            Some(u64::from(GetTickCount().wrapping_sub(info.dwTime) / 1000))
        }
    }

    #[cfg(target_os = "macos")]
    fn idle_seconds() -> Option<u64> {
        #[link(name = "CoreGraphics", kind = "framework")]
        extern "C" {
            fn CGEventSourceSecondsSinceLastEventType(state: i32, event_type: u32) -> f64;
        }
        // Combined session state, any input event type.
        let seconds = unsafe { CGEventSourceSecondsSinceLastEventType(0, u32::MAX) };
        Some(seconds as u64)
    }

    /// Not available yet on Linux, so the pet keeps its usual routine there.
    #[cfg(not(any(windows, target_os = "macos")))]
    fn idle_seconds() -> Option<u64> {
        None
    }

    pub fn watch(app: AppHandle) {
        thread::spawn(move || {
            let mut away = false;
            let mut working_since = Instant::now();
            let mut last_reminder: Option<Instant> = None;
            loop {
                thread::sleep(Duration::from_secs(5));
                let Some(idle) = idle_seconds() else { return };

                if idle >= AWAY_AFTER && !away {
                    away = true;
                    let _ = app.emit("presence", "away");
                } else if idle < 5 && away {
                    away = false;
                    let _ = app.emit("presence", "back");
                }

                if idle >= BREAK_TAKEN {
                    working_since = Instant::now();
                    last_reminder = None;
                    continue;
                }
                let enabled = app.state::<Settings>().breaks.load(Ordering::Relaxed);
                // No reminders while the pet is hidden behind a fullscreen game or video.
                let visible = app.get_webview_window("main").and_then(|w| w.is_visible().ok()).unwrap_or(false);
                let due = last_reminder.map_or(true, |t| t.elapsed() >= REMIND_EVERY);
                if enabled && visible && due && working_since.elapsed() >= WORK_STRETCH {
                    last_reminder = Some(Instant::now());
                    let _ = app.emit("break", ());
                }
            }
        });
    }
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
