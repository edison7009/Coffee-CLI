//! Replay buffers so a phone that subscribes late still sees recent output.

use serde_json::Value;
use std::collections::{HashMap, VecDeque};

pub const TERMINAL_BYTES: usize = 256 * 1024;
pub const CONVERSATION_EVENTS: usize = 4000;
pub const CONVERSATION_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_SESSIONS: usize = 64;

#[derive(Default)]
struct Conversation { kind: String, generation: String, events: VecDeque<(usize, Value)>, bytes: usize }

#[derive(Default)]
pub struct Buffers {
    terminals: HashMap<String, String>,
    conversations: HashMap<String, Conversation>,
    order: VecDeque<String>,
}

#[derive(Debug, PartialEq)]
pub enum Replay {
    Terminal(String),
    Conversation { kind: String, generation: String, events: Vec<Value> },
    Empty,
}

impl Buffers {
    pub fn clear(&mut self) { *self = Self::default(); }

    fn touch(&mut self, id: &str) {
        if let Some(pos) = self.order.iter().position(|known| known == id) { self.order.remove(pos); }
        self.order.push_back(id.to_owned());
        while self.order.len() > MAX_SESSIONS {
            if let Some(old) = self.order.pop_front() { self.terminals.remove(&old); self.conversations.remove(&old); }
        }
    }

    pub fn push_terminal(&mut self, id: &str, data: &str) {
        self.touch(id);
        let buffer = self.terminals.entry(id.to_owned()).or_default();
        buffer.push_str(data);
        if buffer.len() > TERMINAL_BYTES {
            let mut cut = buffer.len() - TERMINAL_BYTES;
            while !buffer.is_char_boundary(cut) { cut += 1; }
            buffer.drain(..cut);
        }
    }

    /// A new generation means the session restarted: earlier events belong to
    /// a different reducer state and are discarded.
    pub fn push_conversation(&mut self, id: &str, kind: &str, generation: &str, event: Value) {
        self.touch(id);
        let entry = self.conversations.entry(id.to_owned()).or_default();
        if entry.generation != generation || entry.kind != kind {
            *entry = Conversation { kind: kind.to_owned(), generation: generation.to_owned(), ..Default::default() };
        }
        let size = event.to_string().len();
        entry.bytes += size;
        entry.events.push_back((size, event));
        while entry.events.len() > CONVERSATION_EVENTS || (entry.bytes > CONVERSATION_BYTES && entry.events.len() > 1) {
            if let Some((size, _)) = entry.events.pop_front() { entry.bytes -= size; }
        }
    }

    pub fn replay(&self, id: &str) -> Replay {
        if let Some(c) = self.conversations.get(id) {
            return Replay::Conversation { kind: c.kind.clone(), generation: c.generation.clone(), events: c.events.iter().map(|(_, e)| e.clone()).collect() };
        }
        self.terminals.get(id).map_or(Replay::Empty, |snapshot| Replay::Terminal(snapshot.clone()))
    }
}
