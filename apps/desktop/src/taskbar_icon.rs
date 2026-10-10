//! Windows uses ICON_BIG for the taskbar. Tao sets only ICON_SMALL by default,
//! which makes Explorer enlarge the title-bar image when ICON_BIG is absent.

#[cfg(target_os = "windows")]
pub fn apply(window: &tauri::WebviewWindow) {
    use std::ffi::c_void;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetModuleHandleW(name: *const u16) -> *mut c_void;
    }
    #[link(name = "user32")]
    unsafe extern "system" {
        fn LoadImageW(
            instance: *mut c_void,
            name: *const u16,
            image_type: u32,
            width: i32,
            height: i32,
            flags: u32,
        ) -> *mut c_void;
        fn SendMessageW(hwnd: *mut c_void, message: u32, wparam: usize, lparam: isize) -> isize;
    }

    let Ok(hwnd) = window.hwnd() else { return };
    // Tauri embeds bundle.icon as resource 32512. LR_SHARED gives this handle
    // process lifetime (do not destroy it). Use the full-resolution frame so
    // taskbar/DPI changes never upscale the 16px title-bar image.
    unsafe {
        let icon = LoadImageW(
            GetModuleHandleW(std::ptr::null()),
            32512usize as *const u16,
            1, // IMAGE_ICON
            256,
            256,
            0x8000, // LR_SHARED
        );
        if icon.is_null() {
            eprintln!(
                "[coomi-desktop] could not load taskbar icon: {}",
                std::io::Error::last_os_error()
            );
            return;
        }
        SendMessageW(hwnd.0, 0x80, 1, icon as isize); // WM_SETICON, ICON_BIG
    }
}

#[cfg(not(target_os = "windows"))]
pub fn apply(_window: &tauri::WebviewWindow) {}
