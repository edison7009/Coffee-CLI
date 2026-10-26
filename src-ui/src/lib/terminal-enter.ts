import type { Terminal } from '@xterm/xterm';
import type { ToolType } from '../store/app-state';

// These editors decode CSI-u Enter even without a keyboard-mode response.
const CSI_U_EDITORS = new Set<ToolType>(['claude', 'codex', 'opencode', 'mimocode', 'kilo', 'pi', 'omp']);

/** Preserve modified Enter only; do not advertise a complete keyboard protocol. */
export function createTerminalEnterEncoder(term: Terminal, tool: ToolType) {
  let win32 = false, modifyOtherKeys = 0;
  const modes = { normal: { flags: 0, stack: [] as number[] }, alternate: { flags: 0, stack: [] as number[] } };
  const current = () => modes[term.buffer.active.type];
  const reset = () => {
    win32 = false; modifyOtherKeys = 0;
    for (const mode of Object.values(modes)) { mode.flags = 0; mode.stack = []; }
  };
  const handlers = [
    ...(['h', 'l'] as const).map(final => term.parser.registerCsiHandler({ prefix: '?', final }, params => {
      if (params.includes(9001)) win32 = final === 'h';
      return false;
    })),
    term.parser.registerCsiHandler({ prefix: '>', final: 'm' }, params => {
      if (params[0] === 4) modifyOtherKeys = typeof params[1] === 'number' ? params[1] : 0;
      return false;
    }),
    term.parser.registerCsiHandler({ prefix: '>', final: 'u' }, params => {
      const mode = current();
      if (mode.stack.length === 16) mode.stack.shift();
      mode.stack.push(mode.flags);
      mode.flags = typeof params[0] === 'number' ? params[0] : 0;
      return false;
    }),
    term.parser.registerCsiHandler({ prefix: '<', final: 'u' }, params => {
      const mode = current(), count = typeof params[0] === 'number' ? Math.max(1, params[0]) : 1;
      if (count > mode.stack.length) { mode.flags = 0; mode.stack = []; }
      else for (let i = 0; i < count; i++) mode.flags = mode.stack.pop()!;
      return false;
    }),
    term.parser.registerCsiHandler({ prefix: '=', final: 'u' }, params => {
      const mode = current(), flags = typeof params[0] === 'number' ? params[0] : 0;
      mode.flags = params[1] === 2 ? mode.flags | flags : params[1] === 3 ? mode.flags & ~flags : flags;
      return false;
    }),
    term.parser.registerEscHandler({ final: 'c' }, () => { reset(); return false; }),
    term.parser.registerCsiHandler({ intermediates: '!', final: 'p' }, () => { reset(); return false; }),
  ];
  return {
    reset,
    dispose: () => handlers.forEach(handler => handler.dispose()),
    encode(event: KeyboardEvent): string | null {
      if (event.type !== 'keydown' || event.key !== 'Enter' || event.isComposing || event.keyCode === 229
        || event.altKey || event.metaKey || (!event.ctrlKey && !event.shiftKey)) return null;
      const modifiers = 1 + (event.shiftKey ? 1 : 0) + (event.ctrlKey ? 4 : 0);
      const encoded = current().flags > 0 ? `\x1b[13;${modifiers}u`
        : modifyOtherKeys > 0 ? `\x1b[27;${modifiers};13~`
        : CSI_U_EDITORS.has(tool) ? `\x1b[13;${modifiers}u` : null;
      // Byte-stream editors need their escape sequence even when ConPTY requests console records.
      // The native console editor consumes modifier-bearing records directly.
      if (encoded && (!win32 || tool !== 'codex')) return encoded;
      if (win32) {
        // Native console records retain the actual modifiers, including shell key bindings.
        const state = (event.shiftKey ? 16 : 0) | (event.ctrlKey ? 8 : 0) | (event.code === 'NumpadEnter' ? 256 : 0)
          | (event.getModifierState('NumLock') ? 32 : 0) | (event.getModifierState('CapsLock') ? 128 : 0)
          | (event.getModifierState('ScrollLock') ? 64 : 0);
        const char = event.ctrlKey ? 10 : 13;
        return `\x1b[13;28;${char};1;${state};1_\x1b[13;28;${char};0;${state};1_`;
      }
      return encoded;
    },
  };
}
