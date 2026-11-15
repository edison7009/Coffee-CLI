//! External launch requests — `coffee-cli launch --tool <id> [--cwd <dir>]`
//! and prompt links — `coffeecli://new?z=<deflated, base64url>` (or the
//! older `coffeecli://new?prompt=<text>`).
//!
//! Lets launchers, context menus, scripts and shared links open Coffee CLI
//! directly into an agent tab, instead of landing on the launchpad and
//! making the user pick the tool + folder by hand.
//!
//! Delivery goes through one [`LaunchInbox`]:
//!
//! - **Cold start** — `main.rs` parses argv (Windows and Linux pass a
//!   clicked `coffeecli://` link as argv too) and seeds the inbox. On macOS
//!   the link arrives through the deep-link plugin instead, possibly before
//!   the frontend mounts, so it is parked in the same inbox.
//! - **Warm start** — the app is already running; the second process's
//!   argv is forwarded by the single-instance plugin (or macOS hands the
//!   URL to the running app). Once the frontend has drained the inbox via
//!   `take_pending_launch`, later requests are emitted as `launch-request`.
//!
//! Examples:
//!   macOS:   open -a "Coffee CLI" --args launch --tool kimicode --cwd /work/proj
//!   Windows: coffee-cli.exe launch --tool claude --cwd "C:\work\proj"
//!   Linux:   coffee-cli launch --tool codex --cwd ~/work/proj
//!   Link:    coffeecli://new?z=c8usUCjJSFVIKs3MSQEA ("Fix the build"; or ?prompt=Fix%20the%20build)
//!
//! `--tool` must be a registered tool id (`claude`, `codex`, `kimicode`,
//! `hermes`, …). Unknown tools and non-existent `--cwd` values are
//! rejected here so a bad invocation degrades to the plain launchpad
//! instead of erroring out in front of the user. A prompt link never sends
//! anything: the prompt only becomes a draft the user reads and sends.

use serde::Serialize;

/// URL scheme registered for prompt links (tauri.conf.json `plugins.deep-link`).
pub const SCHEME: &str = "coffeecli";
/// Longest prompt a link may carry, in characters (after hidden characters are removed).
pub const MAX_PROMPT_CHARS: usize = 8000;
/// Most bytes a compressed prompt may inflate to, so a tiny link can't expand into a huge one.
const MAX_INFLATED_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchRequest {
    /// Tool to start. Prompt links never set it; the user picks one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// Draft to place in the new tab's input. Never sent automatically.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    /// True when hidden characters were removed from `prompt`.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub prompt_had_hidden: bool,
}

/// Parse a launch request from a raw argv (with or without argv[0]): either
/// the `launch` subcommand or a `coffeecli://` link anywhere in argv.
/// Returns `None` when argv is not a launch request, the tool id is not
/// registered, or `--cwd` points at a directory that doesn't exist.
pub fn parse_launch_args(args: &[String]) -> Option<LaunchRequest> {
    if let Some(link) = args.iter().skip(1).chain(args.first()).find(|a| is_prompt_link(a)) {
        return parse_prompt_link(link);
    }
    // `launch` must be the first real argument. argv[0] presence varies
    // (bare exe name, full path, or single-instance forwarded argv), so
    // accept it at index 0 or 1 instead of guessing argv[0]'s shape.
    let start = match args.first().map(|s| s.as_str()) {
        Some("launch") => 1,
        _ if args.get(1).map(|s| s.as_str()) == Some("launch") => 2,
        _ => return None,
    };
    let rest = &args[start..];

    let mut tool: Option<String> = None;
    let mut cwd: Option<String> = None;
    let mut i = 0;
    while i < rest.len() {
        let arg = rest[i].as_str();
        // Support both `--flag value` and `--flag=value`.
        let (flag, inline_val) = match arg.split_once('=') {
            Some((f, v)) if f.starts_with("--") => (f, Some(v.to_string())),
            _ => (arg, None),
        };
        let next_val = |i: &mut usize| -> Option<String> {
            if let Some(v) = inline_val.clone() {
                return Some(v);
            }
            *i += 1;
            rest.get(*i).cloned()
        };
        match flag {
            "--tool" => tool = next_val(&mut i),
            "--cwd" => cwd = next_val(&mut i),
            _ => {}
        }
        i += 1;
    }

    let tool = tool?;
    // Unknown tool ids degrade to the plain launchpad.
    crate::tools::find(&tool)?;
    if let Some(dir) = &cwd {
        if !std::path::Path::new(dir).is_dir() {
            return None;
        }
    }
    Some(LaunchRequest { tool: Some(tool), cwd, prompt: None, prompt_had_hidden: false })
}

fn is_prompt_link(arg: &str) -> bool {
    arg.get(..SCHEME.len() + 1).is_some_and(|head| head.eq_ignore_ascii_case(&format!("{SCHEME}:")))
}

/// Parse `coffeecli://new?z=…` (the prompt deflated and base64url-encoded,
/// which keeps long prompts under Windows' command-line limit) or the older
/// `coffeecli://new?prompt=…`. A link carries only the text: it can't pick a
/// tool, folder, permission mode or anything else, and other parameters are
/// ignored. The user picks the tool on the launchpad.
pub fn parse_prompt_link(link: &str) -> Option<LaunchRequest> {
    let url = url::Url::parse(link.trim()).ok()?;
    if !url.scheme().eq_ignore_ascii_case(SCHEME) {
        return None;
    }
    let target = url.host_str().unwrap_or_else(|| url.path().trim_start_matches('/'));
    if !target.trim_end_matches('/').eq_ignore_ascii_case("new") {
        return None;
    }
    let param = |name: &str| url.query_pairs().find(|(key, _)| key == name).map(|(_, value)| value.into_owned());
    let raw = match param("z") {
        Some(packed) => inflate_prompt(&packed)?,
        None => param("prompt")?,
    };
    let (prompt, hidden) = sanitize_prompt(&raw);
    if prompt.trim().is_empty() || prompt.chars().count() > MAX_PROMPT_CHARS {
        return None;
    }
    Some(LaunchRequest { tool: None, cwd: None, prompt: Some(prompt), prompt_had_hidden: hidden })
}

/// Undo the website's and composer's packing: base64url, then raw deflate.
fn inflate_prompt(packed: &str) -> Option<String> {
    use base64::Engine;
    use std::io::Read;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(packed.trim().trim_end_matches('=')).ok()?;
    let mut out = Vec::new();
    flate2::read::DeflateDecoder::new(bytes.as_slice()).take(MAX_INFLATED_BYTES + 1).read_to_end(&mut out).ok()?;
    if out.len() as u64 > MAX_INFLATED_BYTES {
        return None;
    }
    String::from_utf8(out).ok()
}

/// Characters a reader can't see but an agent still reads: zero-width and
/// non-joiner marks, bidi overrides, invisible operators, Unicode tag characters
/// and stray control characters. They can smuggle instructions into a draft.
/// The emoji joiner (U+200D) and variation selectors stay: emoji need them.
fn is_hidden_char(c: char) -> bool {
    matches!(c,
        '\u{00AD}' | '\u{034F}' | '\u{061C}' | '\u{115F}' | '\u{1160}' | '\u{17B4}' | '\u{17B5}'
        | '\u{180B}'..='\u{180F}' | '\u{200B}' | '\u{200C}' | '\u{200E}' | '\u{200F}'
        | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{206F}' | '\u{3164}' | '\u{FEFF}' | '\u{FFA0}'
        | '\u{FFF0}'..='\u{FFFB}' | '\u{1D173}'..='\u{1D17A}' | '\u{E0000}'..='\u{E0FFF}')
        || (c.is_control() && c != '\n' && c != '\t')
}

/// Remove hidden characters and normalize line endings. Returns the cleaned
/// text and whether anything hidden was removed (CRLF alone doesn't count).
pub fn sanitize_prompt(raw: &str) -> (String, bool) {
    let text = raw.replace("\r\n", "\n");
    let mut hidden = false;
    let clean = text
        .chars()
        .filter(|&c| {
            let drop = is_hidden_char(c);
            hidden |= drop;
            !drop
        })
        .collect();
    (clean, hidden)
}

/// Requests that arrive before the frontend is listening wait here; the
/// first `take` marks the frontend ready, after which requests are emitted.
#[derive(Debug, Default)]
pub struct LaunchInbox {
    ready: bool,
    pending: Option<LaunchRequest>,
}

impl LaunchInbox {
    pub fn new(pending: Option<LaunchRequest>) -> Self {
        Self { ready: false, pending }
    }

    /// Park the request until the frontend drains it, or hand it back to be
    /// emitted now. A newer parked request replaces an older one.
    pub fn offer(&mut self, req: LaunchRequest) -> Option<LaunchRequest> {
        if self.ready {
            return Some(req);
        }
        self.pending = Some(req);
        None
    }

    /// Drain the parked request; later requests are emitted as events.
    pub fn take(&mut self) -> Option<LaunchRequest> {
        self.ready = true;
        self.pending.take()
    }
}

/// Route a request to the frontend (parked or emitted) and bring the window forward.
pub fn deliver(app: &tauri::AppHandle, req: LaunchRequest) {
    use tauri::{Emitter, Manager};
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
    let state = app.state::<crate::server::AppState>();
    let now = match state.pending_launch.lock() {
        Ok(mut inbox) => inbox.offer(req),
        Err(_) => return,
    };
    if let Some(req) = now {
        let _ = app.emit("launch-request", req);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| s.to_string()).collect()
    }

    fn first_tool_id() -> &'static str {
        crate::tools::TOOLS[0].id
    }

    #[test]
    fn ignores_non_launch_argv() {
        assert!(parse_launch_args(&argv(&["coffee-cli"])).is_none());
        assert!(parse_launch_args(&argv(&["coffee-cli", "--help"])).is_none());
        assert!(parse_launch_args(&argv(&["launch"])).is_none()); // missing --tool
    }

    #[test]
    fn parses_tool_with_and_without_argv0() {
        let id = first_tool_id();
        let with0 = parse_launch_args(&argv(&["/usr/bin/coffee-cli", "launch", "--tool", id]));
        let without0 = parse_launch_args(&argv(&["launch", "--tool", id]));
        assert_eq!(with0.as_ref().and_then(|r| r.tool.as_deref()), Some(id));
        assert_eq!(without0.as_ref().and_then(|r| r.tool.as_deref()), Some(id));
        assert!(with0.unwrap().cwd.is_none());
    }

    #[test]
    fn parses_equals_form_and_validates_cwd() {
        let id = first_tool_id();
        let cwd = std::env::temp_dir().to_string_lossy().into_owned();
        let ok = parse_launch_args(&argv(&[
            "coffee-cli",
            "launch",
            &format!("--tool={}", id),
            &format!("--cwd={cwd}"),
        ]));
        assert_eq!(ok.as_ref().and_then(|r| r.cwd.as_deref()), Some(cwd.as_str()));

        let bad = parse_launch_args(&argv(&[
            "coffee-cli",
            "launch",
            "--tool",
            id,
            "--cwd",
            "/definitely/not/a/real/dir-9f2b7",
        ]));
        assert!(bad.is_none());
    }

    #[test]
    fn rejects_unknown_tool() {
        assert!(parse_launch_args(&argv(&[
            "coffee-cli",
            "launch",
            "--tool",
            "not-a-real-tool"
        ]))
        .is_none());
    }

    #[test]
    fn parses_prompt_links_from_argv() {
        let link = "coffeecli://new?prompt=Fix%20the%20build%2B%E4%BD%A0%E5%A5%BD";
        let req = parse_launch_args(&argv(&["C:\\Coffee CLI\\coffee-cli.exe", link])).unwrap();
        assert_eq!(req.prompt.as_deref(), Some("Fix the build+你好"));
        assert!(req.tool.is_none());
        assert!(req.cwd.is_none());
        assert!(!req.prompt_had_hidden);
        // Trailing slash, `+` as space, and an uppercase scheme are all accepted.
        let req = parse_prompt_link("COFFEECLI://new/?prompt=a+b").unwrap();
        assert_eq!(req.prompt.as_deref(), Some("a b"));
        assert!(req.tool.is_none());
    }

    #[test]
    fn prompt_links_never_pick_a_tool_or_folder() {
        let id = first_tool_id();
        let cwd = std::env::temp_dir().to_string_lossy().into_owned();
        let req = parse_prompt_link(&format!("coffeecli://new?prompt=hi&tool={id}&cwd={cwd}")).unwrap();
        assert!(req.tool.is_none());
        assert!(req.cwd.is_none());
        assert!(parse_prompt_link(&format!("coffeecli://new?tool={id}")).is_none(), "a link without text does nothing");
    }

    #[test]
    fn rejects_bad_prompt_links() {
        assert!(parse_prompt_link("coffeecli://settings?prompt=hi").is_none());
        assert!(parse_prompt_link("https://new?prompt=hi").is_none());
        assert!(parse_prompt_link("coffeecli://new").is_none());
        assert!(parse_prompt_link("coffeecli://new?prompt=%20%0A").is_none());
        let long = "a".repeat(MAX_PROMPT_CHARS + 1);
        assert!(parse_prompt_link(&format!("coffeecli://new?prompt={long}")).is_none());
        let exact = "字".repeat(MAX_PROMPT_CHARS);
        assert!(parse_prompt_link(&format!("coffeecli://new?prompt={exact}")).is_some());
    }

    fn pack(text: &[u8]) -> String {
        use base64::Engine;
        use std::io::Write;
        let mut encoder = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::best());
        encoder.write_all(text).unwrap();
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(encoder.finish().unwrap())
    }

    #[test]
    fn parses_compressed_prompt_links() {
        let text = "帮我整理下载目录\n按类型分文件夹 & run `npm test` + 100%";
        let req = parse_launch_args(&argv(&["coffee-cli", &format!("coffeecli://new?z={}", pack(text.as_bytes()))])).unwrap();
        assert_eq!(req.prompt.as_deref(), Some(text));
        assert!(req.tool.is_none() && req.cwd.is_none());
        // `z` wins over a plain `prompt`, and hidden characters inside it are still removed.
        let req = parse_prompt_link(&format!("coffeecli://new?prompt=other&z={}", pack("a\u{200B}b".as_bytes()))).unwrap();
        assert_eq!(req.prompt.as_deref(), Some("ab"));
        assert!(req.prompt_had_hidden);
        // A long Chinese prompt stays far below Windows' 32,767-character command line.
        let long = "把这段提示词分享给朋友，".repeat(600);
        assert!(format!("coffeecli://new?z={}", pack(long.as_bytes())).len() < 32_000);
    }

    #[test]
    fn rejects_bad_or_oversized_compressed_links() {
        assert!(parse_prompt_link("coffeecli://new?z=%%%not-base64").is_none());
        assert!(parse_prompt_link("coffeecli://new?z=AAAA").is_none(), "not deflate data");
        assert!(parse_prompt_link(&format!("coffeecli://new?z={}", pack(&[0xff, 0xfe, 0x41]))).is_none(), "not UTF-8");
        // A small link that inflates past the cap is dropped, not expanded.
        let bomb = pack(&vec![b'a'; 10 * 1024 * 1024]);
        assert!(bomb.len() < 20_000);
        assert!(parse_prompt_link(&format!("coffeecli://new?z={bomb}")).is_none());
        // Within the byte cap but over the character limit: rejected like a plain prompt.
        assert!(parse_prompt_link(&format!("coffeecli://new?z={}", pack("字".repeat(MAX_PROMPT_CHARS + 1).as_bytes()))).is_none());
    }

    #[test]
    fn strips_hidden_characters_and_flags_them() {
        let (clean, hidden) = sanitize_prompt("run\u{200B} this\u{E0041}\u{E0042}\u{202E}\r\nok\tdone\u{0007}");
        assert_eq!(clean, "run this\nok\tdone");
        assert!(hidden);
        let (clean, hidden) = sanitize_prompt("line one\r\nline two 👍🏽 ❤️ 👨\u{200D}👩 é");
        assert_eq!(clean, "line one\nline two 👍🏽 ❤️ 👨\u{200D}👩 é");
        assert!(!hidden);
        let req = parse_prompt_link("coffeecli://new?prompt=hi%E2%80%8Bthere").unwrap();
        assert_eq!(req.prompt.as_deref(), Some("hithere"));
        assert!(req.prompt_had_hidden);
    }

    #[test]
    fn inbox_parks_until_the_frontend_drains_then_hands_back() {
        let req = |p: &str| LaunchRequest { tool: None, cwd: None, prompt: Some(p.into()), prompt_had_hidden: false };
        let mut inbox = LaunchInbox::new(None);
        assert!(inbox.offer(req("a")).is_none());
        assert!(inbox.offer(req("b")).is_none());
        assert_eq!(inbox.take(), Some(req("b")));
        assert_eq!(inbox.take(), None);
        assert_eq!(inbox.offer(req("c")), Some(req("c")));
    }
}
