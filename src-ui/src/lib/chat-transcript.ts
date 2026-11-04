export type ChatRole = 'user' | 'assistant' | 'reasoning' | 'tool' | 'notice';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  toolName?: string;
  toolStatus?: 'running' | 'done' | 'failed';
}

export interface ChatTranscriptState {
  messages: ChatMessage[];
  remainder: string;
  nextLineIndex: number;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const INJECTED_PREFIXES = [
  '<environment_context>', '<ide_opened_file>', '<ide_closed_file>',
  '<ide_selection>', '<system-reminder>', '<command-message>', '<command-name>',
  '# AGENTS.md', 'Run your Session Startup sequence',
  'Below is a conversation log from a Claude Code coding session',
];

// Claude records completed sub-agent reports as external `user` rows even
// though they are protocol notifications. Only treat the tag as structural at
// the beginning of a message so a real user can still discuss the tag itself.
const INJECTED_START_ONLY_PREFIXES = ['<task-notification>'];

export function normalizePrompt(text: string): string {
  return text
    .replace(/"\s+((?:[A-Za-z]:[\\/]|\/)[^"]+?\.(?:png|jpe?g|gif|webp|bmp))\s+"/gi, '$1')
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
}

function isInjected(text: string): boolean {
  const trimmed = text.trim();
  return INJECTED_PREFIXES.some(prefix => trimmed.startsWith(prefix) || trimmed.includes(prefix)) ||
    INJECTED_START_ONLY_PREFIXES.some(prefix => trimmed.startsWith(prefix));
}

function stringValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (Array.isArray(value)) {
    return value.map(item => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object' && 'text' in item) {
        return stringValue((item as { text: unknown }).text);
      }
      return stringValue(item);
    }).filter(Boolean).join('\n');
  }
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function push(
  out: ChatMessage[], message: ChatMessage, previousCount: number, owned: Set<number>,
) {
  if (!message.content.trim()) return;
  const previousIndex = out.length - 1;
  let previous = out[previousIndex];
  if (previous && previous.role === message.role && message.role !== 'tool' &&
      previous.id.split(':')[0] === message.id.split(':')[0]) {
    if (previousIndex < previousCount && !owned.has(previousIndex)) {
      previous = { ...previous };
      out[previousIndex] = previous;
      owned.add(previousIndex);
    }
    previous.content += `\n\n${message.content}`;
    return;
  }
  out.push(message);
}

function parseBlocks(
  out: ChatMessage[], blocks: unknown, role: 'user' | 'assistant', rowId: string,
  toolById: Map<string, number>, previousCount: number, owned: Set<number>,
) {
  const values = Array.isArray(blocks) ? blocks : [blocks];
  values.forEach((raw, index) => {
    if (typeof raw === 'string') {
      if (!isInjected(raw)) push(out, { id: `${rowId}:${index}`, role, content: raw }, previousCount, owned);
      return;
    }
    if (!raw || typeof raw !== 'object') return;
    const block = raw as JsonObject;
    const type = String(block.type ?? 'text');
    if (['text', 'input_text', 'output_text'].includes(type) || (!block.type && block.text)) {
      const text = stringValue(block.text ?? block.content);
      if (!isInjected(text)) push(out, { id: `${rowId}:${index}`, role, content: text }, previousCount, owned);
    } else if (type === 'thinking' || type === 'reasoning') {
      push(out, { id: `${rowId}:${index}`, role: 'reasoning', content: stringValue(block.thinking ?? block.text ?? block.summary) }, previousCount, owned);
    } else if (type === 'tool_use' || type === 'function_call' || type === 'custom_tool_call') {
      // Codex emits both an item `id` and a `call_id`; its corresponding
      // function_call_output references call_id. Claude only has `id`, so
      // preferring call_id links both formats correctly. CodeBuddy camel-cases
      // the same field (`callId`) and pairs it with a `function_call_result`
      // row, which the result branch below links the same way.
      const id = String(block.call_id ?? block.callId ?? block.id ?? `${rowId}:${index}`);
      const message: ChatMessage = {
        id,
        role: 'tool',
        toolName: String(block.name ?? block.tool_name ?? 'Tool'),
        content: stringValue(block.input ?? block.arguments ?? block.command),
        toolStatus: 'running',
      };
      out.push(message);
      toolById.set(id, out.length - 1);
    } else if (type === 'tool_result' || type === 'function_call_output' || type === 'function_call_result' || type === 'custom_tool_call_output') {
      const id = String(block.tool_use_id ?? block.call_id ?? block.callId ?? block.id ?? '');
      const targetIndex = toolById.get(id);
      // `status` covers CodeBuddy's function_call_result rows, which flag a
      // failed tool with status "incomplete" and carry no is_error field.
      const failed = block.is_error === true || block.error != null ||
        block.status === 'incomplete' || block.status === 'failed';
      if (targetIndex !== undefined) {
        const status = failed ? 'failed' : 'done';
        if (out[targetIndex].toolStatus !== status) {
          if (targetIndex < previousCount && !owned.has(targetIndex)) {
            out[targetIndex] = { ...out[targetIndex] };
            owned.add(targetIndex);
          }
          out[targetIndex].toolStatus = status;
        }
      }
    }
  });
}

function parseLine(
  out: ChatMessage[], toolById: Map<string, number>, line: string, lineIndex: number,
  previousCount: number, owned: Set<number>,
) {
    if (!line.trim()) return;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { return; }
    if (!isObject(parsed)) return;
    const root = parsed;
    const message = isObject(root.message) ? root.message : null;
    const payload = isObject(root.payload) ? root.payload : null;
    const rowId = String(root.uuid ?? root.id ?? message?.id ?? payload?.id ?? lineIndex);

    // Hermes legacy sessions are one JSON document rather than JSONL:
    // `{ session_id, messages: [{ role, content }, ...] }`. The history
    // scanner still surfaces these files, so normalize their root-level array
    // before entering the per-row protocol branches below.
    if (Array.isArray(root.messages)) {
      root.messages.forEach((rawMessage, index) => {
        if (!isObject(rawMessage)) return;
        if (rawMessage.role !== 'user' && rawMessage.role !== 'assistant') return;
        parseBlocks(
          out,
          rawMessage.content,
          rawMessage.role,
          `${rowId}:message-${index}`,
          toolById,
          previousCount,
          owned,
        );
      });
      return;
    }

    // Codex rollout rows place messages and tool calls under payload.
    if (payload) {
      if (payload.type === 'message' && (payload.role === 'user' || payload.role === 'assistant')) {
        parseBlocks(out, payload.content, payload.role, rowId, toolById, previousCount, owned);
      } else if (['function_call', 'custom_tool_call', 'function_call_output', 'function_call_result', 'custom_tool_call_output', 'reasoning'].includes(String(payload.type))) {
        parseBlocks(out, payload, 'assistant', rowId, toolById, previousCount, owned);
      }
      return;
    }

    // Kimi Code's wire protocol records user messages under
    // context.append_message and streamed assistant parts as loop events.
    // The generic message branch below handles the former; normalize the
    // latter here before it falls through the root-role checks.
    if (root.type === 'context.append_loop_event' && isObject(root.event)) {
      const event = root.event;
      if (event.type === 'content.part' && isObject(event.part)) {
        const part = event.part;
        if (part.type === 'think') {
          push(out, { id: rowId, role: 'reasoning', content: stringValue(part.think) }, previousCount, owned);
        } else if (part.type === 'text') {
          push(out, { id: rowId, role: 'assistant', content: stringValue(part.text) }, previousCount, owned);
        }
      }
      return;
    }

    if (message && Array.isArray(message.parts)) {
      parseBlocks(out, message.parts, message.role === 'user' ? 'user' : 'assistant', rowId, toolById, previousCount, owned);
      return;
    }
    if (message?.role === 'user' || message?.role === 'assistant') {
      parseBlocks(out, message.content, message.role === 'user' ? 'user' : 'assistant', rowId, toolById, previousCount, owned);
      return;
    }

    // Antigravity/Gemini and several wire protocols use root-level roles.
    if (root.type === 'reasoning') {
      push(out, { id: rowId, role: 'reasoning', content: stringValue(root.summary ?? root.content) }, previousCount, owned);
      return;
    }
    const rootRole = root.role ?? root.type;
    if (rootRole === 'user' || rootRole === 'assistant' || rootRole === 'gemini') {
      if (rootRole === 'user' && root.synthetic_reason) return;
      const role = rootRole === 'user' ? 'user' : 'assistant';
      const data = isObject(root.data) ? root.data : null;
      parseBlocks(out, root.content ?? root.parts ?? root.text ?? data?.content, role, rowId, toolById, previousCount, owned);
    }
}

/** Parse an initial transcript or append a byte-aligned JSONL tail. Keeping
 * parser state means a long live session never needs to be reparsed merely
 * because one more row was appended; tool results can still update tool calls
 * that arrived in an earlier chunk. */
export function updateChatTranscript(
  raw: string,
  previous?: ChatTranscriptState,
): ChatTranscriptState {
  // The array itself is copied so React sees an append, but settled message
  // objects retain their identity. Only a merged live tail or a tool whose
  // status changed is cloned on write; long sessions therefore avoid an O(n)
  // object allocation burst on every streamed chunk.
  const out = previous ? [...previous.messages] : [];
  const previousCount = out.length;
  const owned = new Set<number>();
  const toolById = new Map<string, number>();
  out.forEach((message, index) => {
    if (message.role === 'tool') toolById.set(message.id, index);
  });

  const combined = `${previous?.remainder ?? ''}${raw}`;
  const lines = combined.split(/\r?\n/);
  let remainder = '';
  if (lines.length > 0 && !combined.endsWith('\n')) {
    const trailing = lines.pop() ?? '';
    // Most writers flush a complete JSON object before its newline. Parse a
    // valid trailing row immediately; retain only genuinely partial JSON.
    try {
      JSON.parse(trailing);
      lines.push(trailing);
    } catch {
      remainder = trailing;
    }
  }

  let nextLineIndex = previous?.nextLineIndex ?? 0;
  lines.forEach(line => {
    parseLine(out, toolById, line, nextLineIndex, previousCount, owned);
    nextLineIndex += 1;
  });

  return { messages: out, remainder, nextLineIndex };
}

export function transcriptHasPrompt(messages: ChatMessage[], prompt: string): boolean {
  const target = normalizePrompt(prompt);
  return !!target && messages.some(message =>
    message.role === 'user' && normalizePrompt(message.content) === target
  );
}
