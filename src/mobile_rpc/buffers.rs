//! Recent terminal output, so a browser that starts mirroring a terminal late
//! still sees what is on it.

use std::collections::{HashMap, VecDeque};

pub const TERMINAL_BYTES: usize = 256 * 1024;
pub const MAX_SESSIONS: usize = 64;

/// Recent terminal output plus how many bytes the terminal has produced in all,
/// so a mirror can tell which live chunks its snapshot already holds.
#[derive(Default)]
struct TerminalLog { text: String, end: u64 }

#[derive(Default)]
pub struct Buffers {
    terminals: HashMap<String, TerminalLog>,
    order: VecDeque<String>,
}

impl Buffers {
    pub fn clear(&mut self) { *self = Self::default(); }

    fn touch(&mut self, id: &str) {
        if let Some(pos) = self.order.iter().position(|known| known == id) { self.order.remove(pos); }
        self.order.push_back(id.to_owned());
        while self.order.len() > MAX_SESSIONS {
            if let Some(old) = self.order.pop_front() { self.terminals.remove(&old); }
        }
    }

    /// Appends output; returns the chunk's byte range in the terminal's whole output.
    pub fn push_terminal(&mut self, id: &str, data: &str) -> (u64, u64) {
        self.touch(id);
        let log = self.terminals.entry(id.to_owned()).or_default();
        let start = log.end;
        log.end += data.len() as u64;
        log.text.push_str(data);
        if log.text.len() > TERMINAL_BYTES {
            let mut cut = log.text.len() - TERMINAL_BYTES;
            while !log.text.is_char_boundary(cut) { cut += 1; }
            log.text.drain(..cut);
        }
        (start, log.end)
    }

    /// The recent output and the byte offset it ends at; `None` before any output.
    pub fn terminal(&self, id: &str) -> Option<(String, u64)> {
        self.terminals.get(id).map(|log| (log.text.clone(), log.end))
    }
}
