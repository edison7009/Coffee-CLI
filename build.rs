fn main() {
    println!("cargo:rerun-if-changed=ui");

    tauri_build::build();
    // Apple speech belongs to voice input, one of the Pro modules.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") && std::env::var_os("CARGO_FEATURE_PRO").is_some() {
        println!("cargo:rerun-if-changed=pro/src/voice_input/apple_speech.m");
        cc::Build::new()
            .file("pro/src/voice_input/apple_speech.m")
            .flag("-fobjc-arc")
            .flag("-fblocks")
            .compile("coffee_apple_speech");
        println!("cargo:rustc-link-lib=framework=Foundation");
        println!("cargo:rustc-link-lib=framework=AVFoundation");
        println!("cargo:rustc-link-lib=objc");
        // Speech is available from macOS 10.15; older supported Macs keep other channels.
        println!("cargo:rustc-link-arg=-Wl,-weak_framework,Speech");
    }
}
