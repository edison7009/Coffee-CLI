//! Noise `IKpsk2` handshake and framed transport encryption.
//!
//! The phone (initiator) knows the desktop's static key from the pairing QR
//! code. The first WebSocket message is `[mode] ++ noise_msg1`:
//! - mode 0, resume: psk is all zeros; the phone's static key must already be
//!   paired.
//! - mode 1, pair: psk is SHA-256 of the one-time pairing code shown in the QR
//!   code; the phone's key is registered once its first encrypted frame
//!   decrypts, which proves it knew the code.
//!
//! Each later WebSocket binary message carries one plaintext split into
//! Noise messages, each prefixed with its big-endian u16 length.

use sha2::{Digest, Sha256};
use snow::{Builder, HandshakeState, TransportState};
use std::sync::Mutex;

pub const PATTERN: &str = "Noise_IKpsk2_25519_ChaChaPoly_SHA256";
pub const MODE_RESUME: u8 = 0;
pub const MODE_PAIR: u8 = 1;
const NOISE_MAX: usize = 65535;
const TAG: usize = 16;
const CHUNK: usize = NOISE_MAX - TAG;
pub const MAX_PLAINTEXT: usize = 4 << 20;

pub fn generate_keypair() -> (Vec<u8>, Vec<u8>) {
    let keys = Builder::new(PATTERN.parse().unwrap()).generate_keypair().unwrap();
    (keys.private, keys.public)
}

pub fn pairing_psk(code: &str) -> [u8; 32] { Sha256::digest(code.as_bytes()).into() }

pub struct Channel { state: Mutex<TransportState> }

impl Channel {
    fn new(state: TransportState) -> Self { Self { state: Mutex::new(state) } }

    pub fn encrypt(&self, plaintext: &[u8]) -> Result<Vec<u8>, String> {
        let mut state = self.state.lock().map_err(|_| "channel poisoned")?;
        let mut out = Vec::with_capacity(plaintext.len() + plaintext.len() / CHUNK * (TAG + 2) + TAG + 2);
        let mut buf = vec![0u8; NOISE_MAX];
        // An empty plaintext still produces one authenticated chunk.
        let chunks: Vec<&[u8]> = if plaintext.is_empty() { vec![&[]] } else { plaintext.chunks(CHUNK).collect() };
        for chunk in chunks {
            let len = state.write_message(chunk, &mut buf).map_err(|e| e.to_string())?;
            out.extend_from_slice(&(len as u16).to_be_bytes());
            out.extend_from_slice(&buf[..len]);
        }
        Ok(out)
    }

    pub fn decrypt(&self, mut frame: &[u8]) -> Result<Vec<u8>, String> {
        let mut state = self.state.lock().map_err(|_| "channel poisoned")?;
        let mut out = Vec::new();
        let mut buf = vec![0u8; NOISE_MAX];
        if frame.is_empty() { return Err("empty frame".into()); }
        while !frame.is_empty() {
            if frame.len() < 2 { return Err("truncated frame".into()); }
            let len = u16::from_be_bytes([frame[0], frame[1]]) as usize;
            let body = frame.get(2..2 + len).ok_or("truncated frame")?;
            let n = state.read_message(body, &mut buf).map_err(|_| "decrypt failed")?;
            out.extend_from_slice(&buf[..n]);
            if out.len() > MAX_PLAINTEXT { return Err("frame too large".into()); }
            frame = &frame[2 + len..];
        }
        Ok(out)
    }
}

/// Responder side of the handshake. Returns the reply, the phone's static key
/// and the transport channel.
pub fn respond(local_private: &[u8], msg1: &[u8], psk: &[u8; 32]) -> Result<(Vec<u8>, Vec<u8>, Channel), String> {
    let mut hs: HandshakeState = Builder::new(PATTERN.parse().unwrap()).local_private_key(local_private).psk(2, psk).build_responder().map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; NOISE_MAX];
    hs.read_message(msg1, &mut buf).map_err(|_| "handshake rejected")?;
    let remote = hs.get_remote_static().ok_or("missing static key")?.to_vec();
    let len = hs.write_message(&[], &mut buf).map_err(|e| e.to_string())?;
    let transport = hs.into_transport_mode().map_err(|e| e.to_string())?;
    Ok((buf[..len].to_vec(), remote, Channel::new(transport)))
}

/// Initiator side (the phone). Used by tests and as the reference for the app.
#[cfg_attr(not(test), allow(dead_code))]
pub struct Initiator { hs: HandshakeState }

#[cfg_attr(not(test), allow(dead_code))]
impl Initiator {
    pub fn new(local_private: &[u8], desktop_public: &[u8], psk: &[u8; 32]) -> Result<Self, String> {
        let hs = Builder::new(PATTERN.parse().unwrap()).local_private_key(local_private).remote_public_key(desktop_public).psk(2, psk).build_initiator().map_err(|e| e.to_string())?;
        Ok(Self { hs })
    }
    pub fn first_message(&mut self, mode: u8) -> Result<Vec<u8>, String> {
        let mut buf = vec![0u8; NOISE_MAX];
        let len = self.hs.write_message(&[], &mut buf).map_err(|e| e.to_string())?;
        let mut out = vec![mode];
        out.extend_from_slice(&buf[..len]);
        Ok(out)
    }
    pub fn finish(mut self, msg2: &[u8]) -> Result<Channel, String> {
        self.hs.read_message(msg2, &mut vec![0u8; NOISE_MAX]).map_err(|_| "handshake rejected")?;
        Ok(Channel::new(self.hs.into_transport_mode().map_err(|e| e.to_string())?))
    }
}
