// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Omarchy runs Hyprland (Wayland). WebKitGTK's accelerated/DMABUF path is
    // broken under several Wayland compositors and renders a blank white window;
    // disabling it forces the software-composited path (harmless on X11). Set
    // before the WebView is created, and only if the user hasn't overridden it.
    for key in ["WEBKIT_DISABLE_DMABUF_RENDERER", "WEBKIT_DISABLE_COMPOSITING_MODE"] {
        if std::env::var_os(key).is_none() {
            std::env::set_var(key, "1");
        }
    }

    vingsforge_lib::run()
}
