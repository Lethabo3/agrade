#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use screenshots::Screen;
use std::io::Cursor;
use std::path::PathBuf;
use std::process::Command;
use std::thread;
use std::time::Duration;
use image::ImageEncoder;
use tauri::Emitter;
use tauri::Manager;
use image::codecs::png::PngEncoder;
use base64::{Engine as _, engine::general_purpose};
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::HWND;
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::COLORREF;
#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowLongW, SetWindowLongW, SetWindowDisplayAffinity,
    GWL_EXSTYLE, WS_EX_LAYERED, WS_EX_TRANSPARENT, WDA_EXCLUDEFROMCAPTURE,
    SetWindowPos, HWND_TOPMOST, SWP_NOSIZE,
    SetLayeredWindowAttributes, LWA_ALPHA,
};
#[cfg(target_os = "windows")]
use windows::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, GetMonitorInfoW, MONITORINFO, HDC, HMONITOR, HRGN,
};
#[cfg(target_os = "windows")]
use windows::Win32::Graphics::Dwm::{
    DwmEnableBlurBehindWindow, DWM_BLURBEHIND,
};
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::{BOOL, LPARAM, RECT};

#[cfg(target_os = "windows")]
fn apply_stealth_flags(hwnd: HWND) -> windows::core::Result<()> {
    unsafe {
        let current_style = GetWindowLongW(hwnd, GWL_EXSTYLE);
        SetWindowLongW(
            hwnd,
            GWL_EXSTYLE,
            current_style | WS_EX_LAYERED.0 as i32,
        );
        SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)?;

        let blur = DWM_BLURBEHIND {
            dwFlags: 0x00000001,
            fEnable: true.into(),
            hRgnBlur: HRGN(std::ptr::null_mut()),
            fTransitionOnMaximized: false.into(),
        };
        DwmEnableBlurBehindWindow(hwnd, &blur)?;
    }
    Ok(())
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn monitor_enum_proc(
    hmonitor: HMONITOR,
    _hdc: HDC,
    _rect: *mut RECT,
    lparam: LPARAM,
) -> BOOL {
    let monitors = &mut *(lparam.0 as *mut Vec<HMONITOR>);
    monitors.push(hmonitor);
    BOOL(1)
}

#[cfg(target_os = "windows")]
fn get_secondary_monitor_position() -> Option<(i32, i32)> {
    unsafe {
        let mut monitors: Vec<HMONITOR> = Vec::new();
        EnumDisplayMonitors(
            HDC::default(),
            None,
            Some(monitor_enum_proc),
            LPARAM(&mut monitors as *mut Vec<HMONITOR> as isize),
        );

        if monitors.len() < 2 {
            return None;
        }

        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };

        for monitor in &monitors[1..] {
            if GetMonitorInfoW(*monitor, &mut info).as_bool() {
                return Some((info.rcWork.left, info.rcWork.top));
            }
        }
        None
    }
}

fn install_virtual_display(resource_dir: PathBuf) {
    let drivers_dir = resource_dir.join("drivers");
    let cert = drivers_dir.join("iddsampledriver.cer");
    let inf = drivers_dir.join("iddsampledriver.inf");

    if !cert.exists() || !inf.exists() {
        return;
    }

    Command::new("certutil")
        .args(["-addstore", "-f", "root", cert.to_str().unwrap()])
        .output()
        .ok();

    Command::new("certutil")
        .args(["-addstore", "-f", "TrustedPublisher", cert.to_str().unwrap()])
        .output()
        .ok();

    Command::new("pnputil")
        .args(["/add-driver", inf.to_str().unwrap(), "/install"])
        .output()
        .ok();
}

#[tauri::command]
fn capture_screen() -> String {
    let screens = match Screen::all() {
        Ok(s) => s,
        Err(e) => return format!("Screen capture failed: {}", e),
    };
    let screen = &screens[0];
    let image = screen.capture().unwrap();
    let mut bytes: Vec<u8> = Vec::new();
    PngEncoder::new(Cursor::new(&mut bytes))
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            image::ColorType::Rgba8.into(),
        )
        .unwrap();
    general_purpose::STANDARD.encode(&bytes)
}

#[tauri::command]
fn reapply_stealth(window: tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let hwnd = HWND(window.hwnd().unwrap().0 as *mut core::ffi::c_void);
        apply_stealth_flags(hwnd).map_err(|e| e.to_string())?;
        thread::sleep(Duration::from_millis(50));
        apply_stealth_flags(hwnd).map_err(|e| e.to_string())?;
        thread::sleep(Duration::from_millis(100));
        apply_stealth_flags(hwnd).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn hide_window(window: tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    unsafe {
        let hwnd = HWND(window.hwnd().unwrap().0 as *mut core::ffi::c_void);
        let style = GetWindowLongW(hwnd, GWL_EXSTYLE);
        SetWindowLongW(
            hwnd,
            GWL_EXSTYLE,
            style | WS_EX_TRANSPARENT.0 as i32 | WS_EX_LAYERED.0 as i32,
        );
        SetLayeredWindowAttributes(
            hwnd,
            COLORREF(0),
            0,
            LWA_ALPHA,
        ).ok();
    }
    Ok(())
}

#[tauri::command]
fn show_window(window: tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    unsafe {
        let hwnd = HWND(window.hwnd().unwrap().0 as *mut core::ffi::c_void);
        let style = GetWindowLongW(hwnd, GWL_EXSTYLE);
        SetWindowLongW(
            hwnd,
            GWL_EXSTYLE,
            (style & !(WS_EX_TRANSPARENT.0 as i32)) | WS_EX_LAYERED.0 as i32,
        );
        SetLayeredWindowAttributes(
            hwnd,
            COLORREF(0),
            255,
            LWA_ALPHA,
        ).ok();
        apply_stealth_flags(hwnd).ok();
    }
    Ok(())
}

#[tauri::command]
fn find_option_positions(base64_image: String, max_options: usize) -> Vec<(f64, f64)> {
    use image::{GenericImageView, Rgba};

    let bytes = match general_purpose::STANDARD.decode(&base64_image) {
        Ok(b) => b,
        Err(_) => return vec![],
    };

    let img = match image::load_from_memory(&bytes) {
        Ok(i) => i,
        Err(_) => return vec![],
    };

    let (width, height) = img.dimensions();
    let mut found: Vec<(f64, f64)> = Vec::new();

    let scan_width = (width as f32 * 0.20) as u32;
    let min_y = (height as f32 * 0.10) as u32;
    let max_y = (height as f32 * 0.92) as u32;

    let mut last_found_y: i32 = -60;

    for y in min_y..max_y {
        for x in 4..scan_width {
            let pixel = img.get_pixel(x, y);
            let Rgba([r, g, b, _]) = pixel;

            let is_dark_border =
                (r as u16 + g as u16 + b as u16) < 200 && r < 120 && g < 120 && b < 120;
            if !is_dark_border {
                continue;
            }

            if x + 4 >= width {
                continue;
            }
            let inner = img.get_pixel(x + 4, y);
            let Rgba([ir, ig, ib, _]) = inner;
            let is_light_inner = (ir as u16 + ig as u16 + ib as u16) > 450;
            if !is_light_inner {
                continue;
            }

            let iy = y as i32;
            if iy - last_found_y < 30 {
                continue;
            }

            last_found_y = iy;
            let nx = (x as f64 + 8.0) / width as f64;
            let ny = y as f64 / height as f64;
            found.push((nx, ny));

            if found.len() >= max_options {
                return found;
            }
            break;
        }
    }

    found
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(url) = argv.iter().find(|a| a.starts_with("agrade://")) {
                app.emit("deep-link-received", url.to_string()).unwrap();
            }
            let win = app.get_webview_window("main").unwrap();
            win.show().unwrap();
            win.set_focus().unwrap();
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            capture_screen,
            reapply_stealth,
            hide_window,
            show_window,
            find_option_positions
        ])
        .setup(|app| {
            let resource_dir = app.path().resource_dir().unwrap();
            install_virtual_display(resource_dir);

            #[cfg(target_os = "windows")]
            {
                use tauri::Manager;
                let main_window = app.get_webview_window("main").unwrap();
                main_window.set_always_on_top(true).unwrap();

                let hwnd = HWND(main_window.hwnd().unwrap().0 as *mut core::ffi::c_void);
                apply_stealth_flags(hwnd).expect("Failed to apply stealth flags");

                if let Some((x, y)) = get_secondary_monitor_position() {
                    unsafe {
                        SetWindowPos(
                            hwnd,
                            HWND_TOPMOST,
                            x + 20,
                            y + 20,
                            0,
                            0,
                            SWP_NOSIZE,
                        ).ok();
                    }
                }
            }
            #[cfg(desktop)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                app.deep_link().register("agrade").unwrap();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
