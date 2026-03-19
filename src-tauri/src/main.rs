#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use screenshots::Screen;
use std::io::Cursor;
use std::io::Write;
use std::fs::OpenOptions;
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
};

fn log(msg: &str) {
    let path = "C:\\Users\\Lenovo\\Desktop\\agrade_debug.log".to_string();
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .unwrap();
    writeln!(file, "{}", msg).unwrap();
}

#[cfg(target_os = "windows")]
fn apply_stealth_flags(hwnd: HWND) -> windows::core::Result<()> {
    unsafe {
        log("Applying stealth flags...");
        let current_style = GetWindowLongW(hwnd, GWL_EXSTYLE);
        SetWindowLongW(
            hwnd,
            GWL_EXSTYLE,
            current_style | WS_EX_LAYERED.0 as i32,
        );
        SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)?;
        log("Stealth flags applied successfully");
    }
    Ok(())
}

#[tauri::command]
fn capture_screen() -> String {
    log("capture_screen called");
    let screens = match Screen::all() {
        Ok(s) => s,
        Err(e) => return format!("Screen capture failed: {}", e),
    };
    let screen = &screens[0];
    let image = screen.capture().unwrap();
    log(&format!("Captured {}x{}", image.width(), image.height()));
    let mut bytes: Vec<u8> = Vec::new();
    PngEncoder::new(Cursor::new(&mut bytes))
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            image::ColorType::Rgba8.into(),
        )
        .unwrap();
    let base64 = general_purpose::STANDARD.encode(&bytes);
    log(&format!("Base64 length: {}", base64.len()));
    base64
}

fn main() {
    log("App starting...");
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
        .invoke_handler(tauri::generate_handler![capture_screen])
        .setup(|app| {
            log("Setup running...");
            #[cfg(target_os = "windows")]
            {
                use tauri::Manager;
                let main_window = app.get_webview_window("main").unwrap();
                main_window.set_always_on_top(true).unwrap();
                main_window.open_devtools();
                let hwnd = HWND(main_window.hwnd().unwrap().0 as *mut core::ffi::c_void);
                apply_stealth_flags(hwnd).expect("Failed to apply stealth flags");
            }
            #[cfg(desktop)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                app.deep_link().register("agrade").unwrap();
            }
            log("Setup complete");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
