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
    sound: Option<CheckMenuItem<Wry>>,
    autostart: Option<CheckMenuItem<Wry>>,
    breaks: Option<CheckMenuItem<Wry>>,
    update: Option<MenuItem<Wry>>,
    yarn: Option<MenuItem<Wry>>,
}

/// Builds the full menu around the pet-specific items in `extra`, installs it
/// on the tray, and remembers the items we update later.
fn install_menu(app: &AppHandle, extra: &[&dyn IsMenuItem<Wry>], mut state: TrayState) -> tauri::Result<()> {
    let nap = MenuItem::with_id(app, "sleep", "Nap time", true, None::<&str>)?;
    let reset = MenuItem::with_id(app, "reset", "Bring pet back", true, None::<&str>)?;
    let feed = MenuItem::with_id(app, "feed", "Feed", true, None::<&str>)?;
    let yarn = MenuItem::with_id(app, "yarn", "Play with yarn", true, None::<&str>)?;
    let panel = MenuItem::with_id(app, "panel", "Focus timer & reminders…", true, None::<&str>)?;
    let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);
    let autostart = CheckMenuItem::with_id(app, "autostart", "Start with computer", true, autostart_on, None::<&str>)?;
    let breaks_on = app.state::<presence::Settings>().breaks.load(std::sync::atomic::Ordering::Relaxed);
    let breaks = CheckMenuItem::with_id(app, "breaks", "Break reminders", true, breaks_on, None::<&str>)?;
    let update = MenuItem::with_id(app, "update", updates::label(app), true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let sep3 = PredefinedMenuItem::separator(app)?;

    let sep4 = PredefinedMenuItem::separator(app)?;
    let mut items: Vec<&dyn IsMenuItem<Wry>> = vec![&nap, &feed, &yarn, &reset, &sep4, &panel, &sep1];
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
    state.yarn = Some(yarn);
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
    sound: bool,
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
    let sound_item = CheckMenuItem::with_id(&app, "sound", "Sound", true, sound, None::<&str>)?;

    // Only show the Color and Outfit menus when this pet has a choice to make.
    let mut extra: Vec<&dyn IsMenuItem<Wry>> = vec![&pet_menu];
    if colors.len() > 1 {
        extra.push(&color_menu);
    }
    if !outfits.is_empty() {
        extra.push(&outfit_menu);
    }
    let _ = &roam_item; // roaming is always on now, so the toggle is hidden
    extra.push(&sound_item);

    let state = TrayState {
        groups: vec![("pet", pet_items), ("color", color_items), ("outfit", outfit_items)],
        roam: Some(roam_item.clone()),
        sound: Some(sound_item.clone()),
        ..Default::default()
    };
    install_menu(&app, &extra, state)
}

/// "Play with yarn" turns into "Put yarn away" while the ball is out.
#[tauri::command]
fn set_yarn_out(state: State<Mutex<TrayState>>, out: bool) {
    let item = state.lock().unwrap().yarn.clone();
    if let Some(item) = item {
        let _ = item.set_text(if out { "Put yarn away" } else { "Play with yarn" });
    }
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
        "sound" => {
            let on = state.lock().unwrap().sound.as_ref().and_then(|i| i.is_checked().ok());
            if let Some(on) = on {
                let _ = app.emit("sound", on);
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
        "panel" => open_panel(app),
        _ => {
            let _ = app.emit("tray", id);
        }
    }
}

/// The small "Focus timer & reminders" window (src/panel.html). It talks to the
/// pet window with events, so all the state lives with the pet.
fn open_panel(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("panel") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    // Built off the main thread: creating a webview inside a menu handler can deadlock on Windows.
    let app = app.clone();
    std::thread::spawn(move || {
        let _ = tauri::WebviewWindowBuilder::new(&app, "panel", tauri::WebviewUrl::App("panel.html".into()))
            .title("Focus timer & reminders")
            .inner_size(380.0, 520.0)
            .resizable(false)
            .always_on_top(true)
            .center()
            .build();
    });
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
            set_yarn_out,
            hit::set_hitbox,
            hit::set_extra_hitboxes,
            hit::hold_cursor,
            perch::perch_target,
            perch::perch_track,
            presence::set_break_reminders
        ])
        .setup(|app| {
            // A desktop pet lives in the menu bar, not the Dock.
            #[cfg(target_os = "macos")]
            {
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_visible_on_all_workspaces(true);
                }
            }
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
            #[cfg(target_os = "linux")]
            fullscreen_linux::watch(app.handle().clone());
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
    const AWAY_AFTER: u64 = 5 * 60;
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

    /// Linux: from the X screensaver extension (X11 only; Wayland doesn't share it).
    #[cfg(target_os = "linux")]
    fn idle_seconds() -> Option<u64> {
        crate::x11::idle_seconds()
    }

    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
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
        /// More grabbable things besides the pet (the yarn ball), same units.
        extra: Mutex<Vec<[f64; 4]>>,
        /// Keep receiving the mouse while dragging, even if the cursor outruns the cat.
        hold: AtomicBool,
    }

    #[tauri::command]
    pub fn set_hitbox(hitbox: State<Hitbox>, x: f64, y: f64, w: f64, h: f64) {
        *hitbox.rect.lock().unwrap() = (x, y, w, h);
    }

    #[tauri::command]
    pub fn set_extra_hitboxes(hitbox: State<Hitbox>, rects: Vec<[f64; 4]>) {
        *hitbox.extra.lock().unwrap() = rects;
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
                let inside = |x: f64, y: f64, w: f64, h: f64| cursor.x >= x && cursor.x < x + w && cursor.y >= y && cursor.y < y + h;
                let over = inside(x, y, w, h) || hitbox.extra.lock().unwrap().iter().any(|r| inside(r[0], r[1], r[2], r[3]));
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

/// Lets the pet stand on top of other windows. The frontend asks for the
/// window you're using (`perch_target`), jumps onto its top edge, and then
/// keeps checking that same window (`perch_track`): if it moves, resizes,
/// closes or is minimized, the pet falls off. Only window positions are read,
/// never their contents or titles.
mod perch {
    #[derive(serde::Serialize)]
    pub struct Rect {
        id: f64,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        /// macOS reports points rather than pixels; the frontend scales them.
        logical: bool,
    }

    fn rect(id: u64, r: [f64; 4]) -> Rect {
        Rect { id: id as f64, x: r[0], y: r[1], w: r[2], h: r[3], logical: cfg!(target_os = "macos") }
    }

    /// The window you're using right now, if the pet could stand on it.
    #[tauri::command]
    pub fn perch_target() -> Option<Rect> {
        os::foreground().map(|(id, r)| rect(id, r))
    }

    /// Where that window is now, or nothing if it's gone, minimized or maximized.
    #[tauri::command]
    pub fn perch_track(id: f64) -> Option<Rect> {
        let id = id as u64;
        os::track(id).map(|r| rect(id, r))
    }

    #[cfg(windows)]
    mod os {
        use std::{ffi::c_void, mem};
        use windows_sys::Win32::{
            Foundation::{HWND, RECT},
            Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS},
            UI::WindowsAndMessaging::{
                GetClassNameW, GetForegroundWindow, GetWindowRect, GetWindowThreadProcessId, IsIconic, IsWindow,
                IsWindowVisible, IsZoomed,
            },
        };

        pub fn foreground() -> Option<(u64, [f64; 4])> {
            unsafe {
                let hwnd = GetForegroundWindow();
                if hwnd.is_null() {
                    return None;
                }
                let mut pid = 0u32;
                GetWindowThreadProcessId(hwnd, &mut pid);
                if pid == std::process::id() {
                    return None; // the pet's own window
                }
                // Not the desktop or the taskbar.
                let mut buf = [0u16; 64];
                let len = GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
                let class = String::from_utf16_lossy(&buf[..len.max(0) as usize]);
                if matches!(class.as_str(), "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd") {
                    return None;
                }
                let id = hwnd as usize as u64;
                track(id).map(|r| (id, r))
            }
        }

        pub fn track(id: u64) -> Option<[f64; 4]> {
            unsafe {
                let hwnd = id as usize as HWND;
                if IsWindow(hwnd) == 0 || IsWindowVisible(hwnd) == 0 || IsIconic(hwnd) != 0 || IsZoomed(hwnd) != 0 {
                    return None;
                }
                // Hidden on another virtual desktop.
                let mut cloaked = 0u32;
                let size = mem::size_of::<u32>() as u32;
                if DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED as _, &mut cloaked as *mut u32 as *mut c_void, size) == 0
                    && cloaked != 0
                {
                    return None;
                }
                // The visible frame, without the invisible resize borders.
                let mut r: RECT = mem::zeroed();
                let size = mem::size_of::<RECT>() as u32;
                let framed =
                    DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS as _, &mut r as *mut RECT as *mut c_void, size)
                        == 0;
                if !framed && GetWindowRect(hwnd, &mut r) == 0 {
                    return None;
                }
                Some([r.left as f64, r.top as f64, (r.right - r.left) as f64, (r.bottom - r.top) as f64])
            }
        }
    }

    #[cfg(target_os = "macos")]
    mod os {
        use std::ffi::c_void;

        type CFTypeRef = *const c_void;

        #[repr(C)]
        struct CGPoint {
            x: f64,
            y: f64,
        }
        #[repr(C)]
        struct CGSize {
            width: f64,
            height: f64,
        }
        #[repr(C)]
        struct CGRect {
            origin: CGPoint,
            size: CGSize,
        }

        #[link(name = "CoreGraphics", kind = "framework")]
        extern "C" {
            fn CGWindowListCopyWindowInfo(option: u32, relative_to: u32) -> CFTypeRef;
            fn CGRectMakeWithDictionaryRepresentation(dict: CFTypeRef, rect: *mut CGRect) -> bool;
            static kCGWindowLayer: CFTypeRef;
            static kCGWindowBounds: CFTypeRef;
            static kCGWindowOwnerPID: CFTypeRef;
            static kCGWindowNumber: CFTypeRef;
            static kCGWindowIsOnscreen: CFTypeRef;
        }

        #[link(name = "CoreFoundation", kind = "framework")]
        extern "C" {
            fn CFArrayGetCount(array: CFTypeRef) -> isize;
            fn CFArrayGetValueAtIndex(array: CFTypeRef, index: isize) -> CFTypeRef;
            fn CFDictionaryGetValue(dict: CFTypeRef, key: CFTypeRef) -> CFTypeRef;
            fn CFNumberGetValue(number: CFTypeRef, kind: isize, out: *mut c_void) -> bool;
            fn CFBooleanGetValue(boolean: CFTypeRef) -> bool;
            fn CFRelease(object: CFTypeRef);
        }

        const ON_SCREEN_ONLY: u32 = 1;
        const INCLUDING_WINDOW: u32 = 8;
        const EXCLUDE_DESKTOP: u32 = 16;
        const SINT64: isize = 4; // kCFNumberSInt64Type

        unsafe fn number(dict: CFTypeRef, key: CFTypeRef) -> Option<i64> {
            let value = CFDictionaryGetValue(dict, key);
            if value.is_null() {
                return None;
            }
            let mut out: i64 = 0;
            CFNumberGetValue(value, SINT64, &mut out as *mut i64 as *mut c_void);
            Some(out)
        }

        unsafe fn bounds(dict: CFTypeRef) -> Option<[f64; 4]> {
            let value = CFDictionaryGetValue(dict, kCGWindowBounds);
            if value.is_null() {
                return None;
            }
            let mut r = CGRect { origin: CGPoint { x: 0.0, y: 0.0 }, size: CGSize { width: 0.0, height: 0.0 } };
            if !CGRectMakeWithDictionaryRepresentation(value, &mut r) {
                return None;
            }
            Some([r.origin.x, r.origin.y, r.size.width, r.size.height])
        }

        /// Windows are listed front to back; the first normal one (layer 0) of
        /// another app is the one you're using.
        pub fn foreground() -> Option<(u64, [f64; 4])> {
            unsafe {
                let list = CGWindowListCopyWindowInfo(ON_SCREEN_ONLY | EXCLUDE_DESKTOP, 0);
                if list.is_null() {
                    return None;
                }
                let own = std::process::id() as i64;
                let mut found = None;
                for i in 0..CFArrayGetCount(list) {
                    let dict = CFArrayGetValueAtIndex(list, i);
                    if number(dict, kCGWindowLayer) != Some(0) || number(dict, kCGWindowOwnerPID) == Some(own) {
                        continue;
                    }
                    if let (Some(id), Some(r)) = (number(dict, kCGWindowNumber), bounds(dict)) {
                        if r[2] > 50.0 && r[3] > 50.0 {
                            found = Some((id as u64, r));
                            break;
                        }
                    }
                }
                CFRelease(list);
                found
            }
        }

        pub fn track(id: u64) -> Option<[f64; 4]> {
            unsafe {
                let list = CGWindowListCopyWindowInfo(INCLUDING_WINDOW, id as u32);
                if list.is_null() {
                    return None;
                }
                let mut found = None;
                if CFArrayGetCount(list) > 0 {
                    let dict = CFArrayGetValueAtIndex(list, 0);
                    let onscreen = CFDictionaryGetValue(dict, kCGWindowIsOnscreen);
                    if !onscreen.is_null() && CFBooleanGetValue(onscreen) {
                        found = bounds(dict);
                    }
                }
                CFRelease(list);
                found
            }
        }
    }

    #[cfg(target_os = "linux")]
    mod os {
        pub fn foreground() -> Option<(u64, [f64; 4])> {
            crate::x11::foreground()
        }
        pub fn track(id: u64) -> Option<[f64; 4]> {
            crate::x11::track(id)
        }
    }

    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    mod os {
        pub fn foreground() -> Option<(u64, [f64; 4])> {
            None
        }
        pub fn track(_id: u64) -> Option<[f64; 4]> {
            None
        }
    }
}

/// Linux (X11) helpers: the window you're using, how long you've been idle,
/// and whether a fullscreen app is in front. libX11 and libXss are loaded at
/// runtime, so a system without them (or a Wayland session, where apps can't
/// see each other's windows) simply goes without these features.
#[cfg(target_os = "linux")]
mod x11 {
    use std::ffi::{c_char, c_int, c_long, c_uint, c_ulong, c_void, CString};
    use std::sync::Mutex;

    type Display = c_void;
    type Window = c_ulong;
    type Atom = c_ulong;

    const XA_ATOM: Atom = 4;
    const XA_CARDINAL: Atom = 6;
    const XA_WINDOW: Atom = 33;
    const RTLD_NOW: c_int = 2;

    #[link(name = "dl")]
    extern "C" {
        fn dlopen(filename: *const c_char, flag: c_int) -> *mut c_void;
        fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
    }

    #[repr(C)]
    struct ScreenSaverInfo {
        window: Window,
        state: c_int,
        kind: c_int,
        til_or_since: c_ulong,
        idle: c_ulong,
        event_mask: c_ulong,
    }

    type GetProperty = unsafe extern "C" fn(
        *mut Display, Window, Atom, c_long, c_long, c_int, Atom,
        *mut Atom, *mut c_int, *mut c_ulong, *mut c_ulong, *mut *mut u8,
    ) -> c_int;
    type GetGeometry = unsafe extern "C" fn(
        *mut Display, Window, *mut Window, *mut c_int, *mut c_int,
        *mut c_uint, *mut c_uint, *mut c_uint, *mut c_uint,
    ) -> c_int;
    type Translate = unsafe extern "C" fn(
        *mut Display, Window, Window, c_int, c_int, *mut c_int, *mut c_int, *mut Window,
    ) -> c_int;

    struct X {
        display: *mut Display,
        root: Window,
        intern_atom: unsafe extern "C" fn(*mut Display, *const c_char, c_int) -> Atom,
        get_property: GetProperty,
        free: unsafe extern "C" fn(*mut c_void) -> c_int,
        get_geometry: GetGeometry,
        translate: Translate,
        idle_query: Option<unsafe extern "C" fn(*mut Display, Window, *mut ScreenSaverInfo) -> c_int>,
    }

    // Only ever used behind the mutex below.
    unsafe impl Send for X {}

    /// None: not tried yet. Some(None): not available here.
    static STATE: Mutex<Option<Option<X>>> = Mutex::new(None);

    unsafe fn library(names: &[&str]) -> *mut c_void {
        for name in names {
            let c = CString::new(*name).unwrap();
            let handle = dlopen(c.as_ptr(), RTLD_NOW);
            if !handle.is_null() {
                return handle;
            }
        }
        std::ptr::null_mut()
    }

    unsafe fn symbol<T: Copy>(lib: *mut c_void, name: &str) -> Option<T> {
        if lib.is_null() {
            return None;
        }
        let c = CString::new(name).ok()?;
        let p = dlsym(lib, c.as_ptr());
        if p.is_null() {
            None
        } else {
            Some(std::mem::transmute_copy::<*mut c_void, T>(&p))
        }
    }

    fn connect() -> Option<X> {
        // On Wayland the X server only knows about X11 apps, so its answers would be wrong.
        let wayland = std::env::var("XDG_SESSION_TYPE").map_or(false, |s| s.eq_ignore_ascii_case("wayland"))
            || std::env::var_os("WAYLAND_DISPLAY").is_some();
        if wayland {
            return None;
        }
        unsafe {
            let lib = library(&["libX11.so.6", "libX11.so"]);
            let open: unsafe extern "C" fn(*const c_char) -> *mut Display = symbol(lib, "XOpenDisplay")?;
            let default_root: unsafe extern "C" fn(*mut Display) -> Window = symbol(lib, "XDefaultRootWindow")?;
            let display = open(std::ptr::null());
            if display.is_null() {
                return None;
            }
            let xss = library(&["libXss.so.1", "libXss.so"]);
            Some(X {
                display,
                root: default_root(display),
                intern_atom: symbol(lib, "XInternAtom")?,
                get_property: symbol(lib, "XGetWindowProperty")?,
                free: symbol(lib, "XFree")?,
                get_geometry: symbol(lib, "XGetGeometry")?,
                translate: symbol(lib, "XTranslateCoordinates")?,
                idle_query: symbol(xss, "XScreenSaverQueryInfo"),
            })
        }
    }

    fn with<R>(f: impl FnOnce(&X) -> Option<R>) -> Option<R> {
        let mut x = STATE.lock().ok()?;
        if x.is_none() {
            *x = Some(connect());
        }
        x.as_ref()?.as_ref().and_then(f)
    }

    impl X {
        unsafe fn atom(&self, name: &str) -> Atom {
            let c = CString::new(name).unwrap();
            (self.intern_atom)(self.display, c.as_ptr(), 0)
        }

        /// A 32-bit list property (X hands those back as C longs).
        unsafe fn list(&self, window: Window, name: &str, kind: Atom, max: c_long) -> Vec<c_ulong> {
            let mut actual: Atom = 0;
            let mut format: c_int = 0;
            let mut count: c_ulong = 0;
            let mut after: c_ulong = 0;
            let mut data: *mut u8 = std::ptr::null_mut();
            let status = (self.get_property)(
                self.display, window, self.atom(name), 0, max, 0, kind,
                &mut actual, &mut format, &mut count, &mut after, &mut data,
            );
            let mut out = Vec::new();
            if status == 0 && !data.is_null() && format == 32 {
                out.extend_from_slice(std::slice::from_raw_parts(data as *const c_ulong, count as usize));
            }
            if !data.is_null() {
                (self.free)(data as *mut c_void);
            }
            out
        }

        /// Only ask about windows the window manager lists, so X never errors on a closed one.
        unsafe fn exists(&self, window: Window) -> bool {
            self.list(self.root, "_NET_CLIENT_LIST", XA_WINDOW, 4096).contains(&window)
        }

        unsafe fn has_state(&self, window: Window, names: &[&str]) -> bool {
            let states = self.list(window, "_NET_WM_STATE", XA_ATOM, 64);
            names.iter().any(|n| states.contains(&self.atom(n)))
        }

        unsafe fn active(&self) -> Option<Window> {
            let window = *self.list(self.root, "_NET_ACTIVE_WINDOW", XA_WINDOW, 1).first()?;
            if window == 0 || !self.exists(window) {
                return None;
            }
            let pid = self.list(window, "_NET_WM_PID", XA_CARDINAL, 1);
            if pid.first().map_or(false, |&p| p as u32 == std::process::id()) {
                return None; // the pet's own window
            }
            Some(window)
        }

        /// The window's visible frame (title bar included) on screen.
        unsafe fn frame(&self, window: Window) -> Option<[f64; 4]> {
            let (mut root, mut x, mut y, mut w, mut h, mut border, mut depth): (Window, c_int, c_int, c_uint, c_uint, c_uint, c_uint) =
                (0, 0, 0, 0, 0, 0, 0);
            if (self.get_geometry)(self.display, window, &mut root, &mut x, &mut y, &mut w, &mut h, &mut border, &mut depth) == 0 {
                return None;
            }
            let (mut sx, mut sy, mut child): (c_int, c_int, Window) = (0, 0, 0);
            (self.translate)(self.display, window, self.root, 0, 0, &mut sx, &mut sy, &mut child);
            let (mut l, mut t, mut wd, mut ht) = (sx as f64, sy as f64, w as f64, h as f64);
            // GTK apps draw their own shadow inside the window: leave it out.
            let gtk = self.list(window, "_GTK_FRAME_EXTENTS", XA_CARDINAL, 4);
            if gtk.len() == 4 {
                l += gtk[0] as f64;
                wd -= (gtk[0] + gtk[1]) as f64;
                t += gtk[2] as f64;
                ht -= (gtk[2] + gtk[3]) as f64;
            }
            // The window manager's title bar and borders: include them.
            let frame = self.list(window, "_NET_FRAME_EXTENTS", XA_CARDINAL, 4);
            if frame.len() == 4 {
                l -= frame[0] as f64;
                wd += (frame[0] + frame[1]) as f64;
                t -= frame[2] as f64;
                ht += (frame[2] + frame[3]) as f64;
            }
            Some([l, t, wd, ht])
        }

        unsafe fn standable(&self, window: Window) -> bool {
            let hidden = ["_NET_WM_STATE_HIDDEN", "_NET_WM_STATE_FULLSCREEN", "_NET_WM_STATE_MAXIMIZED_VERT"];
            if self.has_state(window, &hidden) {
                return false;
            }
            let types = self.list(window, "_NET_WM_WINDOW_TYPE", XA_ATOM, 8);
            let skip = [self.atom("_NET_WM_WINDOW_TYPE_DESKTOP"), self.atom("_NET_WM_WINDOW_TYPE_DOCK")];
            !types.iter().any(|t| skip.contains(t))
        }
    }

    pub fn foreground() -> Option<(u64, [f64; 4])> {
        with(|x| unsafe {
            let window = x.active()?;
            if !x.standable(window) {
                return None;
            }
            Some((window as u64, x.frame(window)?))
        })
    }

    pub fn track(id: u64) -> Option<[f64; 4]> {
        with(|x| unsafe {
            let window = id as Window;
            if !x.exists(window) || !x.standable(window) {
                return None;
            }
            x.frame(window)
        })
    }

    pub fn idle_seconds() -> Option<u64> {
        with(|x| unsafe {
            let query = x.idle_query?;
            let mut info: ScreenSaverInfo = std::mem::zeroed();
            if query(x.display, x.root, &mut info) == 0 {
                return None;
            }
            Some((info.idle / 1000) as u64)
        })
    }

    pub fn fullscreen_in_front() -> bool {
        with(|x| unsafe {
            let window = x.active()?;
            Some(x.has_state(window, &["_NET_WM_STATE_FULLSCREEN"]))
        })
        .unwrap_or(false)
    }
}

/// Linux version of `fullscreen`: hides the pet while a fullscreen app is in front (X11).
#[cfg(target_os = "linux")]
mod fullscreen_linux {
    use std::{thread, time::Duration};
    use tauri::{AppHandle, Emitter, Manager};

    pub fn watch(app: AppHandle) {
        thread::spawn(move || {
            let mut last = false;
            loop {
                thread::sleep(Duration::from_millis(1500));
                let fullscreen = crate::x11::fullscreen_in_front();
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
