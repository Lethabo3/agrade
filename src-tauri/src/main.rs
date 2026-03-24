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
    GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN,
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
use windows::Win32::Foundation::{BOOL, LPARAM, RECT, POINT};
#[cfg(target_os = "windows")]
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_MOUSE, INPUT_KEYBOARD,
    MOUSEINPUT, KEYBDINPUT, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_MOVE,
    MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, KEYEVENTF_KEYUP,
    VIRTUAL_KEY, MOUSEEVENTF_WHEEL,
};
#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

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
        if monitors.len() < 2 { return None; }
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
    if !cert.exists() || !inf.exists() { return; }
    Command::new("certutil").args(["-addstore", "-f", "root", cert.to_str().unwrap()]).output().ok();
    Command::new("certutil").args(["-addstore", "-f", "TrustedPublisher", cert.to_str().unwrap()]).output().ok();
    Command::new("pnputil").args(["/add-driver", inf.to_str().unwrap(), "/install"]).output().ok();
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
        .write_image(image.as_raw(), image.width(), image.height(), image::ColorType::Rgba8.into())
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
        SetWindowLongW(hwnd, GWL_EXSTYLE, style | WS_EX_TRANSPARENT.0 as i32 | WS_EX_LAYERED.0 as i32);
        SetLayeredWindowAttributes(hwnd, COLORREF(0), 0, LWA_ALPHA).ok();
    }
    Ok(())
}

#[tauri::command]
fn show_window(window: tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    unsafe {
        let hwnd = HWND(window.hwnd().unwrap().0 as *mut core::ffi::c_void);
        let style = GetWindowLongW(hwnd, GWL_EXSTYLE);
        SetWindowLongW(hwnd, GWL_EXSTYLE, (style & !(WS_EX_TRANSPARENT.0 as i32)) | WS_EX_LAYERED.0 as i32);
        SetLayeredWindowAttributes(hwnd, COLORREF(0), 255, LWA_ALPHA).ok();
        apply_stealth_flags(hwnd).ok();
    }
    Ok(())
}

#[tauri::command]
fn get_screen_size() -> (i32, i32) {
    #[cfg(target_os = "windows")]
    unsafe {
        return (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN));
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(screens) = Screen::all() {
            if let Some(s) = screens.first() {
                let info = s.display_info;
                return (info.width as i32, info.height as i32);
            }
        }
        (1920, 1080)
    }
}

#[tauri::command]
fn click_at(x: f64, y: f64) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    unsafe {
        let screen_w = GetSystemMetrics(SM_CXSCREEN) as f64;
        let screen_h = GetSystemMetrics(SM_CYSCREEN) as f64;
        let target_x = (x * screen_w) as i32;
        let target_y = (y * screen_h) as i32;

        let mut cursor = POINT { x: 0, y: 0 };
        GetCursorPos(&mut cursor).ok();

        let steps = 28;
        for i in 1..=steps {
            let t = i as f64 / steps as f64;
            let ease = if t < 0.5 {
                2.0 * t * t
            } else {
                1.0 - (-2.0 * t + 2.0).powi(2) / 2.0
            };
            let mx = (cursor.x as f64 + (target_x as f64 - cursor.x as f64) * ease) as i32;
            let my = (cursor.y as f64 + (target_y as f64 - cursor.y as f64) * ease) as i32;
            let abs_x = ((mx as f64 / screen_w) * 65535.0) as i32;
            let abs_y = ((my as f64 / screen_h) * 65535.0) as i32;
            let input = INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 {
                    mi: MOUSEINPUT {
                        dx: abs_x,
                        dy: abs_y,
                        mouseData: 0,
                        dwFlags: MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            };
            SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
            thread::sleep(Duration::from_millis(8));
        }

        let abs_x = ((target_x as f64 / screen_w) * 65535.0) as i32;
        let abs_y = ((target_y as f64 / screen_h) * 65535.0) as i32;
        let clicks = [
            INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 {
                    mi: MOUSEINPUT {
                        dx: abs_x, dy: abs_y, mouseData: 0,
                        dwFlags: MOUSEEVENTF_LEFTDOWN | MOUSEEVENTF_ABSOLUTE,
                        time: 0, dwExtraInfo: 0,
                    },
                },
            },
            INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 {
                    mi: MOUSEINPUT {
                        dx: abs_x, dy: abs_y, mouseData: 0,
                        dwFlags: MOUSEEVENTF_LEFTUP | MOUSEEVENTF_ABSOLUTE,
                        time: 0, dwExtraInfo: 0,
                    },
                },
            },
        ];
        if SendInput(&clicks, std::mem::size_of::<INPUT>() as i32) == 0 {
            return Err("SendInput click failed".to_string());
        }
    }
    Ok(())
}

#[tauri::command]
fn scroll_down(amount: i32) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    unsafe {
        let input = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx: 0,
                    dy: 0,
                    mouseData: ((-120_i32).wrapping_mul(amount)) as u32,
                    dwFlags: MOUSEEVENTF_WHEEL,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        if SendInput(&[input], std::mem::size_of::<INPUT>() as i32) == 0 {
            return Err("SendInput scroll failed".to_string());
        }
    }
    Ok(())
}

#[tauri::command]
fn type_text(text: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    unsafe {
        use windows::Win32::UI::Input::KeyboardAndMouse::KEYEVENTF_UNICODE;
        let mut inputs: Vec<INPUT> = Vec::new();
        for ch in text.encode_utf16() {
            inputs.push(INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(0), wScan: ch, dwFlags: KEYEVENTF_UNICODE, time: 0, dwExtraInfo: 0 } },
            });
            inputs.push(INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(0), wScan: ch, dwFlags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, time: 0, dwExtraInfo: 0 } },
            });
        }
        if inputs.is_empty() { return Ok(()); }
        if SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) == 0 {
            return Err("SendInput (keyboard) failed".to_string());
        }
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

    let scan_x_max = (width as f32 * 0.12) as u32;
    let scan_y_min = (height as f32 * 0.20) as u32;
    let scan_y_max = (height as f32 * 0.85) as u32;
    let mut last_found_y: i32 = -50;

    // Pass 1: medium-grey border
    for y in scan_y_min..scan_y_max {
        if (y as i32) - last_found_y < 40 { continue; }
        for x in 4..scan_x_max {
            let Rgba([r, g, b, a]) = img.get_pixel(x, y);
            if a < 200 { continue; }
            let brightness = r as u32 + g as u32 + b as u32;
            let is_grey_border = brightness > 390 && brightness < 630
                && (r as i32 - b as i32).abs() < 35
                && (r as i32 - g as i32).abs() < 35
                && r > 120 && r < 220;
            if !is_grey_border { continue; }
            let check_x = x + 6;
            if check_x >= width { continue; }
            let Rgba([cr, cg, cb, _]) = img.get_pixel(check_x, y);
            if (cr as u32 + cg as u32 + cb as u32) < 600 { continue; }
            if y < 4 || y + 4 >= height { continue; }
            let Rgba([ar, ag, ab, _]) = img.get_pixel(check_x, y - 4);
            let Rgba([br2, bg2, bb2, _]) = img.get_pixel(check_x, y + 4);
            if (ar as u32 + ag as u32 + ab as u32) < 500 { continue; }
            if (br2 as u32 + bg2 as u32 + bb2 as u32) < 500 { continue; }
            last_found_y = y as i32;
            found.push((x as f64 / width as f64, y as f64 / height as f64));
            if found.len() >= max_options { return found; }
            break;
        }
    }

    // Pass 2: dark border fallback
    if found.is_empty() {
        last_found_y = -50;
        for y in scan_y_min..scan_y_max {
            if (y as i32) - last_found_y < 40 { continue; }
            for x in 4..scan_x_max {
                let Rgba([r, g, b, a]) = img.get_pixel(x, y);
                if a < 200 { continue; }
                let brightness = r as u32 + g as u32 + b as u32;
                if brightness < 80 || brightness > 300 { continue; }
                if (r as i32 - b as i32).abs() > 40 { continue; }
                let check_x = x + 5;
                if check_x >= width { continue; }
                let Rgba([cr, cg, cb, _]) = img.get_pixel(check_x, y);
                if (cr as u32 + cg as u32 + cb as u32) < 550 { continue; }
                last_found_y = y as i32;
                found.push((x as f64 / width as f64, y as f64 / height as f64));
                if found.len() >= max_options { return found; }
                break;
            }
        }
    }

    // Pass 3: wider scan
    if found.is_empty() {
        let scan_x_max_wide = (width as f32 * 0.25) as u32;
        last_found_y = -50;
        for y in scan_y_min..scan_y_max {
            if (y as i32) - last_found_y < 40 { continue; }
            for x in 4..scan_x_max_wide {
                let Rgba([r, g, b, a]) = img.get_pixel(x, y);
                if a < 200 { continue; }
                let brightness = r as u32 + g as u32 + b as u32;
                if brightness < 300 || brightness > 700 { continue; }
                if (r as i32 - b as i32).abs() > 50 { continue; }
                let check_x = x + 6;
                if check_x >= width { continue; }
                let Rgba([cr, cg, cb, _]) = img.get_pixel(check_x, y);
                if (cr as u32 + cg as u32 + cb as u32) < 550 { continue; }
                if y < 4 || y + 4 >= height { continue; }
                let Rgba([ar, ag, ab, _]) = img.get_pixel(check_x, y - 4);
                let Rgba([br2, bg2, bb2, _]) = img.get_pixel(check_x, y + 4);
                if (ar as u32 + ag as u32 + ab as u32) < 480 { continue; }
                if (br2 as u32 + bg2 as u32 + bb2 as u32) < 480 { continue; }
                last_found_y = y as i32;
                found.push((x as f64 / width as f64, y as f64 / height as f64));
                if found.len() >= max_options { return found; }
                break;
            }
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
            click_at,
            type_text,
            get_screen_size,
            find_option_positions,
            scroll_down,
        ])
        .setup(|app| {
            let resource_dir = app.path().resource_dir().unwrap();
            install_virtual_display(resource_dir);
            #[cfg(target_os = "windows")]
            {
                let main_window = app.get_webview_window("main").unwrap();
                main_window.set_always_on_top(true).unwrap();
                let hwnd = HWND(main_window.hwnd().unwrap().0 as *mut core::ffi::c_void);
                apply_stealth_flags(hwnd).expect("Failed to apply stealth flags");
                if let Some((x, y)) = get_secondary_monitor_position() {
                    unsafe {
                        SetWindowPos(hwnd, HWND_TOPMOST, x + 20, y + 20, 0, 0, SWP_NOSIZE).ok();
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
