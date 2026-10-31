import { useEffect, useRef, useState, type MouseEvent, type RefObject } from 'react';
import { TermContextMenu } from '../components/center/TermContextMenu';
import { useAppState } from '../store/app-state';
import { commands } from '../tauri';
import { clipboardRead, clipboardWrite } from './clipboard';
import { pathMatchAt, type ConversationLink } from './conversation-links';

/** The file path under the pointer in rendered text, such as a code block, which has no link to read. */
function pathAtPoint(x: number, y: number, cwd: string | null) {
  const caret = document.caretRangeFromPoint?.(x, y);
  if (!caret) return null;
  const node = caret.startContainer, element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node as Element;
  if (element?.closest('a,button,input,textarea')) return null;
  const block = element?.closest('.md-code-line,code,p,li,td,th,pre');
  if (!block) return null;
  const before = document.createRange();
  before.setStart(block, 0); before.setEnd(node, caret.startOffset);
  const match = pathMatchAt(block.textContent ?? '', before.toString().length, cwd);
  // The pointer can sit past the end of a line, where the caret still lands on its last character.
  const glyph = node.nodeType === Node.TEXT_NODE && caret.startOffset < (node.nodeValue?.length ?? 0) ? document.createRange() : null;
  if (glyph) { glyph.setStart(node, caret.startOffset); glyph.setEnd(node, caret.startOffset + 1); const box = glyph.getBoundingClientRect(); if (x < box.left - 1 || x > box.right + 1) return null; }
  return match && { ...match, block };
}

/** A range over part of an element's text, which syntax highlighting may have split across many nodes. */
function textRange(block: Element, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT), range = document.createRange();
  let offset = 0, opened = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.nodeValue?.length ?? 0;
    if (!opened && start < offset + length) { range.setStart(node, start - offset); opened = true; }
    if (opened && end <= offset + length) { range.setEnd(node, end - offset); return range; }
    offset += length;
  }
  return null;
}

const HOVER = 'conversation-path';
const highlights = () => (globalThis.CSS as unknown as { highlights?: Map<string, unknown> } | undefined)?.highlights;
/** The hover cue, without touching the DOM that selection and virtual rows depend on. */
function showPathHover(range: Range | null, surface: HTMLElement) {
  surface.style.cursor = range ? 'pointer' : '';
  const store = highlights(), Highlight = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  if (!store || !Highlight) return;
  if (range) store.set(HOVER, new Highlight(range)); else store.delete(HOVER);
}

export function useConversationMenu(surface: RefObject<HTMLDivElement | null>, sessionId: string, isActive: boolean) {
  const { state, dispatch } = useAppState();
  const [menu, setMenu] = useState<{ x: number; y: number; selection: string; link: ConversationLink | null } | null>(null);
  const close = () => setMenu(null);
  if (!isActive && menu) setMenu(null);
  const cwd = state?.terminals?.find(tab => tab.id === sessionId)?.folderPath ?? null;
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  // Paths in code blocks and text are not links, so hovering and clicking find them under the pointer.
  useEffect(() => {
    const node = surface.current;
    if (!node) return;
    let frame = 0, pointer = { x: 0, y: 0 };
    const hover = () => {
      frame = 0;
      const match = window.getSelection()?.isCollapsed === false ? null : pathAtPoint(pointer.x, pointer.y, cwdRef.current);
      showPathHover(match ? textRange(match.block, match.start, match.end) : null, node);
    };
    const move = (event: globalThis.MouseEvent) => { pointer = { x: event.clientX, y: event.clientY }; frame ||= requestAnimationFrame(hover); };
    const leave = () => { cancelAnimationFrame(frame); frame = 0; showPathHover(null, node); };
    // Revealing never runs anything, and a drag that selected text is not a click.
    const click = (event: globalThis.MouseEvent) => {
      if (event.button !== 0 || window.getSelection()?.isCollapsed === false) return;
      const match = pathAtPoint(event.clientX, event.clientY, cwdRef.current);
      if (match) void commands.showInFolder(match.link.target).catch(error => console.warn('[Conversation] failed to reveal file', error));
    };
    node.addEventListener('mousemove', move); node.addEventListener('mouseleave', leave); node.addEventListener('click', click);
    return () => { leave(); node.removeEventListener('mousemove', move); node.removeEventListener('mouseleave', leave); node.removeEventListener('click', click); };
  }, [surface]);
  useEffect(() => {
    if (!menu) return;
    const dismiss = () => setMenu(null);
    window.addEventListener('blur', dismiss); window.addEventListener('resize', dismiss);
    document.addEventListener('wheel', dismiss, true);
    return () => { window.removeEventListener('blur', dismiss); window.removeEventListener('resize', dismiss); document.removeEventListener('wheel', dismiss, true); };
  }, [menu]);
  const onContextMenu = (event: MouseEvent) => {
    if ((event.target as HTMLElement).closest('textarea,input,select')) return;
    event.preventDefault(); event.stopPropagation();
    const selection = window.getSelection();
    const text = selection?.anchorNode && surface.current?.contains(selection.anchorNode) ? selection.toString() : '';
    const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[data-conversation-target]');
    const target = anchor?.dataset.conversationTarget;
    setMenu({ x: event.clientX, y: event.clientY, selection: text, link: target ? { target, local: anchor.dataset.conversationLocal === 'true' } : pathAtPoint(event.clientX, event.clientY, cwd)?.link ?? null });
  };
  return {
    onContextMenu,
    onCopy: (event: React.ClipboardEvent) => {
      const selection = window.getSelection();
      if (selection?.anchorNode && surface.current?.contains(selection.anchorNode) && selection.toString()) { event.preventDefault(); void clipboardWrite(selection.toString()); }
    },
    menu: menu && <TermContextMenu menu={{ ...menu, hasSelection: !!menu.selection }} onClose={close}
      onCopy={() => { void clipboardWrite(menu.selection); close(); }}
      onPaste={() => { close(); void clipboardRead().then(text => { if (text) { dispatch({ type: 'APPEND_GAMBIT_DRAFT', id: sessionId, text }); document.querySelector<HTMLTextAreaElement>('.gambit-textarea')?.focus(); } }); }}
      onSelectAll={() => { if (surface.current) window.getSelection()?.selectAllChildren(surface.current); close(); }}
      link={menu.link ? { local: menu.link.local, onOpen: () => { void commands.openUrl(menu.link!.target).catch(error => console.warn('[Conversation] failed to open link', error)); close(); }, onCopy: () => { void clipboardWrite(menu.link!.target); close(); }, onReveal: () => { void commands.showInFolder(menu.link!.target).catch(error => console.warn('[Conversation] failed to reveal file', error)); close(); } } : undefined} />,
  };
}
