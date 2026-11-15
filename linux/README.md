# Linux desktop entry

`main.desktop` is the Tauri bundler's own desktop-entry template (deb and rpm,
see `bundle.linux` in `tauri.conf.json`) with one change: `Exec=… %u`.

Without a field code, GNOME / GLib hands an app only local file paths, so a
clicked `coffeecli://` prompt link (src/launch.rs) would start or focus Coffee
CLI but never reach it. `%u` passes the link as argv, where `main.rs` and the
single-instance callback read it.
