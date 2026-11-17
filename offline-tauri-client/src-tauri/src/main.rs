// Prevents console window on Windows
#![windows_subsystem = "windows"]

fn main() {
    std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--ignore-certificate-errors");
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
