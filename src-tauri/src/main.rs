#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use screenshots::Screen;
use std::io::Cursor;
use std::path::PathBuf;
use std::process::Command;
use image::ImageEncoder;
use tauri::Emitter;
use tauri::Manager;
use image::codecs::png::PngEncoder;
use base64::{Engine as _, engine::general_purpose};
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::HWND;
#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowLongW, SetWindowLongW, SetWindowDisplayAffinity,
    GWL_EXSTYLE, WS_EX_LAYERED, WDA_EXCLUDEFROMCAPTURE,
    SetWindowPos, HWND_TOPMOST, SWP_NOSIZE,
};
#[cfg(target_os = "windows")]
use windows::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, GetMonitorInfoW, MONITORINFO, HDC, HMONITOR, HRGN,
};
#[cfg(target_os = "windows")]
use windows::Win32::Graphics::Dwm::{
    DwmExtendFrameIntoClientArea, DwmEnableBlurBehindWindow,
    DWM_BLURBEHIND,
};
#[cfg(target_os = "windows")]
use windows::Win32::UI::Controls::MARGINS;
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

        let margins = MARGINS {
            cxLeftWidth: -1,
            cxRightWidth: -1,
            cyTopHeight: -1,
            cyBottomHeight: -1,
        };
        DwmExtendFrameIntoClientArea(hwnd, &margins)?;

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
    }
    Ok(())
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
        .invoke_handler(tauri::generate_handler![capture_screen, reapply_stealth])
        .setup(|app| {
            let resource_dir = app.path().resource_dir().unwrap();
            install_virtual_display(resource_dir);

            #[cfg(target_os = "windows")]
            {
                use tauri::Manager;
                let main_window = app.get_webview_window("main").unwrap();
                main_window.set_always_on_top(true).unwrap();
                main_window.set_background_color(Some(tauri::Color(0, 0, 0, 0))).ok();

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
