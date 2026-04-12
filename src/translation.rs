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

use aho_corasick::AhoCorasick;
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
    /// Original pattern text from JSON, preserved for CoffeeOverlay frontend.
    #[allow(dead_code)]
    raw_pattern: String,
}

pub struct ToolDictionary {
    pub tool: String,
    detection_commands: Vec<String>,
    detection_patterns: Vec<String>,
    /// Fast path: exact string lookup (O(1) HashMap)
    lang_exact: HashMap<String, HashMap<String, String>>,
    /// Slow path: parameterized patterns with regex (only for {variable} patterns)
    lang_regex: HashMap<String, Vec<CompiledEntry>>,
    /// Aho-Corasick automaton for substring matching per language
    lang_aho: HashMap<String, (AhoCorasick, Vec<(String, String)>)>,
    /// Original entries for frontend export
    lang_raw: HashMap<String, Vec<(String, String)>>,
}

impl ToolDictionary {
    /// Try to translate a single line of plain text using this dictionary.
    /// Fast path: O(1) HashMap lookup. Slow path: regex for parameterized patterns.
    pub fn translate(&self, text: &str, lang: &str) -> Option<String> {
        // Fast path: exact HashMap lookup
        if let Some(exact_map) = self.lang_exact.get(lang) {
            if let Some(translation) = exact_map.get(text) {
                return Some(translation.clone());
            }
        }
        // Slow path: regex for parameterized patterns (if any)
        if let Some(entries) = self.lang_regex.get(lang) {
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
        }
        None
    }

    /// Aho-Corasick based substring translation.
    /// Scans text for all known patterns in a single pass and replaces them.
    #[allow(dead_code)]
    pub fn translate_substring_ac(&self, text: &str, lang: &str) -> Option<String> {
        let (ac, patterns) = self.lang_aho.get(lang)?;
        let mut result = text.to_string();
        let mut found = false;
        // Collect matches first, then apply longest-first
        let mut matches: Vec<(usize, usize, &str)> = Vec::new();
        for mat in ac.find_iter(text) {
            matches.push((mat.start(), mat.pattern().as_usize(), &patterns[mat.pattern().as_usize()].1));
        }
        if matches.is_empty() {
            return None;
        }
        // Apply replacements in reverse to preserve offsets
        // Sort by position descending
        matches.sort_by(|a, b| b.0.cmp(&a.0));
        for (start, pat_idx, translation) in &matches {
            let pattern = &patterns[*pat_idx].0;
            let end = start + pattern.len();
            if end <= result.len() && &result[*start..end] == pattern.as_str() {
                result.replace_range(*start..end, translation);
                found = true;
            }
        }
        found.then_some(result)
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
            raw_pattern: pattern.to_string(),
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
                            let exact_count: usize = dict.lang_exact.values().map(|m| m.len()).sum();
                            let regex_count: usize = dict.lang_regex.values().map(|v| v.len()).sum();
                            let langs: Vec<&String> = dict.lang_exact.keys().collect();
                            eprintln!("[Translation] Loaded tool '{}': {} exact + {} regex entries, langs={:?}",
                                dict.tool, exact_count, regex_count, langs);
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

    /// Get the current target language
    #[allow(dead_code)]
    pub fn get_lang(&self) -> String {
        self.target_lang.lock().unwrap().clone()
    }

    /// Enable or disable translation
    #[allow(dead_code)]
    pub fn set_enabled(&self, enabled: bool) {
        let mut e = self.enabled.lock().unwrap();
        *e = enabled;
    }

    /// Notify the engine that an alternate screen buffer was entered/exited.
    /// When in alternate screen (full-screen mode), translation is bypassed.
    pub fn set_alternate_screen(&self, active: bool) {
        let mut a = self.in_alternate_screen.lock().unwrap();
        if active != *a {
            *a = active;
            if active {
                eprintln!("[Translation] Full-screen mode detected — translation paused");
            } else {
                eprintln!("[Translation] Full-screen mode exited — translation resumed");
            }
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

        // Note: alternate screen detection is tracked but no longer blocks translation.

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
                // 1. Try exact full-line match first (fastest, most precise)
                //    Try both trimmed and with leading space (many patterns start with " to ...")
                if let Some(translated) = dict.translate(trimmed, &lang) {
                    let leading: String = line.chars().take_while(|c| c.is_whitespace()).collect();
                    return Some(format!("{}{}", leading, translated));
                }
                // Also try with leading space preserved — many fragment patterns
                // like " to jump to ..." start with a space that trim() removes.
                let with_space = format!(" {}", trimmed);
                if let Some(translated) = dict.translate(&with_space, &lang) {
                    let leading: String = line.chars().take_while(|c| c.is_whitespace()).collect();
                    // The translation likely starts with a space too, so trim it
                    return Some(format!("{}{}", leading, translated.trim_start()));
                }

                // 2. Fallback: substring replacement for partial matches.
                // Essential for full-screen tools where text fragments are
                // embedded in longer lines (e.g. "Ask anything... \"prompt\"").
                let matches = self.find_substring_matches(trimmed);
                if !matches.is_empty() {
                    let leading: String = line.chars().take_while(|c| c.is_whitespace()).collect();
                    let mut result = trimmed.to_string();
                    // Apply replacements in reverse order to preserve byte offsets
                    for (offset, original, translated) in matches.iter().rev() {
                        let end = offset + original.len();
                        if end <= result.len() && &result[*offset..end] == original.as_str() {
                            result.replace_range(*offset..end, translated);
                        }
                    }
                    if result != trimmed {
                        return Some(format!("{}{}", leading, result));
                    }
                }
            }
        }

        None
    }

    /// Find all translatable substrings within a line of text using Aho-Corasick.
    /// Returns a list of (byte_offset, original_text, translated_text) for each match.
    /// Uses single-pass multi-pattern matching for O(text_len) performance.
    #[allow(dead_code)]
    pub fn find_substring_matches(&self, line: &str) -> Vec<(usize, String, String)> {
        let lang = self.target_lang.lock().unwrap().clone();
        if lang == "en" {
            return Vec::new();
        }

        let active_tool = self.active_tool.lock().unwrap().clone();
        let Some(tool_name) = &active_tool else {
            return Vec::new();
        };
        let Some(dict) = self.dictionaries.iter().find(|d| &d.tool == tool_name) else {
            return Vec::new();
        };
        let Some((ac, patterns)) = dict.lang_aho.get(&lang) else {
            return Vec::new();
        };

        let mut matches: Vec<(usize, String, String)> = Vec::new();
        for mat in ac.find_iter(line) {
            let abs_pos = mat.start();
            let (pattern, translation) = &patterns[mat.pattern().as_usize()];

            // ── Guard 1: Connective-word protection ──────────────────
            let is_connective = pattern.len() <= 6
                && (pattern.starts_with(' ') || pattern.starts_with(','))
                && (pattern.ends_with(' ') || pattern.ends_with(','));
            if is_connective && pattern.trim() != line.trim() {
                continue;
            }

            // ── Guard 2: Word boundary check for short patterns (≤ 8 chars) ──
            let needs_boundary = pattern.len() <= 8;
            let boundary_ok = if needs_boundary {
                let before_ok = abs_pos == 0 || {
                    let prev = line.as_bytes()[abs_pos - 1];
                    prev >= 0x80
                        || prev == b' ' || prev == b'\t' || prev == b'/' || prev == b'|'
                        || prev == b'(' || prev == b'[' || prev == b':'
                        || prev == b'\n' || prev == b'\r'
                };
                let end_pos = abs_pos + pattern.len();
                let after_ok = end_pos >= line.len() || {
                    let next = line.as_bytes()[end_pos];
                    next >= 0x80
                        || next == b' ' || next == b'\t' || next == b'/' || next == b'|'
                        || next == b')' || next == b']' || next == b':'
                        || next == b'\n' || next == b'\r' || next == b','
                        || next == b'.' || next == b';'
                };
                before_ok && after_ok
            } else {
                true
            };

            if boundary_ok {
                matches.push((abs_pos, pattern.clone(), translation.clone()));
            }
        }

        // Longest-match-first with overlap removal
        matches.sort_by(|a, b| b.1.len().cmp(&a.1.len()));
        let mut occupied: Vec<(usize, usize)> = Vec::new();
        let mut selected = Vec::new();
        for m in matches {
            let start = m.0;
            let end = start + m.1.len();
            let overlaps = occupied.iter().any(|(s, e)| start < *e && end > *s);
            if !overlaps {
                occupied.push((start, end));
                selected.push(m);
            }
        }
        selected.sort_by_key(|m| m.0);
        selected
    }

    /// Export raw pattern-translation pairs for the frontend CoffeeOverlay renderer.
    /// Returns Vec<(pattern, translation)> for the given tool and language.
    pub fn get_entries_for_frontend(&self, tool: &str, lang: &str) -> Vec<(String, String)> {
        for dict in &self.dictionaries {
            if dict.tool == tool {
                if let Some(raw) = dict.lang_raw.get(lang) {
                    return raw.clone();
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
    let mut lang_exact: HashMap<String, HashMap<String, String>> = HashMap::new();
    let mut lang_regex: HashMap<String, Vec<CompiledEntry>> = HashMap::new();
    let mut lang_aho: HashMap<String, (AhoCorasick, Vec<(String, String)>)> = HashMap::new();
    let mut lang_raw: HashMap<String, Vec<(String, String)>> = HashMap::new();

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

            match load_lang_file_split(&path) {
                Ok((exact, regex_entries, raw_pairs)) => {
                    // Build Aho-Corasick automaton from exact patterns
                    let ac_patterns: Vec<String> = raw_pairs.iter()
                        .filter(|(p, _)| !p.contains('{'))
                        .map(|(p, _)| p.clone())
                        .collect();
                    let ac_pairs: Vec<(String, String)> = raw_pairs.iter()
                        .filter(|(p, _)| !p.contains('{'))
                        .cloned()
                        .collect();
                    if !ac_patterns.is_empty() {
                        if let Ok(ac) = AhoCorasick::new(&ac_patterns) {
                            lang_aho.insert(lang.clone(), (ac, ac_pairs));
                        }
                    }

                    lang_exact.insert(lang.clone(), exact);
                    if !regex_entries.is_empty() {
                        lang_regex.insert(lang.clone(), regex_entries);
                    }
                    lang_raw.insert(lang, raw_pairs);
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
        lang_exact,
        lang_regex,
        lang_aho,
        lang_raw,
    })
}

/// Load entries from a per-language dictionary file, splitting into exact and regex.
/// Returns (exact_map, regex_entries, raw_pairs).
fn load_lang_file_split(path: &Path) -> anyhow::Result<(
    HashMap<String, String>,
    Vec<CompiledEntry>,
    Vec<(String, String)>,
)> {
    let content = std::fs::read_to_string(path)?;
    let file: LangDictFile = serde_json::from_str(&content)?;

    let mut exact_map = HashMap::new();
    let mut regex_entries = Vec::new();
    let mut raw_pairs = Vec::new();

    for entry_def in &file.entries {
        raw_pairs.push((entry_def.pattern.clone(), entry_def.translation.clone()));

        if entry_def.pattern.contains('{') {
            // Parameterized pattern → compile regex (slow path)
            if let Some(compiled) = compile_pattern(&entry_def.pattern, &entry_def.translation) {
                regex_entries.push(compiled);
            }
        } else {
            // Exact string → HashMap (fast path)
            exact_map.insert(entry_def.pattern.clone(), entry_def.translation.clone());
        }
    }

    // Sort regex entries by pattern length (longer = higher priority)
    regex_entries.sort_by(|a, b| b.regex.as_str().len().cmp(&a.regex.as_str().len()));

    Ok((exact_map, regex_entries, raw_pairs))
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

/// A segment of text within a single line, paired with its preceding ANSI bytes.
/// Example: for "\e[31mHello\e[0m World", segments would be:
///   (b"\e[31m", "Hello"), (b"\e[0m", " World")
#[derive(Clone)]
struct LineSegment {
    ansi: Vec<u8>,
    text: String,
}

struct VtPerformer {
    engine: Arc<TranslationEngine>,
    /// Accumulated segments for the current line.  
    /// Each CSI/ESC pushes a new segment boundary; print() appends to the last segment's text.
    line_segments: Vec<LineSegment>,
    /// ANSI bytes accumulated since the last text — will become the prefix of the next segment.
    pending_ansi: Vec<u8>,
    output: Vec<u8>,
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

/// Check if a CSI sequence is a pure SGR (Select Graphic Rendition) command.
/// SGR only changes text appearance (color, bold, underline, etc.) and does NOT
/// move the cursor or alter screen content. These are safe to defer.
fn is_sgr(params: &vte::Params, intermediates: &[u8], action: char) -> bool {
    // SGR = CSI {params} m  — with NO intermediates
    action == 'm' && intermediates.is_empty() && {
        // Validate all params are valid SGR values (0-107 range covers all standard SGR codes)
        params.iter().all(|p| p.iter().all(|&v| v <= 107))
    }
}

impl VtPerformer {
    fn new(engine: Arc<TranslationEngine>) -> Self {
        Self {
            engine,
            line_segments: Vec::new(),
            pending_ansi: Vec::new(),
            output: Vec::new(),
            cwd_change: None,
        }
    }

    /// Flush all accumulated line segments through the translation engine.
    /// 1. Concatenate all segment texts → full plain-text line
    /// 2. Try translation on the full line
    /// 3a. If translated: emit first segment's ANSI prefix + translated text (color is re-applied by caller)
    /// 3b. If not translated: emit all segments verbatim (preserving original per-word coloring)
    fn flush_line(&mut self) {
        if self.line_segments.is_empty() {
            // Only pending ANSI with no text — flush it directly
            if !self.pending_ansi.is_empty() {
                self.output.extend_from_slice(&self.pending_ansi);
                self.pending_ansi.clear();
            }
            return;
        }

        // Build the full plain-text line from all segments
        let full_text: String = self.line_segments.iter().map(|s| s.text.as_str()).collect();

        if let Some(translated) = translate_width_preserving(&self.engine, &full_text) {
            // Translation matched — emit with the first segment's ANSI prefix (primary color).
            // We cannot preserve per-word coloring because the translated text has
            // different structure/length, so we use the dominant color.
            if let Some(first) = self.line_segments.first() {
                self.output.extend_from_slice(&first.ansi);
            }
            self.output.extend_from_slice(translated.as_bytes());
        } else {
            // No translation — pass through all segments verbatim
            for seg in &self.line_segments {
                self.output.extend_from_slice(&seg.ansi);
                self.output.extend_from_slice(seg.text.as_bytes());
            }
        }

        self.line_segments.clear();
        // Don't clear pending_ansi — it belongs to the NEXT line's first segment
    }

    /// Ensure there is an active segment to append text to.
    /// If pending_ansi has bytes, they become the new segment's ANSI prefix.
    fn ensure_segment(&mut self) {
        // If there are no segments, or if pending_ansi has new ANSI bytes
        // (meaning a new color was applied), start a new segment.
        if self.line_segments.is_empty() || !self.pending_ansi.is_empty() {
            self.line_segments.push(LineSegment {
                ansi: std::mem::take(&mut self.pending_ansi),
                text: String::new(),
            });
        }
    }
}

impl vte::Perform for VtPerformer {
    fn print(&mut self, c: char) {
        self.ensure_segment();
        if let Some(last) = self.line_segments.last_mut() {
            last.text.push(c);
        }
    }

    fn execute(&mut self, byte: u8) {
        match byte {
            b'\n' | b'\r' => {
                // Line boundary — flush accumulated segments through translation
                self.flush_line();
                // Flush any trailing ANSI (e.g. color reset after last word)
                if !self.pending_ansi.is_empty() {
                    self.output.extend_from_slice(&self.pending_ansi);
                    self.pending_ansi.clear();
                }
                self.output.push(byte);
            }
            _ => {
                // Other control bytes (e.g. BEL, BS) — flush and pass through
                self.flush_line();
                if !self.pending_ansi.is_empty() {
                    self.output.extend_from_slice(&self.pending_ansi);
                    self.pending_ansi.clear();
                }
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
        // Detect alternate screen buffer (always process this regardless of SGR)
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

        let csi_bytes = reconstruct_csi(params, intermediates, action);

        if is_sgr(params, intermediates, action) {
            // SGR (color/style change) — DON'T flush text!
            // Buffer the ANSI bytes. They'll become the prefix of the next segment
            // when the next printable character arrives.
            self.pending_ansi.extend_from_slice(&csi_bytes);
        } else {
            // Non-SGR CSI (cursor movement, erase, scroll, etc.) — flush and pass through.
            // These change cursor position or screen content, so we must emit
            // the accumulated line first to keep visual alignment correct.
            self.flush_line();
            if !self.pending_ansi.is_empty() {
                self.output.extend_from_slice(&self.pending_ansi);
                self.pending_ansi.clear();
            }
            self.output.extend_from_slice(&csi_bytes);
        }
    }

    fn esc_dispatch(&mut self, intermediates: &[u8], _ignore: bool, byte: u8) {
        self.flush_line();
        if !self.pending_ansi.is_empty() {
            self.output.extend_from_slice(&self.pending_ansi);
            self.pending_ansi.clear();
        }
        self.output.push(0x1b);
        for &b in intermediates {
            self.output.push(b);
        }
        self.output.push(byte);
    }

    fn osc_dispatch(&mut self, params: &[&[u8]], _bell_terminated: bool) {
        self.flush_line();
        if !self.pending_ansi.is_empty() {
            self.output.extend_from_slice(&self.pending_ansi);
            self.pending_ansi.clear();
        }

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

        // Fast path: when target language is "en" (no translation), bypass the
        // VTE parser entirely. The parser's disassemble-reassemble cycle can
        // corrupt data (e.g. dropping bytes during CSI reconstruction), which
        // pollutes A1's buffer with garbled text.
        // We still need OSC 7 (CWD) and alternate screen detection, so do a
        // lightweight scan of the raw bytes instead.
        {
            let lang = self.performer.engine.target_lang.lock().unwrap().clone();
            if lang == "en" {
                self.detect_special_sequences(input);
                return (input.to_vec(), self.performer.cwd_change.clone());
            }
        }

        for &byte in input {
            self.parser.advance(&mut self.performer, byte);
        }

        // Flush any remaining buffered line segments at end of chunk
        self.performer.flush_line();
        if !self.performer.pending_ansi.is_empty() {
            self.performer.output.extend_from_slice(&self.performer.pending_ansi);
            self.performer.pending_ansi.clear();
        }

        (self.performer.output.clone(), self.performer.cwd_change.clone())
    }

    /// Lightweight scan for special sequences without full VTE parsing.
    /// Detects: alternate screen (CSI ?1049h/l, CSI ?47h/l) and OSC 7 (CWD).
    fn detect_special_sequences(&mut self, input: &[u8]) {
        let input_str = String::from_utf8_lossy(input);

        // Alternate screen detection
        if input_str.contains("\x1b[?1049h") || input_str.contains("\x1b[?47h") {
            self.performer.engine.set_alternate_screen(true);
        }
        if input_str.contains("\x1b[?1049l") || input_str.contains("\x1b[?47l") {
            self.performer.engine.set_alternate_screen(false);
        }

        // OSC 7 CWD detection: \x1b]7;file://...\x07
        if let Some(start) = input_str.find("\x1b]7;") {
            let rest = &input_str[start + 4..];
            if let Some(end) = rest.find('\x07').or_else(|| rest.find("\x1b\\")) {
                let url = &rest[..end];
                let path = if let Some(file_rest) = url.strip_prefix("file://") {
                    if file_rest.starts_with('/') {
                        #[cfg(target_os = "windows")]
                        {
                            let trimmed = file_rest.strip_prefix('/').unwrap_or(file_rest);
                            percent_decode(trimmed)
                        }
                        #[cfg(not(target_os = "windows"))]
                        {
                            percent_decode(file_rest)
                        }
                    } else {
                        file_rest.splitn(2, '/').nth(1)
                            .map(|p| percent_decode(&format!("/{}", p)))
                            .unwrap_or_default()
                    }
                } else {
                    url.to_string()
                };
                if !path.is_empty() {
                    self.performer.cwd_change = Some(path);
                }
            }
        }
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
            ("zh-TW.json", include_str!("dictionaries/claude-code/zh-TW.json")),
            ("ja.json", include_str!("dictionaries/claude-code/ja.json")),
            ("ko.json", include_str!("dictionaries/claude-code/ko.json")),
            ("es.json", include_str!("dictionaries/claude-code/es.json")),
            ("fr.json", include_str!("dictionaries/claude-code/fr.json")),
            ("de.json", include_str!("dictionaries/claude-code/de.json")),
            ("pt.json", include_str!("dictionaries/claude-code/pt.json")),
            ("ru.json", include_str!("dictionaries/claude-code/ru.json")),
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
        let mut lang_exact = HashMap::new();
        let mut exact_map = HashMap::new();
        exact_map.insert("Welcome back!".to_string(), "欢迎回来！".to_string());
        lang_exact.insert("zh-CN".to_string(), exact_map);

        let dict = ToolDictionary {
            tool: "claude-code".to_string(),
            detection_commands: vec!["claude".to_string()],
            detection_patterns: vec![],
            lang_exact,
            lang_regex: HashMap::new(),
            lang_aho: HashMap::new(),
            lang_raw: HashMap::new(),
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
