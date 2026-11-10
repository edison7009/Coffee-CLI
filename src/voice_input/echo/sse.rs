#[derive(Default)]
pub(crate) struct SseParser {
    pending: Vec<u8>,
}

impl SseParser {
    pub(crate) fn push(&mut self, bytes: &[u8]) -> Vec<(String, String)> {
        self.pending.extend_from_slice(bytes);
        let mut frames = Vec::new();
        loop {
            let separator = [
                self.pending
                    .windows(2)
                    .position(|v| v == b"\n\n")
                    .map(|at| (at, 2)),
                self.pending
                    .windows(4)
                    .position(|v| v == b"\r\n\r\n")
                    .map(|at| (at, 4)),
            ]
            .into_iter()
            .flatten()
            .min_by_key(|(at, _)| *at);
            let Some((at, length)) = separator else { break };
            let raw = self.pending.drain(..at + length).collect::<Vec<_>>();
            let block = String::from_utf8_lossy(&raw[..at]);
            let mut event = String::new();
            let mut data = Vec::new();
            for line in block.lines() {
                if let Some(value) = line.strip_prefix("event:") {
                    event = value.trim_start().to_string();
                } else if let Some(value) = line.strip_prefix("data:") {
                    data.push(value.strip_prefix(' ').unwrap_or(value));
                }
            }
            if !data.is_empty() {
                frames.push((event, data.join("\n")));
            }
        }
        frames
    }

    pub(crate) fn finish(&mut self) -> Vec<(String, String)> {
        if self.pending.is_empty() {
            Vec::new()
        } else {
            self.push(b"\n\n")
        }
    }
}
