// llm-translate.ts — LLM On-Demand Translation Service
// Extracts text segments from terminal screen → generates hash keys →
// sends JSON to LLM → returns dictionary entries for the existing render pipeline.
// Supports any OpenAI-compatible API (OpenAI, DeepSeek, Ollama, etc.)

import type { Terminal } from '@xterm/xterm';
import type { TranslationEntry } from './coffee-translation';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface LLMConfig {
  baseUrl: string;   // API endpoint (e.g. "https://api.openai.com/v1")
  apiKey: string;    // API key
  model: string;     // Model name (e.g. "gpt-4o-mini", "deepseek-chat")
}

const STORAGE_KEY = 'coffee_llm_config';

// ─── Config Persistence ──────────────────────────────────────────────────────

export function saveLLMConfig(config: LLMConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch { /* ignore */ }
}

export function loadLLMConfig(): LLMConfig | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed.baseUrl && parsed.apiKey) return parsed as LLMConfig;
    return null;
  } catch {
    return null;
  }
}

export function hasLLMConfig(): boolean {
  return loadLLMConfig() !== null;
}

// ─── Language Labels ─────────────────────────────────────────────────────────

export const TRANSLATE_LANGUAGES = [
  { code: 'zh-CN', label: '简体中文', flag: '简' },
  { code: 'zh-TW', label: '繁體中文', flag: '繁' },
  { code: 'ja', label: '日本語', flag: 'あ' },
  { code: 'ko', label: '한국어', flag: '한' },
  { code: 'es', label: 'Español', flag: 'Es' },
  { code: 'fr', label: 'Français', flag: 'Fr' },
  { code: 'de', label: 'Deutsch', flag: 'De' },
  { code: 'pt', label: 'Português', flag: 'Pt' },
  { code: 'ru', label: 'Русский', flag: 'Ру' },
] as const;

// ─── Hash Generation ─────────────────────────────────────────────────────────

/** Simple djb2 hash → 6-char hex string */
function hashText(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(6, '0').slice(-6);
}

// ─── Text Segment Extraction ─────────────────────────────────────────────────

interface TextSegment {
  hash: string;
  text: string;
}

/**
 * Check if text looks like code / file path / URL — should NOT be translated.
 */
function isCodeLike(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  // Pure whitespace or very short
  if (t.length < 4) return true;
  // File paths
  if (/^[A-Z]:\\/.test(t) || t.startsWith('/') || t.startsWith('~')) return true;
  // URLs
  if (/^https?:\/\//.test(t)) return true;
  // Pure symbols / box-drawing
  if (/^[─│╭╮╰╯┌┐└┘├┤┬┴┼━┃╋═║╔╗╚╝╠╣╦╩╬\s\-_=+*#|.<>:;,/\\()[\]{}]+$/.test(t)) return true;
  // Looks like a command or path (starts with / or has no spaces)
  if (t.startsWith('/') && !t.includes(' ')) return true;
  // Pure numbers / version strings
  if (/^[\d.\-v]+$/.test(t)) return true;
  return false;
}

/**
 * Extract translatable text segments from terminal screen.
 * Skips code, paths, URLs, box-drawing characters.
 * Returns unique segments with hash keys.
 */
export function extractTextSegments(terminal: Terminal): TextSegment[] {
  const buffer = terminal.buffer.active;
  const seen = new Set<string>();
  const segments: TextSegment[] = [];

  for (let r = 0; r < terminal.rows; r++) {
    const line = buffer.getLine(r + buffer.viewportY);
    if (!line) continue;

    const lineText = line.translateToString(false).trimEnd();
    if (!lineText.trim()) continue;

    // Split line into "words" / meaningful phrases
    // Strategy: extract contiguous runs of natural language text
    // by splitting on multiple spaces (column separators in TUI frameworks)
    const parts = lineText.split(/\s{3,}/);

    for (const part of parts) {
      const trimmed = part.trim();
      if (isCodeLike(trimmed)) continue;
      // Must contain at least one letter (not pure punctuation/numbers)
      if (!/[a-zA-Z]/.test(trimmed)) continue;

      // Deduplicate
      if (seen.has(trimmed)) continue;
      seen.add(trimmed);

      const hash = hashText(trimmed);
      segments.push({ hash, text: trimmed });
    }
  }

  return segments;
}

// ─── LLM Translation ────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a terminal text translator. You receive a JSON object where keys are hash IDs and values are English text segments from a terminal screen.

Rules:
- Translate ONLY the natural language text to the target language
- Return a JSON object with the SAME keys and translated values
- Keep ALL code, file paths, URLs, commands, variable names unchanged
- If a value is code or a technical term, return it unchanged
- Be concise — terminal space is limited
- Output ONLY valid JSON, nothing else — no markdown, no explanation, no XML tags`;

/**
 * Translate text segments using user's LLM API.
 * Sends JSON { hash: text } → receives JSON { hash: translation }.
 * Returns TranslationEntry[] ready for the dictionary render pipeline.
 */
export async function translateSegments(
  segments: TextSegment[],
  targetLang: string,
  config: LLMConfig,
  signal?: AbortSignal,
): Promise<TranslationEntry[]> {
  if (segments.length === 0) return [];

  const langLabel = TRANSLATE_LANGUAGES.find(l => l.code === targetLang)?.label || targetLang;

  // Build input JSON: { hash: text }
  const input: Record<string, string> = {};
  for (const seg of segments) {
    input[seg.hash] = seg.text;
  }

  // Normalize base URL
  const baseUrl = config.baseUrl.replace(/\/+$/, '');
  const endpoint = baseUrl.endsWith('/chat/completions')
    ? baseUrl
    : `${baseUrl}/chat/completions`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Translate values to ${langLabel}:\n${JSON.stringify(input, null, 2)}` },
      ],
      temperature: 0.3,
      max_tokens: 4096,
    }),
    signal,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`LLM API error ${response.status}: ${errText.slice(0, 200)}`);
  }

  const data = await response.json();
  let content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('LLM returned empty response');
  }

  // Strip <think>...</think> tags and markdown code fences
  content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  content = content.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();

  // Parse LLM response JSON
  let translated: Record<string, string>;
  try {
    translated = JSON.parse(content);
  } catch {
    throw new Error(`LLM returned invalid JSON: ${content.slice(0, 200)}`);
  }

  // Convert to TranslationEntry[] — map hash back to original text
  const results: TranslationEntry[] = [];
  for (const seg of segments) {
    const trans = translated[seg.hash];
    if (trans && trans !== seg.text) {
      results.push({
        pattern: seg.text,
        translation: trans,
      });
    }
  }

  return results;
}
