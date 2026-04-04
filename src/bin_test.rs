// Precise test: portable-pty + cmd.exe /c + full env + DSR reply
use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

fn main() {
    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize {
        rows: 24,
        cols: 80,
        pixel_width: 0,
        pixel_height: 0,
    }).expect("Failed to open PTY");

    let mut cmd = CommandBuilder::new("cmd.exe");
    cmd.arg("/c");
    cmd.arg("claude");
    cmd.cwd("D:\\Coffee Mode");

    for (key, val) in std::env::vars() {
        cmd.env(key, val);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let _child = pair.slave.spawn_command(cmd).expect("Failed to spawn");
    drop(_child); // <--- TEST FIX: if dropping Box<dyn Child> kills the process!
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().expect("reader");
    let writer = Arc::new(Mutex::new(pair.master.take_writer().expect("writer")));

    let _master_alive = &pair.master;

    eprintln!("Spawned cmd.exe /c claude, reading output...");

    let mut buf = [0u8; 4096];
    let start = std::time::Instant::now();
    let mut total_bytes = 0usize;
    loop {
        if start.elapsed().as_secs() > 8 {
            eprintln!("=== 8s elapsed ===");
            break;
        }
        match reader.read(&mut buf) {
            Ok(0) => {
                eprintln!("=== EOF ===");
                break;
            }
            Ok(n) => {
                total_bytes += n;
                let raw = String::from_utf8_lossy(&buf[..n]);
                let hex: Vec<String> = buf[..n.min(64)].iter().map(|b| format!("{:02x}", b)).collect();
                eprintln!("Got {} bytes: {}", n, hex.join(" "));
                
                if raw.contains("\x1b[6n") {
                    eprintln!("→ Detected DSR, replying with CSI 1;1R");
                    if let Ok(mut w) = writer.lock() {
                        let _ = w.write_all(b"\x1b[1;1R");
                    }
                }
            }
            Err(e) => {
                eprintln!("=== Read error: {} ===", e);
                break;
            }
        }
    }
}
