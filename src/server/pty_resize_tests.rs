use super::*;
use portable_pty::{MasterPty, PtySize};
use std::cell::Cell;

struct ObservedPty {
    master: Box<dyn MasterPty + Send>,
    calls: Cell<usize>,
    fail_resize: Cell<bool>,
    fail_query: Cell<bool>,
}

impl MasterPty for ObservedPty {
    fn resize(&self, size: PtySize) -> anyhow::Result<()> {
        self.calls.set(self.calls.get() + 1);
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
        fail_resize: Cell::new(false), fail_query: Cell::new(false),
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
