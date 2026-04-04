fn main() {
    println!("cargo:rerun-if-changed=ui");
    tauri_build::build()
}
