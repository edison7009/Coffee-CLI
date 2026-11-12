// Applies desktop session events with the desktop's own reducers (src-ui/src/shared/conversation),
// so the phone shows the same conversation the desktop does.
import { emptyClaudeState, reduceClaudeEvent, type ClaudeState } from '../../src-ui/src/shared/conversation/claude-protocol';
import { emptyCodexState, reduceCodexEvent, type CodexState } from '../../src-ui/src/shared/conversation/codex-protocol';
import { emptyOpenCodeState, openCodeRows, reduceOpenCodeEvent, type OpenCodeState } from '../../src-ui/src/shared/conversation/opencode-protocol';
import { emptyPiState, reducePiEvent, type PiState } from '../../src-ui/src/shared/conversation/pi-protocol';
import { emptyDshState, reduceDshNotification, type DshState } from '../../src-ui/src/shared/conversation/dsh-protocol';
import type { ChatMessage } from '../../src-ui/src/shared/conversation/chat-transcript';

export type Kind = 'claude' | 'codex' | 'opencode' | 'pi' | 'dsh';
export type ConversationState =
  | { kind: 'claude'; state: ClaudeState } | { kind: 'codex'; state: CodexState } | { kind: 'opencode'; state: OpenCodeState }
  | { kind: 'pi'; state: PiState } | { kind: 'dsh'; state: DshState };
type Json = Record<string, unknown>;

export function emptyConversation(kind: Kind): ConversationState {
  switch (kind) {
    case 'claude': return { kind, state: emptyClaudeState() };
    case 'codex': return { kind, state: emptyCodexState() };
    case 'opencode': return { kind, state: emptyOpenCodeState() };
    case 'pi': return { kind, state: emptyPiState() };
    case 'dsh': return { kind, state: emptyDshState() };
  }
}

/** Skips events a reducer rejects instead of losing the whole view. */
export function applyEvent(current: ConversationState, event: Json): ConversationState {
  try {
    switch (current.kind) {
      case 'claude': return { kind: 'claude', state: reduceClaudeEvent(current.state, event as never) };
      case 'codex': return { kind: 'codex', state: reduceCodexEvent(current.state, event as never) };
      case 'opencode': return { kind: 'opencode', state: reduceOpenCodeEvent(current.state, event as never) };
      case 'pi': return { kind: 'pi', state: reducePiEvent(current.state, event as never) };
      case 'dsh': return { kind: 'dsh', state: reduceDshNotification(current.state, event as never) };
    }
  } catch { return current; }
}

export interface Row extends ChatMessage { partial?: boolean }

export function rows(current: ConversationState): Row[] {
  if (current.kind === 'opencode') return openCodeRows(current.state.native);
  return current.state.messages as Row[];
}

export function isBusy(current: ConversationState): boolean { return current.state.busy; }
export function title(current: ConversationState): string { return current.state.title ?? ''; }
