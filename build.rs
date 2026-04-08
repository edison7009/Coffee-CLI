use std::path::Path;

fn main() {
    println!("cargo:rerun-if-changed=ui");
    println!("cargo:rerun-if-changed=binaries");

    // Auto-copy coffeecode sidecar binary to the output directory
    // so it sits next to coffee-cli.exe at runtime.
    // ONLY in release builds — in debug, we run from source via bun
    // so that code changes in .opencode-upstream take effect immediately.
    let profile = std::env::var("PROFILE").unwrap_or_default();
    if profile == "release" {
        let out_dir = std::env::var("OUT_DIR").unwrap_or_default();
        if let Some(target_dir) = Path::new(&out_dir)
            .ancestors()
            .find(|p| p.file_name().map(|n| n == "debug" || n == "release").unwrap_or(false))
        {
            let sidecar_name = if cfg!(target_os = "windows") {
                "coffeecode.exe"
            } else {
                "coffeecode"
            };
            let src = Path::new("binaries").join(sidecar_name);
            let dst = target_dir.join(sidecar_name);
            if src.exists() && (!dst.exists() || file_modified(&src) > file_modified(&dst)) {
                println!("cargo:warning=Copying CoffeeCode sidecar to {:?}", dst);
                let _ = std::fs::copy(&src, &dst);
            }
        }
    }

    tauri_build::build()
}

fn file_modified(path: &Path) -> std::time::SystemTime {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
}
