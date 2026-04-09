// translation.rs — Terminal Output Translation Engine
// Loads tool-specific dictionaries (per-language files in directory structure)
// and translates terminal output by matching parameterized patterns
// while preserving ANSI sequences.
//
// Dictionary layout:
//   dictionaries/
//     claude-code/
//       _config.json    → {"commands": [...], "patterns": [...]}
//       zh-CN.json      → {"entries": [{"pattern": "...", "translation": "..."}]}
//       ja.json
//     git/
//       _config.json
//       zh-CN.json

use regex::Regex;
use serde::Deserialize;
use std::collections::HashMap;
use std::path::Path;
use unicode_width::UnicodeWidthStr;
use std::sync::Arc;

// ─── Dictionary JSON Schema ──────────────────────────────────────────────────

/// Tool detection config (_config.json in each tool directory)
#[derive(Deserialize, Debug)]
struct ToolConfigFile {
    commands: Vec<String>,
    patterns: Vec<String>,
}

/// Per-language dictionary file (e.g. zh-CN.json)
#[derive(Deserialize, Debug)]
struct LangDictFile {
    entries: Vec<LangEntryDef>,
}

/// A single entry in a per-language dictionary
#[derive(Deserialize, Debug)]
struct LangEntryDef {
    pattern: String,
    translation: String,
}

// ─── Compiled Dictionary ─────────────────────────────────────────────────────

#[derive(Debug)]
struct CompiledEntry {
    regex: Regex,
    groups: Vec<String>,
    translation: String,
}

#[derive(Debug)]
pub struct ToolDictionary {
    pub tool: String,
    detection_commands: Vec<String>,
    detection_patterns: Vec<String>,
    /// Entries keyed by language code (e.g. "zh-CN" → entries)
    lang_entries: HashMap<String, Vec<CompiledEntry>>,
}

impl ToolDictionary {
    /// Try to translate a single line of plain text using this dictionary.
    /// Returns Some(translated) if a pattern matches, None otherwise.
    pub fn translate(&self, text: &str, lang: &str) -> Option<String> {
        let entries = self.lang_entries.get(lang)?;
        for entry in entries {
            if let Some(caps) = entry.regex.captures(text) {
                let mut result = entry.translation.clone();
                for (i, group_name) in entry.groups.iter().enumerate() {
                    if let Some(m) = caps.get(i + 1) {
                        result = result.replace(
                            &format!("{{{}}}", group_name),
                            m.as_str(),
                        );
                    }
                }
                return Some(result);
            }
        }
        None
    }

    /// Check if this dictionary should be active for a given command name.
    pub fn matches_command(&self, cmd: &str) -> bool {
        let cmd_lower = cmd.to_lowercase();
        self.detection_commands.iter().any(|c| {
            cmd_lower.contains(&c.to_lowercase())
        })
    }

    /// Check if this dictionary should be active based on output content.
    pub fn matches_output(&self, line: &str) -> bool {
        self.detection_patterns.iter().any(|p| line.contains(p.as_str()))
    }
}

// ─── Pattern Compiler ────────────────────────────────────────────────────────

/// Compile a parameterized pattern like "Compiling {crate} v{version}"
/// into a regex like "^Compiling (.+) v(.+)$" with group names ["crate", "version"].
fn compile_pattern(pattern: &str, translation: &str) -> Option<CompiledEntry> {
    let mut regex_str = String::new();
    let mut groups = Vec::new();
    let mut chars = pattern.chars().peekable();

    while let Some(c) = chars.next() {
        if c == '{' {
            // Extract variable name
            let mut name = String::new();
            for nc in chars.by_ref() {
                if nc == '}' {
                    break;
                }
                name.push(nc);
            }
            if !name.is_empty() {
                groups.push(name);
                regex_str.push_str("(.+?)");
            }
        } else {
            // Escape regex metacharacters
            match c {
                '.' | '*' | '+' | '?' | '(' | ')' | '[' | ']' | '|' | '^' | '$' | '\\' => {
                    regex_str.push('\\');
                    regex_str.push(c);
                }
                _ => regex_str.push(c),
            }
        }
    }

    // Make the last capture group greedy (for trailing content like messages)
    if !groups.is_empty() {
        if let Some(pos) = regex_str.rfind("(.+?)") {
            let end = pos + 5;
            regex_str.replace_range(pos..end, "(.+)");
        }
    }

    let full_regex = format!("^{}$", regex_str);
    match Regex::new(&full_regex) {
        Ok(regex) => Some(CompiledEntry {
            regex,
            groups,
            translation: translation.to_string(),
        }),
        Err(e) => {
            eprintln!("[Translation] Failed to compile pattern '{}': {}", pattern, e);
            None
        }
    }
}

// ─── Translation Engine ──────────────────────────────────────────────────────

pub struct TranslationEngine {
    dictionaries: Vec<ToolDictionary>,
    active_tool: std::sync::Mutex<Option<String>>,
    target_lang: std::sync::Mutex<String>,
    enabled: std::sync::Mutex<bool>,
    in_alternate_screen: std::sync::Mutex<bool>,
}

impl TranslationEngine {
    /// Create a new engine, loading all dictionaries from the given directory.
    /// Expects directory structure: dict_dir/tool-name/_config.json + lang.json
    pub fn load(dict_dir: &Path, target_lang: &str) -> Arc<Self> {
        let mut dictionaries = Vec::new();

        if dict_dir.is_dir() {
            if let Ok(entries) = std::fs::read_dir(dict_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if !path.is_dir() {
                        continue; // Skip flat files — only read directories
                    }

                    let tool_name = path.file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("")
                        .to_string();

                    // Skip hidden directories and _common (no longer used)
                    if tool_name.starts_with('.') || tool_name.starts_with('_') {
                        continue;
                    }

                    match load_tool_directory(&path, &tool_name) {
                        Ok(dict) => {
                            let total_entries: usize = dict.lang_entries.values()
                                .map(|e| e.len()).sum();
                            let langs: Vec<&String> = dict.lang_entries.keys().collect();
                            eprintln!("[Translation] Loaded tool '{}': {} entries, langs={:?}",
                                dict.tool, total_entries, langs);
                            dictionaries.push(dict);
                        }
                        Err(e) => {
                            eprintln!("[Translation] Failed to load tool '{}': {}",
                                tool_name, e);
                        }
                    }
                }
            }
        } else {
            eprintln!("[Translation] Dictionary directory not found: {:?}", dict_dir);
        }

        eprintln!("[Translation] Engine ready: {} tool dictionaries", dictionaries.len());

        Arc::new(Self {
            dictionaries,
            active_tool: std::sync::Mutex::new(None),
            target_lang: std::sync::Mutex::new(target_lang.to_string()),
            enabled: std::sync::Mutex::new(true),
            in_alternate_screen: std::sync::Mutex::new(false),
        })
    }

    /// Set target language (e.g. "zh-CN", "ja", "ko")
    pub fn set_lang(&self, lang: &str) {
        let mut l = self.target_lang.lock().unwrap();
        *l = lang.to_string();
        eprintln!("[Translation] Target language set to: {}", lang);
    }

    /// Enable or disable translation
    #[allow(dead_code)]
    pub fn set_enabled(&self, enabled: bool) {
        let mut e = self.enabled.lock().unwrap();
        *e = enabled;
    }

    /// Notify the engine that an alternate screen buffer was entered/exited.
    /// When in alternate screen (TUI mode), translation is bypassed.
    pub fn set_alternate_screen(&self, active: bool) {
        let mut a = self.in_alternate_screen.lock().unwrap();
        *a = active;
        if active {
            eprintln!("[Translation] TUI mode detected — translation paused");
        } else {
            eprintln!("[Translation] TUI mode exited — translation resumed");
        }
    }

    /// Detect the active tool from a command string (called at spawn time).
    pub fn detect_tool_from_command(&self, cmd: &str) {
        let mut active = self.active_tool.lock().unwrap();
        for dict in &self.dictionaries {
            if dict.matches_command(cmd) {
                eprintln!("[Translation] Tool detected from command: {}", dict.tool);
                *active = Some(dict.tool.clone());
                return;
            }
        }
        *active = None;
    }

    /// Try to detect the active tool from a line of output.
    /// Returns Some(tool_name) if a NEW tool was detected (state changed).
    pub fn try_detect_tool_from_output(&self, line: &str) -> Option<String> {
        let mut active = self.active_tool.lock().unwrap();
        for dict in &self.dictionaries {
            if dict.matches_output(line) {
                if active.as_deref() != Some(&dict.tool) {
                    eprintln!("[Translation] Tool detected from output: {}", dict.tool);
                    let tool_name = dict.tool.clone();
                    *active = Some(tool_name.clone());
                    return Some(tool_name);
                }
                return None;
            }
        }
        None
    }

    /// Translate a single line of plain text (with ANSI already stripped).
    /// Returns Some(translated) if translation found, None to pass through original.
    /// No fallback chain — only the active tool's dictionary is queried.
    pub fn translate_line(&self, line: &str) -> Option<String> {
        // Check if translation is enabled
        if !*self.enabled.lock().unwrap() {
            return None;
        }

        // Skip if in alternate screen (TUI mode)
        if *self.in_alternate_screen.lock().unwrap() {
            return None;
        }

        let lang = self.target_lang.lock().unwrap().clone();

        // "en" = no translation needed
        if lang == "en" {
            return None;
        }

        // Skip empty or whitespace-only lines
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return None;
        }

        // Try auto-detection from output
        self.try_detect_tool_from_output(trimmed);

        // Only query the active tool's dictionary — no fallback
        let active_tool = self.active_tool.lock().unwrap().clone();
        if let Some(tool_name) = &active_tool {
            if let Some(dict) = self.dictionaries.iter().find(|d| &d.tool == tool_name) {
                if let Some(translated) = dict.translate(trimmed, &lang) {
                    // Preserve leading whitespace from original
                    let leading: String = line.chars().take_while(|c| c.is_whitespace()).collect();
                    return Some(format!("{}{}", leading, translated));
                }
            }
        }

        None
    }

    /// Export raw pattern-translation pairs for the frontend CoffeeOverlay renderer.
    /// Returns Vec<(pattern, translation)> for the given tool and language.
    pub fn get_entries_for_frontend(&self, tool: &str, lang: &str) -> Vec<(String, String)> {
        for dict in &self.dictionaries {
            if dict.tool == tool {
                if let Some(entries) = dict.lang_entries.get(lang) {
                    return entries.iter().map(|e| {
                        // Convert regex back to approximate pattern for frontend substring matching
                        // Strip ^...$ anchors and unescape
                        let pattern_str = e.regex.as_str();
                        let cleaned = pattern_str
                            .strip_prefix('^').unwrap_or(pattern_str)
                            .strip_suffix('$').unwrap_or(pattern_str)
                            .replace("\\.", ".")
                            .replace("\\?", "?")
                            .replace("\\!", "!")
                            .replace("\\(", "(")
                            .replace("\\)", ")")
                            .replace("(.+?)", "")
                            .replace("(.+)", "");
                        (cleaned, e.translation.clone())
                    }).collect();
                }
            }
        }
        Vec::new()
    }
}

// ─── Directory Loader ────────────────────────────────────────────────────────

/// Load a tool dictionary from a directory containing _config.json + lang files.
fn load_tool_directory(dir: &Path, tool_name: &str) -> anyhow::Result<ToolDictionary> {
    // Read _config.json
    let config_path = dir.join("_config.json");
    let config: ToolConfigFile = if config_path.exists() {
        let content = std::fs::read_to_string(&config_path)?;
        serde_json::from_str(&content)?
    } else {
        // Default: use directory name as command
        ToolConfigFile {
            commands: vec![tool_name.to_string()],
            patterns: vec![],
        }
    };

    // Read all language files (*.json except _config.json)
    let mut lang_entries: HashMap<String, Vec<CompiledEntry>> = HashMap::new();

    if let Ok(files) = std::fs::read_dir(dir) {
        for file_entry in files.flatten() {
            let path = file_entry.path();
            let filename = path.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");

            // Skip _config.json and non-JSON files
            if filename.starts_with('_') || path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }

            // Language code from filename: "zh-CN.json" → "zh-CN"
            let lang = filename.trim_end_matches(".json").to_string();

            match load_lang_file(&path) {
                Ok(entries) => {
                    lang_entries.insert(lang, entries);
                }
                Err(e) => {
                    eprintln!("[Translation] Failed to load {}/{}: {}", tool_name, filename, e);
                }
            }
        }
    }

    Ok(ToolDictionary {
        tool: tool_name.to_string(),
        detection_commands: config.commands,
        detection_patterns: config.patterns,
        lang_entries,
    })
}

/// Load and compile entries from a per-language dictionary file.
fn load_lang_file(path: &Path) -> anyhow::Result<Vec<CompiledEntry>> {
    let content = std::fs::read_to_string(path)?;
    let file: LangDictFile = serde_json::from_str(&content)?;

    let mut entries = Vec::new();
    for entry_def in &file.entries {
        if let Some(compiled) = compile_pattern(&entry_def.pattern, &entry_def.translation) {
            entries.push(compiled);
        }
    }

    // Sort entries by pattern length (longer = more specific = higher priority)
    entries.sort_by(|a, b| {
        let len_a = a.regex.as_str().len();
        let len_b = b.regex.as_str().len();
        len_b.cmp(&len_a)
    });

    Ok(entries)
}

// ─── URL Percent-Decoding ────────────────────────────────────────────────────
// Decode %XX sequences in file:// URIs from OSC 7 to actual path characters.

fn percent_decode(input: &str) -> String {
    let mut result = Vec::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = bytes[i + 1];
            let lo = bytes[i + 2];
            if let (Some(h), Some(l)) = (hex_val(hi), hex_val(lo)) {
                result.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        result.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(result).unwrap_or_else(|_| input.to_string())
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'A'..=b'F' => Some(b - b'A' + 10),
        b'a'..=b'f' => Some(b - b'a' + 10),
        _ => None,
    }
}

// ─── VT Stream Processor ─────────────────────────────────────────────────────
// Parses raw PTY bytes through the VTE state machine, extracts translatable
// text lines, and reassembles them with ANSI sequences preserved.

pub struct VtProcessor {
    parser: vte::Parser,
    performer: VtPerformer,
}

struct VtPerformer {
    engine: Arc<TranslationEngine>,
    text_buf: String,
    ansi_prefix: Vec<u8>,
    output: Vec<u8>,
    has_text: bool,
    pub cwd_change: Option<String>,
}

/// Reconstruct a CSI sequence from its parsed components into raw bytes.
fn reconstruct_csi(params: &vte::Params, intermediates: &[u8], action: char) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.push(0x1b);
    bytes.push(b'[');
    let mut first_param = true;
    for param in params.iter() {
        if !first_param {
            bytes.push(b';');
        }
        first_param = false;
        let mut first_sub = true;
        for &sub in param {
            if !first_sub {
                bytes.push(b':');
            }
            first_sub = false;
            bytes.extend_from_slice(sub.to_string().as_bytes());
        }
    }
    for &b in intermediates {
        bytes.push(b);
    }
    bytes.push(action as u8);
    bytes
}

/// Width-preserving translate helper: translates text and adjusts width
/// to match original display width, preserving column alignment.
/// - Shorter translation → pad with spaces
/// - Longer translation → truncate to fit original width
fn translate_width_preserving(engine: &TranslationEngine, text: &str) -> Option<String> {
    engine.translate_line(text).map(|translated| {
        let orig_width = UnicodeWidthStr::width(text);
        let trans_width = UnicodeWidthStr::width(translated.as_str());
        if trans_width < orig_width {
            // Pad shorter translations
            let padding = " ".repeat(orig_width - trans_width);
            format!("{}{}", translated, padding)
        } else if trans_width > orig_width {
            // Truncate longer translations to preserve column alignment
            truncate_to_width(&translated, orig_width)
        } else {
            translated
        }
    })
}

/// Truncate a string to fit within a given display width,
/// respecting CJK double-width characters.
fn truncate_to_width(s: &str, max_width: usize) -> String {
    use unicode_width::UnicodeWidthChar;
    let mut result = String::new();
    let mut current_width = 0;
    for c in s.chars() {
        let w = UnicodeWidthChar::width(c).unwrap_or(0);
        if current_width + w > max_width {
            break;
        }
        result.push(c);
        current_width += w;
    }
    // Pad remaining space if CJK truncation left a gap
    if current_width < max_width {
        result.push_str(&" ".repeat(max_width - current_width));
    }
    result
}

impl VtPerformer {
    fn new(engine: Arc<TranslationEngine>) -> Self {
        Self {
            engine,
            text_buf: String::new(),
            ansi_prefix: Vec::new(),
            output: Vec::new(),
            has_text: false,
            cwd_change: None,
        }
    }

    /// Flush the accumulated text buffer through the translation engine.
    fn flush_text(&mut self) {
        if self.text_buf.is_empty() {
            return;
        }

        let original = std::mem::take(&mut self.text_buf);

        if let Some(translated) = translate_width_preserving(&self.engine, &original) {
            self.output.extend_from_slice(translated.as_bytes());
        } else {
            self.output.extend_from_slice(original.as_bytes());
        }

        self.has_text = false;
    }

    /// Flush any remaining ANSI prefix bytes that weren't followed by text.
    fn flush_ansi(&mut self) {
        if !self.ansi_prefix.is_empty() {
            self.output.extend_from_slice(&self.ansi_prefix);
            self.ansi_prefix.clear();
        }
    }
}

impl vte::Perform for VtPerformer {
    fn print(&mut self, c: char) {
        self.flush_ansi();
        self.text_buf.push(c);
        self.has_text = true;
    }

    fn execute(&mut self, byte: u8) {
        match byte {
            b'\n' => {
                self.flush_ansi();
                self.flush_text();
                self.output.push(b'\n');
            }
            b'\r' => {
                self.flush_ansi();
                self.flush_text();
                self.output.push(b'\r');
            }
            _ => {
                self.flush_ansi();
                self.flush_text();
                self.output.push(byte);
            }
        }
    }

    fn csi_dispatch(
        &mut self,
        params: &vte::Params,
        intermediates: &[u8],
        _ignore: bool,
        action: char,
    ) {
        // Flush text and ANSI before emitting CSI
        self.flush_text();
        self.flush_ansi();

        // Detect alternate screen buffer
        if intermediates == [b'?'] {
            for param in params.iter() {
                for &sub in param {
                    if (sub == 1049 || sub == 47) && action == 'h' {
                        self.engine.set_alternate_screen(true);
                    } else if (sub == 1049 || sub == 47) && action == 'l' {
                        self.engine.set_alternate_screen(false);
                    }
                }
            }
        }

        // Reconstruct and pass through
        let csi_bytes = reconstruct_csi(params, intermediates, action);
        self.output.extend_from_slice(&csi_bytes);
    }

    fn esc_dispatch(&mut self, intermediates: &[u8], _ignore: bool, byte: u8) {
        self.flush_text();
        self.flush_ansi();
        self.output.push(0x1b);
        for &b in intermediates {
            self.output.push(b);
        }
        self.output.push(byte);
    }

    fn osc_dispatch(&mut self, params: &[&[u8]], _bell_terminated: bool) {
        self.flush_text();
        self.flush_ansi();

        // OSC 7 — Shell CWD notification
        if params.first().map(|p| *p == b"7").unwrap_or(false) {
            if let Some(url_bytes) = params.get(1) {
                if let Ok(url) = std::str::from_utf8(url_bytes) {
                    let path = if let Some(rest) = url.strip_prefix("file://") {
                        // Format: file://<hostname>/<path> or file:///<path>
                        // On Linux:  file://hostname/home/user  or  file:///home/user
                        // On Windows: file:///C:/Users/...
                        if rest.starts_with('/') {
                            // file:///path — no hostname
                            // On Windows: rest = "/C:/Users/..." → strip leading /
                            // On Linux:   rest = "/home/user" → keep as-is
                            #[cfg(target_os = "windows")]
                            {
                                // Strip the leading "/" for Windows drive paths like /C:/Users
                                let trimmed = rest.strip_prefix('/').unwrap_or(rest);
                                trimmed.to_string()
                            }
                            #[cfg(not(target_os = "windows"))]
                            {
                                rest.to_string() // "/home/user" — already absolute
                            }
                        } else {
                            // file://hostname/path — extract path after hostname
                            rest.splitn(2, '/').nth(1)
                                .map(|p| format!("/{}", p))
                                .unwrap_or_default()
                        }
                    } else {
                        url.to_string()
                    };

                    // Full percent-decoding for URL-encoded paths
                    let decoded = percent_decode(&path);
                    if !decoded.is_empty() {
                        self.cwd_change = Some(decoded);
                    }
                }
            }
            return; // OSC 7 is invisible
        }

        self.output.push(0x1b);
        self.output.push(b']');
        for (i, param) in params.iter().enumerate() {
            if i > 0 {
                self.output.push(b';');
            }
            self.output.extend_from_slice(param);
        }
        self.output.push(0x07);
    }

    fn hook(&mut self, _params: &vte::Params, _intermediates: &[u8], _ignore: bool, _action: char) {}
    fn unhook(&mut self) {}
    fn put(&mut self, _byte: u8) {}
}

impl VtProcessor {
    /// Create a new VT processor with the given translation engine.
    pub fn new(engine: Arc<TranslationEngine>) -> Self {
        let performer = VtPerformer::new(engine);
        Self {
            parser: vte::Parser::new(),
            performer,
        }
    }

    /// Process a chunk of raw PTY bytes.
    /// Returns the processed output and an optional CWD change detected via OSC 7.
    pub fn process(&mut self, input: &[u8]) -> (Vec<u8>, Option<String>) {
        self.performer.output.clear();
        self.performer.cwd_change = None;

        for &byte in input {
            self.parser.advance(&mut self.performer, byte);
        }

        // Flush any remaining buffered text at end of chunk
        self.performer.flush_text();
        self.performer.flush_ansi();

        (self.performer.output.clone(), self.performer.cwd_change.clone())
    }
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

/// Seeds default dictionaries into ~/.CoffeeCLI/dictionaries/ on first run.
/// Uses directory structure: tool-name/_config.json + lang.json
pub fn bootstrap_dictionaries() {
    let Some(home) = dirs::home_dir() else { return };
    let dict_dir = home.join(".coffee-cli").join("dictionaries");

    // Define tool directories and their files
    let tools: &[(&str, &[(&str, &str)])] = &[
        ("claude-code", &[
            ("_config.json", include_str!("dictionaries/claude-code/_config.json")),
            ("zh-CN.json", include_str!("dictionaries/claude-code/zh-CN.json")),
        ]),
    ];

    for (tool_name, files) in tools {
        let tool_dir = dict_dir.join(tool_name);
        if let Err(e) = std::fs::create_dir_all(&tool_dir) {
            eprintln!("[Translation] Could not create dir {}: {}", tool_name, e);
            continue;
        }

        for (filename, content) in *files {
            let path = tool_dir.join(filename);
            // Always overwrite from embedded source to keep in sync with updates
            if let Err(e) = std::fs::write(&path, content) {
                eprintln!("[Translation] Failed to write {}/{}: {}", tool_name, filename, e);
            }
        }
    }
}

/// Get the dictionaries directory path.
pub fn dictionaries_dir() -> Option<std::path::PathBuf> {
    dirs::home_dir().map(|h| h.join(".coffee-cli").join("dictionaries"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_vt_processor() {
        let engine = TranslationEngine::load(std::path::Path::new("none"), "en");
        let mut vt = VtProcessor::new(engine);

        let input = b"\x1b[32mhello\x1b[0m world\r\nPS D:\\> ";
        let (output, _) = vt.process(input);
        
        println!("PROCESSED OUTPUT: {:?}", String::from_utf8_lossy(&output));
        assert_eq!(output, input); // Ensure it perfectly preserves
    }

    #[test]
    fn test_claude_translation() {
        let entry = compile_pattern("Welcome back!", "欢迎回来！").unwrap();
        
        let mut lang_entries = HashMap::new();
        lang_entries.insert("zh-CN".to_string(), vec![entry]);

        let dict = ToolDictionary {
            tool: "claude-code".to_string(),
            detection_commands: vec!["claude".to_string()],
            detection_patterns: vec![],
            lang_entries,
        };

        // Test exact match
        assert_eq!(dict.translate("Welcome back!", "zh-CN"), Some("欢迎回来！".to_string()));
        // No match for other language
        assert_eq!(dict.translate("Welcome back!", "ja"), None);

        let engine = Arc::new(TranslationEngine {
            dictionaries: vec![dict],
            active_tool: std::sync::Mutex::new(Some("claude-code".to_string())),
            target_lang: std::sync::Mutex::new("zh-CN".to_string()),
            enabled: std::sync::Mutex::new(true),
            in_alternate_screen: std::sync::Mutex::new(false),
        });

        let mut vt = VtProcessor::new(engine);
        let input = b"\x1b[38;2;255;100;100m  Welcome back!  \x1b[0m\r\n";
        let (output, _) = vt.process(input);
        
        println!("TRANSLATED: {:?}", String::from_utf8_lossy(&output));
    }
}
