// useTextContextMenu - a reusable right-click cut/copy/paste/select-all menu
// for any text input or textarea. Extracted from Gambit's context menu so the
// task board (to-do / note / prompt views) gets the same text-edit affordance
// without re-implementing it. Clipboard goes through lib/clipboard so WebView2
// does not display a native permission dialog on every paste.
//
// Usage:
//   const { menu, openMenu } = useTextContextMenu();
//   <textarea onContextMenu={(e) => openMenu(e, setValue)} />
//   {menu}
//
// `openMenu` reads the element live (e.currentTarget.value) and applies edits
// via the `onChange` you pass in, so one hook instance can back several fields
// with different updaters (e.g. each card's description in a mapped list).

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n/useT';
import { clipboardRead, clipboardWrite } from './clipboard';

type CtxTarget = HTMLTextAreaElement | HTMLInputElement;

interface CtxMenuState {
  x: number;
  y: number;
  hasSelection: boolean;
  el: CtxTarget;
  onChange: (next: string) => void;
}

export function useTextContextMenu() {
  const t = useT();
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const isMac = navigator.platform.toUpperCase().includes('MAC');
  const ctxMod = isMac ? '⌘' : 'Ctrl';

  // Windows-style dismiss: ANY interaction outside the menu closes it
  // (mousedown outside, Escape, wheel scroll, window blur/resize). Capture
  // phase so it fires regardless of any stopPropagation up the React tree.
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    const onDocMouseDown = (e: MouseEvent) => {
      if (menuRef.current && menuRef.current.contains(e.target as Node)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    const onWheel = () => close();
    document.addEventListener('mousedown', onDocMouseDown, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('wheel', onWheel, { capture: true, passive: true });
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown, true);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
    };
  }, [ctxMenu]);

  const openMenu = (e: React.MouseEvent, onChange: (next: string) => void) => {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as CtxTarget;
    const hasSelection = (el.selectionStart ?? 0) !== (el.selectionEnd ?? 0);
    setCtxMenu({ x: e.clientX, y: e.clientY, hasSelection, el, onChange });
  };

  const ctxCopy = () => {
    if (!ctxMenu) return;
    const { el } = ctxMenu;
    const selected = el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0);
    if (selected) clipboardWrite(selected);
    setCtxMenu(null);
  };

  const ctxCut = () => {
    if (!ctxMenu) return;
    const { el, onChange } = ctxMenu;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    const selected = el.value.slice(start, end);
    if (selected) {
      clipboardWrite(selected);
      onChange(el.value.slice(0, start) + el.value.slice(end));
      requestAnimationFrame(() => {
        el.focus();
        el.selectionStart = start;
        el.selectionEnd = start;
      });
    }
    setCtxMenu(null);
  };

  const ctxPaste = () => {
    if (!ctxMenu) return;
    const { el, onChange } = ctxMenu;
    setCtxMenu(null);
    clipboardRead().then((text) => {
      if (!text) return;
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      onChange(el.value.slice(0, start) + text + el.value.slice(end));
      requestAnimationFrame(() => {
        el.focus();
        el.selectionStart = start + text.length;
        el.selectionEnd = start + text.length;
      });
    });
  };

  const ctxSelectAll = () => {
    if (!ctxMenu) return;
    const { el } = ctxMenu;
    el.focus();
    el.select();
    setCtxMenu(null);
  };

  const dialog = ctxMenu?.el.closest('dialog');
  const dialogRect = dialog?.getBoundingClientRect();
  const menu = ctxMenu && createPortal(
    <div
      ref={menuRef}
      className="term-ctx-menu"
      style={{
        // Dialog-local positioning also works when Glass creates a fixed containing block.
        position: dialog ? 'absolute' : undefined,
        left: dialog && dialogRect ? Math.max(4, Math.min(ctxMenu.x - dialogRect.left, dialog.clientWidth - 168)) : Math.min(ctxMenu.x, window.innerWidth - 168),
        top: dialog && dialogRect ? Math.max(4, Math.min(ctxMenu.y - dialogRect.top, dialog.clientHeight - 156)) : Math.min(ctxMenu.y, window.innerHeight - 156),
      }}
    >
      <button
        className={`term-ctx-item${ctxMenu.hasSelection ? '' : ' disabled'}`}
        onMouseDown={(e) => { e.preventDefault(); if (ctxMenu.hasSelection) ctxCut(); }}
      >
        <span>{t('menu.cut')}</span><kbd>{ctxMod}+X</kbd>
      </button>
      <button
        className={`term-ctx-item${ctxMenu.hasSelection ? '' : ' disabled'}`}
        onMouseDown={(e) => { e.preventDefault(); if (ctxMenu.hasSelection) ctxCopy(); }}
      >
        <span>{t('menu.copy')}</span><kbd>{ctxMod}+C</kbd>
      </button>
      <button
        className="term-ctx-item"
        onMouseDown={(e) => { e.preventDefault(); ctxPaste(); }}
      >
        <span>{t('menu.paste')}</span><kbd>{ctxMod}+V</kbd>
      </button>
      <div className="term-ctx-sep" />
      <button
        className="term-ctx-item"
        onMouseDown={(e) => { e.preventDefault(); ctxSelectAll(); }}
      >
        <span>{t('menu.select_all')}</span><kbd>{ctxMod}+A</kbd>
      </button>
    </div>,
    // A modal dialog makes body portals inert; keep its text menu in the top layer.
    dialog ?? document.body,
  );

  return { menu, openMenu };
}
