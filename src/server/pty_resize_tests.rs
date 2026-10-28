use super::*;
use portable_pty::{MasterPty, PtySize};
use std::cell::Cell;

struct ObservedPty {
    master: Box<dyn MasterPty + Send>,
    calls: Cell<usize>,
    fail_resize: Cell<bool>,
    fail_query: Cell<bool>,
    gate: Option<(std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>)>,
}

impl MasterPty for ObservedPty {
    fn resize(&self, size: PtySize) -> anyhow::Result<()> {
        self.calls.set(self.calls.get() + 1);
        if let Some((started, resume)) = &self.gate { started.send(()).unwrap(); resume.recv().unwrap(); }
        if self.fail_resize.get() { anyhow::bail!("test resize failure"); }
        self.master.resize(size)
    }
    fn get_size(&self) -> anyhow::Result<PtySize> {
        if self.fail_query.get() { anyhow::bail!("test size query failure"); }
        self.master.get_size()
    }
    fn try_clone_reader(&self) -> anyhow::Result<Box<dyn std::io::Read + Send>> {
        self.master.try_clone_reader()
    }
    fn take_writer(&self) -> anyhow::Result<Box<dyn std::io::Write + Send>> {
        self.master.take_writer()
    }
    #[cfg(unix)]
    fn process_group_leader(&self) -> Option<i32> { self.master.process_group_leader() }
    #[cfg(unix)]
    fn as_raw_fd(&self) -> Option<i32> { self.master.as_raw_fd() }
    #[cfg(unix)]
    fn tty_name(&self) -> Option<std::path::PathBuf> { self.master.tty_name() }
}

#[test]
fn native_pty_deduplicates_applied_size_and_retries_failures() {
    let pair = portable_pty::native_pty_system().openpty(PtySize::default()).unwrap();
    let pty = ObservedPty {
        master: pair.master, calls: Cell::new(0),
        fail_resize: Cell::new(false), fail_query: Cell::new(false), gate: None,
    };
    resize_terminal_pty(&pty, 80, 24).unwrap();
    assert_eq!(pty.calls.get(), 0, "skip the actual spawn size");
    resize_terminal_pty(&pty, 100, 30).unwrap();
    resize_terminal_pty(&pty, 100, 30).unwrap();
    assert_eq!(pty.calls.get(), 1, "only the first change resizes");

    // Model a change made outside Coffee's resize command (stty on Unix).
    pty.master.resize(PtySize { cols: 90, rows: 25, ..PtySize::default() }).unwrap();
    resize_terminal_pty(&pty, 100, 30).unwrap();
    assert_eq!(pty.calls.get(), 2, "do not reuse a stale last-requested size");
    assert_eq!(pty.get_size().unwrap().cols, 100);

    pty.fail_resize.set(true);
    assert!(resize_terminal_pty(&pty, 120, 40).is_err());
    pty.fail_resize.set(false);
    resize_terminal_pty(&pty, 120, 40).unwrap();
    assert_eq!(pty.calls.get(), 4, "a failed resize must not suppress a retry");
    assert_eq!(pty.get_size().unwrap().rows, 40);

    pty.fail_query.set(true);
    resize_terminal_pty(&pty, 120, 40).unwrap();
    assert_eq!(pty.calls.get(), 5, "unknown size falls back to resizing");
}

#[test]
fn resize_rejects_zero_dimensions() {
    let pair = portable_pty::native_pty_system().openpty(PtySize::default()).unwrap();
    let pty = ObservedPty {
        master: pair.master, calls: Cell::new(0),
        fail_resize: Cell::new(false), fail_query: Cell::new(false), gate: None,
    };
    assert!(resize_terminal_pty(&pty, 0, 24).is_err());
    assert!(resize_terminal_pty(&pty, 80, 0).is_err());
    assert_eq!(pty.calls.get(), 0);
}

#[test]
fn blocked_resize_does_not_hold_the_session_map_or_stop_other_tabs() {
    use std::sync::{Arc, Mutex, atomic::AtomicBool, mpsc};
    let pair = portable_pty::native_pty_system().openpty(PtySize::default()).unwrap();
    let (started_tx, started_rx) = mpsc::channel();
    let (resume_tx, resume_rx) = mpsc::channel();
    let pty = ObservedPty { master: pair.master, calls: Cell::new(0), fail_resize: Cell::new(false), fail_query: Cell::new(false), gate: Some((started_tx, resume_rx)) };
    let (kill_tx, kill_rx) = mpsc::channel();
    let sessions = Arc::new(Mutex::new(std::collections::HashMap::new()));
    sessions.lock().unwrap().insert("slow".into(), terminal::TerminalSession {
        writer_lock: Arc::new(Mutex::new(Box::new(std::io::sink()))), kill_tx,
        tool_name: None, launch_config: Default::default(), launch_cwd: None,
        session_token: Mutex::new(None), _master: Arc::new(Mutex::new(Some(Box::new(pty)))),
        is_tab_active: Arc::new(AtomicBool::new(true)),
    });
    let owned = sessions.clone();
    let resize = tauri::async_runtime::spawn(async move { resize_terminal_session(owned, "slow".into(), 100, 30).await });
    let started = started_rx.recv_timeout(std::time::Duration::from_secs(5));
    let responsive = sessions.try_lock().map(|map| map["slow"].kill_tx.send(()).is_ok()).unwrap_or(false);
    resume_tx.send(()).ok();
    tauri::async_runtime::block_on(resize).unwrap().unwrap();
    started.unwrap();
    assert!(responsive, "a slow PTY resize must not block close or another session's lookup");
    kill_rx.try_recv().unwrap();
}
