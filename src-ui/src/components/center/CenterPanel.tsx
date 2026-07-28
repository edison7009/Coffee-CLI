import { useState, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { focusTerminal } from '../../lib/focus-registry';
import { onWindowForeground } from '../../lib/window-focus-filter';
import { TierTerminal } from './TierTerminal';
import { SkillsPanel } from './SkillsPanel';
import { FourSplitGrid } from './FourSplitGrid';
import { ToolConfigModal } from './ToolConfigModal';
import { ContributionHeatmap } from './ContributionHeatmap';
import { ErrorBoundary } from '../common/ErrorBoundary';
import { DiffPanel } from '../right/DiffPanel';
import { useAppState, type ToolType } from '../../store/app-state';

// Dropdown shown when a tool card's folder icon is clicked: the globally
// recent project folders (any tool that used one) + "Open folder…" last.
// Clicking a recent launches THIS card's tool in that folder; the card body
// click is unchanged (old flow). Portal-rendered with outside-click / Esc to
// close — same pattern as the terminal context menu.
function RecentFolderMenu({ x, y, recent, openLabel, onPick, onRemove, onOpenNew, onClose }: {
  x: number;
  y: number;
  recent: string[];
  openLabel: string;
  onPick: (folder: string) => void;
  onRemove: (folder: string) => void;
  onOpenNew: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    // Defer so the opening click doesn't immediately close the menu.
    const id = setTimeout(() => {
      document.addEventListener('mousedown', onDown);
      document.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const left = Math.min(x, window.innerWidth - 290);
  const top = Math.min(y, window.innerHeight - (recent.length * 40 + 56));
  const split = (p: string) => {
    const norm = p.replace(/\\/g, '/').replace(/\/+$/, '');
    const i = norm.lastIndexOf('/');
    return { name: i >= 0 ? norm.slice(i + 1) : norm, parent: i >= 0 ? norm.slice(0, i) : '' };
  };
  const FolderGlyph = (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
  const XGlyph = (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
  // Same folder body as FolderGlyph + a plus, so "open new" reads as the same
  // family as the recents above it, just clearly the "add another" action.
  const FolderPlusGlyph = (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      <path d="M12 11v6M9 14h6" />
    </svg>
  );

  return createPortal(
    <div ref={ref} className="folder-menu" style={{ left, top }}>
      {recent.map(f => {
        const { name, parent } = split(f);
        return (
          <button key={f} className="folder-menu-item" onMouseDown={(e) => { e.preventDefault(); onPick(f); }}>
            {FolderGlyph}
            <span className="folder-menu-name">{name}</span>
            {parent && <span className="folder-menu-path">{parent}</span>}
            <span
              className="folder-menu-del"
              role="button"
              aria-label={`Remove ${name}`}
              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onRemove(f); }}
            >
              {XGlyph}
            </span>
          </button>
        );
      })}
      {recent.length > 0 && <div className="folder-menu-sep" />}
      <button className="folder-menu-item folder-menu-open" onMouseDown={(e) => { e.preventDefault(); onOpenNew(); }}>
        {FolderPlusGlyph}
        <span className="folder-menu-name">{openLabel}</span>
      </button>
    </div>,
    document.body,
  );
}

interface RemoteHistoryItem {
  id: string;
  protocol: 'ssh' | 'ws';
  host: string;
  port: string;
  user: string;
}
import { isTauri, commands } from '../../tauri';
import { getToolDisplayName } from '../../lib/tool-info';
import { useT } from '../../i18n/useT';
import './CenterPanel.css';

// Tool icon assets bundled inline by Vite. PNGs use ?inline → base64 data URI;
// SVGs use ?raw → string for dangerouslySetInnerHTML rendering. Both flows
// avoid the <img> async-decode pipeline that flashed for one frame on every
// Launchpad re-mount, even with `decoding="sync"` + App-mount img.decode()
// priming. See the comment block above OPENCODE_SVG below for the full
// rationale and the history of failed attempts.
import HERMES_DATA_URL from '../../icons-inline/hermes.png?inline';
import TERMINAL_MAC_DATA_URL from '../../icons-inline/terminal-macos.png?inline';
import TERMINAL_LINUX_DATA_URL from '../../icons-inline/terminal-linux.png?inline';
import TERMINAL_PWSH_SVG from '../../icons-inline/terminal-powershell.svg?raw';
// Additional tool icons (Pi & Kimi Code = T2; Crush/Aider/Goose/Copilot = T3).
// SVG → ?raw, PNG → ?inline, same pipeline as the tools above.
import PI_SVG from '../../icons-inline/pi.svg?raw';
import COPILOT_SVG from '../../icons-inline/copilot.svg?raw';
import GROK_SVG from '../../icons-inline/grok.svg?raw';
import OPENCLAW_SVG from '../../icons-inline/openclaw.svg?raw';
import AIDER_DATA_URL from '../../icons-inline/aider.png?inline';
import KIMICODE_DATA_URL from '../../icons-inline/kimicode.png?inline';
import CRUSH_DATA_URL from '../../icons-inline/crush.png?inline';
import GOOSE_DATA_URL from '../../icons-inline/goose.png?inline';

// Tool icons — adding a new tool = drop the asset under src/icons-inline/
// and import it the same way (?inline for PNG, ?raw for SVG).

// PNG icons render via CSS background-image, NOT <img>. The <img> element
// has an async decode-on-mount pipeline that flashes for one frame even
// with `decoding="sync"` (it's a hint Chromium can ignore) and even with
// the App-mount img.decode() preload (WebView2 evicts the decoded-image
// cache under sustained use). CSS backgrounds paint as part of the
// element's own first frame — no separate decode lifecycle, no flash.
// The data URI is a build-time `?inline` import, so bytes ship in the
// JS bundle and there's no HTTP round-trip either.
const bgIcon = (dataUrl: string, size = '1em', extra: React.CSSProperties = {}) => (
  <span
    aria-hidden
    style={{
      display: 'inline-block',
      width: size,
      height: size,
      flexShrink: 0,
      backgroundImage: `url(${dataUrl})`,
      backgroundSize: 'contain',
      backgroundPosition: 'center',
      backgroundRepeat: 'no-repeat',
      ...extra,
    }}
  />
);

// Third-party CLI logos as inline SVG strings. Previously loaded via
// `<img src="/icons/tools/*.svg">`, which caused a visible flash every
// time the Launchpad re-mounted on tab switch: the <img> paints empty
// on first render, then fills in after the browser resolves the URL —
// even when the file is in HTTP cache, WebView2 still schedules at
// least one async frame before the pixels appear. Embedding the SVG
// content directly means rendering is fully synchronous on mount, so
// icons are present on the very first paint.
//
// Kept as string literals (not <svg> JSX) because the third-party
// logos use nested <defs>/<linearGradient> nodes whose `id` attrs
// would collide between React renders if the same component mounted
// twice — the shared module-level constants get stamped into the DOM
// identically each time, and browsers scope gradient refs per-element.
const CLAUDE_SVG    = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" width="100%" height="100%"><path clip-rule="evenodd" d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z" fill="#D97757" fill-rule="evenodd"/></svg>';
const CODEX_SVG     = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="100%" height="100%"><defs><linearGradient gradientUnits="userSpaceOnUse" id="codex-fill" x1="12" x2="12" y1="3" y2="21"><stop stop-color="#B1A7FF"/><stop offset=".5" stop-color="#7A9DFF"/><stop offset="1" stop-color="#3941FF"/></linearGradient></defs><path d="M19.503 0H4.496A4.496 4.496 0 000 4.496v15.007A4.496 4.496 0 004.496 24h15.007A4.496 4.496 0 0024 19.503V4.496A4.496 4.496 0 0019.503 0z" fill="#fff"/><path d="M9.064 3.344a4.578 4.578 0 012.285-.312c1 .115 1.891.54 2.673 1.275.01.01.024.017.037.021a.09.09 0 00.043 0 4.55 4.55 0 013.046.275l.047.022.116.057a4.581 4.581 0 012.188 2.399c.209.51.313 1.041.315 1.595a4.24 4.24 0 01-.134 1.223.123.123 0 00.03.115c.594.607.988 1.33 1.183 2.17.289 1.425-.007 2.71-.887 3.854l-.136.166a4.548 4.548 0 01-2.201 1.388.123.123 0 00-.081.076c-.191.551-.383 1.023-.74 1.494-.9 1.187-2.222 1.846-3.711 1.838-1.187-.006-2.239-.44-3.157-1.302a.107.107 0 00-.105-.024c-.388.125-.78.143-1.204.138a4.441 4.441 0 01-1.945-.466 4.544 4.544 0 01-1.61-1.335c-.152-.202-.303-.392-.414-.617a5.81 5.81 0 01-.37-.961 4.582 4.582 0 01-.014-2.298.124.124 0 00.006-.056.085.085 0 00-.027-.048 4.467 4.467 0 01-1.034-1.651 3.896 3.896 0 01-.251-1.192 5.189 5.189 0 01.141-1.6c.337-1.112.982-1.985 1.933-2.618.212-.141.413-.251.601-.33.215-.089.43-.164.646-.227a.098.098 0 00.065-.066 4.51 4.51 0 01.829-1.615 4.535 4.535 0 011.837-1.388zm3.482 10.565a.637.637 0 000 1.272h3.636a.637.637 0 100-1.272h-3.636zM8.462 9.23a.637.637 0 00-1.106.631l1.272 2.224-1.266 2.136a.636.636 0 101.095.649l1.454-2.455a.636.636 0 00.005-.64L8.462 9.23z" fill="url(#codex-fill)"/></svg>';
// Antigravity brand mark — Lobe Icons set, 4-color ribbon under a mountain
// mask. Inlined as a string so multiple Launchpad mounts share the same
// gradient/filter ids without re-paint (same rationale as the other inline
// SVGs above). Source SVG had `width="1em" height="1em"`; normalized to
// `width="100%" height="100%"` so it fills the CSS-controlled 44px slot
// like the other tool icons.
const ANTIGRAVITY_SVG = '<svg height="100%" style="flex:none;line-height:1" viewBox="0 0 24 24" width="100%" xmlns="http://www.w3.org/2000/svg"><title>Antigravity</title><mask height="23" id="lobe-icons-antigravity-0-_R_0_" maskUnits="userSpaceOnUse" width="24" x="0" y="1"><path d="M21.751 22.607c1.34 1.005 3.35.335 1.508-1.508C17.73 15.74 18.904 1 12.037 1 5.17 1 6.342 15.74.815 21.1c-2.01 2.009.167 2.511 1.507 1.506 5.192-3.517 4.857-9.714 9.715-9.714 4.857 0 4.522 6.197 9.714 9.715z" fill="#fff"></path></mask><g mask="url(#lobe-icons-antigravity-0-_R_0_)"><g filter="url(#lobe-icons-antigravity-1-_R_0_)"><path d="M-1.018-3.992c-.408 3.591 2.686 6.89 6.91 7.37 4.225.48 7.98-2.043 8.387-5.633.408-3.59-2.686-6.89-6.91-7.37-4.225-.479-7.98 2.043-8.387 5.633z" fill="#FFE432"></path></g><g filter="url(#lobe-icons-antigravity-2-_R_0_)"><path d="M15.269 7.747c1.058 4.557 5.691 7.374 10.348 6.293 4.657-1.082 7.575-5.653 6.516-10.21-1.058-4.556-5.691-7.374-10.348-6.292-4.657 1.082-7.575 5.653-6.516 10.21z" fill="#FC413D"></path></g><g filter="url(#lobe-icons-antigravity-3-_R_0_)"><path d="M-12.443 10.804c1.338 4.703 7.36 7.11 13.453 5.378 6.092-1.733 9.947-6.95 8.61-11.652C8.282-.173 2.26-2.58-3.833-.848-9.925.884-13.78 6.1-12.443 10.804z" fill="#00B95C"></path></g><g filter="url(#lobe-icons-antigravity-4-_R_0_)"><path d="M-12.443 10.804c1.338 4.703 7.36 7.11 13.453 5.378 6.092-1.733 9.947-6.95 8.61-11.652C8.282-.173 2.26-2.58-3.833-.848-9.925.884-13.78 6.1-12.443 10.804z" fill="#00B95C"></path></g><g filter="url(#lobe-icons-antigravity-5-_R_0_)"><path d="M-7.608 14.703c3.352 3.424 9.126 3.208 12.896-.483 3.77-3.69 4.108-9.459.756-12.883C2.69-2.087-3.083-1.871-6.853 1.82c-3.77 3.69-4.108 9.458-.755 12.883z" fill="#00B95C"></path></g><g filter="url(#lobe-icons-antigravity-6-_R_0_)"><path d="M9.932 27.617c1.04 4.482 5.384 7.303 9.7 6.3 4.316-1.002 6.971-5.448 5.93-9.93-1.04-4.483-5.384-7.304-9.7-6.301-4.316 1.002-6.971 5.448-5.93 9.93z" fill="#3186FF"></path></g><g filter="url(#lobe-icons-antigravity-7-_R_0_)"><path d="M2.572-8.185C.392-3.329 2.778 2.472 7.9 4.771c5.122 2.3 11.042.227 13.222-4.63 2.18-4.855-.205-10.656-5.327-12.955-5.122-2.3-11.042-.227-13.222 4.63z" fill="#FBBC04"></path></g><g filter="url(#lobe-icons-antigravity-8-_R_0_)"><path d="M-3.267 38.686c-5.277-2.072 3.742-19.117 5.984-24.83 2.243-5.712 8.34-8.664 13.616-6.592 5.278 2.071 11.533 13.482 9.29 19.195-2.242 5.713-23.613 14.298-28.89 12.227z" fill="#3186FF"></path></g><g filter="url(#lobe-icons-antigravity-9-_R_0_)"><path d="M28.71 17.471c-1.413 1.649-5.1.808-8.236-1.878-3.135-2.687-4.531-6.201-3.118-7.85 1.412-1.649 5.1-.808 8.235 1.878s4.532 6.2 3.119 7.85z" fill="#749BFF"></path></g><g filter="url(#lobe-icons-antigravity-10-_R_0_)"><path d="M18.163 9.077c5.81 3.93 12.502 4.19 14.946.577 2.443-3.612-.287-9.727-6.098-13.658-5.81-3.931-12.502-4.19-14.946-.577-2.443 3.612.287 9.727 6.098 13.658z" fill="#FC413D"></path></g><g filter="url(#lobe-icons-antigravity-11-_R_0_)"><path d="M-.915 2.684c-1.44 3.473-.97 6.967 1.05 7.804 2.02.837 4.824-1.3 6.264-4.772 1.44-3.473.97-6.967-1.05-7.804-2.02-.837-4.824 1.3-6.264 4.772z" fill="#FFEE48"></path></g></g><defs><filter color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse" height="17.587" id="lobe-icons-antigravity-1-_R_0_" width="19.838" x="-3.288" y="-11.917"><feFlood flood-opacity="0" result="BackgroundImageFix"></feFlood><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"></feBlend><feGaussianBlur result="effect1_foregroundBlur_977_115" stdDeviation="1.117"></feGaussianBlur></filter><filter color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse" height="38.565" id="lobe-icons-antigravity-2-_R_0_" width="38.9" x="4.251" y="-13.493"><feFlood flood-opacity="0" result="BackgroundImageFix"></feFlood><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"></feBlend><feGaussianBlur result="effect1_foregroundBlur_977_115" stdDeviation="5.4"></feGaussianBlur></filter><filter color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse" height="36.517" id="lobe-icons-antigravity-3-_R_0_" width="40.955" x="-21.889" y="-10.592"><feFlood flood-opacity="0" result="BackgroundImageFix"></feFlood><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"></feBlend><feGaussianBlur result="effect1_foregroundBlur_977_115" stdDeviation="4.591"></feGaussianBlur></filter><filter color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse" height="36.517" id="lobe-icons-antigravity-4-_R_0_" width="40.955" x="-21.889" y="-10.592"><feFlood flood-opacity="0" result="BackgroundImageFix"></feFlood><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"></feBlend><feGaussianBlur result="effect1_foregroundBlur_977_115" stdDeviation="4.591"></feGaussianBlur></filter><filter color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse" height="36.595" id="lobe-icons-antigravity-5-_R_0_" width="36.632" x="-19.099" y="-10.278"><feFlood flood-opacity="0" result="BackgroundImageFix"></feFlood><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"></feBlend><feGaussianBlur result="effect1_foregroundBlur_977_115" stdDeviation="4.591"></feGaussianBlur></filter><filter color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse" height="34.087" id="lobe-icons-antigravity-6-_R_0_" width="33.533" x=".981" y="8.758"><feFlood flood-opacity="0" result="BackgroundImageFix"></feFlood><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"></feBlend><feGaussianBlur result="effect1_foregroundBlur_977_115" stdDeviation="4.363"></feGaussianBlur></filter><filter color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse" height="35.276" id="lobe-icons-antigravity-7-_R_0_" width="35.978" x="-6.143" y="-21.659"><feFlood flood-opacity="0" result="BackgroundImageFix"></feFlood><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"></feBlend><feGaussianBlur result="effect1_foregroundBlur_977_115" stdDeviation="3.954"></feGaussianBlur></filter><filter color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse" height="46.523" id="lobe-icons-antigravity-8-_R_0_" width="45.114" x="-11.96" y="-.46"><feFlood flood-opacity="0" result="BackgroundImageFix"></feFlood><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"></feBlend><feGaussianBlur result="effect1_foregroundBlur_977_115" stdDeviation="3.531"></feGaussianBlur></filter><filter color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse" height="24.054" id="lobe-icons-antigravity-9-_R_0_" width="25.094" x="10.485" y=".58"><feFlood flood-opacity="0" result="BackgroundImageFix"></feFlood><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"></feBlend><feGaussianBlur result="effect1_foregroundBlur_977_115" stdDeviation="3.159"></feGaussianBlur></filter><filter color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse" height="30.007" id="lobe-icons-antigravity-10-_R_0_" width="33.508" x="5.833" y="-12.467"><feFlood flood-opacity="0" result="BackgroundImageFix"></feFlood><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"></feBlend><feGaussianBlur result="effect1_foregroundBlur_977_115" stdDeviation="2.669"></feGaussianBlur></filter><filter color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse" height="26.151" id="lobe-icons-antigravity-11-_R_0_" width="22.194" x="-8.355" y="-8.876"><feFlood flood-opacity="0" result="BackgroundImageFix"></feFlood><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"></feBlend><feGaussianBlur result="effect1_foregroundBlur_977_115" stdDeviation="3.303"></feGaussianBlur></filter></defs></svg>';
// OpenCode brand mark — inline SVG, ported from the official apple-touch-icon.
// Earlier we shipped a PNG to chase pixel parity, but PNG-via-<img> kept
// flashing on tab switch even with `decoding="sync"` + App-mount img.decode()
// preload — Chromium honors `decoding="sync"` only as a hint, and WebView2's
// decoded-image cache evicts under sustained use, so every Launchpad re-mount
// re-runs the async decode pipeline. Inline SVG renders synchronously as DOM,
// so it never flashes. Outer rect rounded (rx=18) to match the iOS-style
// rounded square of the official PNG asset; previous opencode.svg lacked this.
const OPENCODE_SVG  = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="100%" height="100%"><rect width="96" height="96" rx="18" ry="18" fill="#131010"/><rect x="24" y="18" width="48" height="60" fill="#FFFFFF"/><rect x="36" y="30" width="24" height="36" fill="#5A5858"/><rect x="36" y="30" width="24" height="12" fill="#131010"/></svg>';
const QWEN_SVG      = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="100%" height="100%"><defs><linearGradient id="qwen-fill" x1="0%" x2="100%" y1="0%" y2="0%"><stop offset="0%" stop-color="#6336E7" stop-opacity=".84"/><stop offset="100%" stop-color="#6F69F7" stop-opacity=".84"/></linearGradient></defs><path d="M12.604 1.34c.393.69.784 1.382 1.174 2.075a.18.18 0 00.157.091h5.552c.174 0 .322.11.446.327l1.454 2.57c.19.337.24.478.024.837-.26.43-.513.864-.76 1.3l-.367.658c-.106.196-.223.28-.04.512l2.652 4.637c.172.301.111.494-.043.77-.437.785-.882 1.564-1.335 2.34-.159.272-.352.375-.68.37-.777-.016-1.552-.01-2.327.016a.099.099 0 00-.081.05 575.097 575.097 0 01-2.705 4.74c-.169.293-.38.363-.725.364-.997.003-2.002.004-3.017.002a.537.537 0 01-.465-.271l-1.335-2.323a.09.09 0 00-.083-.049H4.982c-.285.03-.553-.001-.805-.092l-1.603-2.77a.543.543 0 01-.002-.54l1.207-2.12a.198.198 0 000-.197 550.951 550.951 0 01-1.875-3.272l-.79-1.395c-.16-.31-.173-.496.095-.965.465-.813.927-1.625 1.387-2.436.132-.234.304-.334.584-.335a338.3 338.3 0 012.589-.001.124.124 0 00.107-.063l2.806-4.895a.488.488 0 01.422-.246c.524-.001 1.053 0 1.583-.006L11.704 1c.341-.003.724.032.9.34zm-3.432.403a.06.06 0 00-.052.03L6.254 6.788a.157.157 0 01-.135.078H3.253c-.056 0-.07.025-.041.074l5.81 10.156c.025.042.013.062-.034.063l-2.795.015a.218.218 0 00-.2.116l-1.32 2.31c-.044.078-.021.118.068.118l5.716.008c.046 0 .08.02.104.061l1.403 2.454c.046.081.092.082.139 0l5.006-8.76.783-1.382a.055.055 0 01.096 0l1.424 2.53a.122.122 0 00.107.062l2.763-.02a.04.04 0 00.035-.02.041.041 0 000-.04l-2.9-5.086a.108.108 0 010-.113l.293-.507 1.12-1.977c.024-.041.012-.062-.035-.062H9.2c-.059 0-.073-.026-.043-.077l1.434-2.505a.107.107 0 000-.114L9.225 1.774a.06.06 0 00-.053-.031zm6.29 8.02c.046 0 .058.02.034.06l-.832 1.465-2.613 4.585a.056.056 0 01-.05.029.058.058 0 01-.05-.029L8.498 9.841c-.02-.034-.01-.052.028-.054l.216-.012 6.722-.012z" fill="url(#qwen-fill)" fill-rule="nonzero"/></svg>';
// OpenClaw brand (lobster mascot) — ported from Web-Home/agents/icons/openclaw.svg.
// Markup lives in src/icons-inline/openclaw.svg and is imported ?raw above so
// HistoryBoard can reuse the same bytes. Gradient IDs stay verbatim from the
// source asset; browsers scope them per-<svg> so multiple mounts don't clash.

// MiMo Code (Xiaomi's OpenCode fork) — official orange squircle mark, from
// EchoBird's icons/tools/mimocode.svg. Inline SVG so it renders synchronously
// (no flash on tab switch — same rationale as OPENCODE_SVG).
const MIMOCODE_SVG  = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-200.008 -199.727 512 512" width="100%" height="100%"><path fill="#FF6900" d="M258.626-146.231c-48.304-48.118-117.759-53.496-202.634-53.496c-84.982,0-154.542,5.44-202.826,53.688c-48.277,48.228-53.174,117.676-53.174,202.561c0,84.899,4.897,154.368,53.194,202.613c48.281,48.255,117.833,53.139,202.806,53.139c84.974,0,154.514-4.884,202.795-53.139c48.294-48.254,53.205-117.714,53.205-202.613C311.992-28.472,307.028-97.995,258.626-146.231L258.626-146.231z"/><path fill="#FFFFFF" d="M204.546-41.122c1.759,0,3.223,1.417,3.223,3.161v189.386c0,1.715-1.464,3.139-3.223,3.139H163.05c-1.781,0-3.228-1.424-3.228-3.139V-37.961c0-1.743,1.446-3.161,3.228-3.161H204.546z M24.468-41.122c31.303,0,64.033,1.435,80.176,17.589c15.871,15.897,17.59,47.549,17.656,78.286v96.671c0,1.715-1.446,3.139-3.219,3.139h-41.49c-1.777,0-3.229-1.424-3.229-3.139V53.09c-0.044-17.167-1.031-34.81-9.884-43.692c-7.62-7.641-21.839-9.391-36.625-9.754h-75.21c-1.764,0-3.208,1.419-3.208,3.136v148.645c0,1.715-1.462,3.139-3.237,3.139h-41.516c-1.774,0-3.201-1.424-3.201-3.139V-37.961c0-1.743,1.426-3.161,3.201-3.161H24.468z M33.755,34.305c1.766,0,3.201,1.413,3.201,3.143v113.977c0,1.715-1.436,3.139-3.201,3.139H-9.829c-1.792,0-3.228-1.424-3.228-3.139V37.448c0-1.73,1.436-3.143,3.228-3.143H33.755z"/></svg>';

const inlineSvgIcon = (markup: string, size = '1em', extra: React.CSSProperties = {}) => (
  <span
    aria-hidden
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: size,
      height: size,
      flexShrink: 0,
      ...extra,
    }}
    dangerouslySetInnerHTML={{ __html: markup }}
  />
);

// All icons render at the default 1em, then `.launchpad-icon` in
// CenterPanel.css forces width/height to 100% of a fixed 44px container
// (with object-fit: contain). Uniform visible size is handled purely by
// CSS — no per-icon em tuning here. Source SVGs should use a viewBox
// that tightly frames the visible mark so the container fills without
// dead padding.
const SvgClaude    = () => inlineSvgIcon(CLAUDE_SVG);
const SvgQwen      = () => inlineSvgIcon(QWEN_SVG);
// OpenCode — inline SVG (see OPENCODE_SVG comment). The PNG variant lived
// here briefly for pixel parity with the brand's apple-touch-icon, but the
// trade-off (fixed flash-on-mount in WebView2) wasn't worth it; the inline
// SVG with rounded outer rect matches the brand visually within a pixel or two.
const SvgOpenCode  = () => inlineSvgIcon(OPENCODE_SVG);
const SvgMimo      = () => inlineSvgIcon(MIMOCODE_SVG, '1em', { borderRadius: 'var(--radius-xs)', overflow: 'hidden' });
const SvgOpenClaw  = () => inlineSvgIcon(OPENCLAW_SVG);
const SvgCodex       = () => inlineSvgIcon(CODEX_SVG);
const SvgAntigravity = () => inlineSvgIcon(ANTIGRAVITY_SVG);
// PNG-backed icons render via CSS background-image with data-URI sources
// (see bgIcon). Hermes uses `cover` to fill the rounded square.
const SvgHermes      = () => bgIcon(HERMES_DATA_URL, '1em', { borderRadius: 'var(--radius-xs)', backgroundSize: 'cover' });
// Additional tool icons. Monochrome marks (Pi, Copilot) are inline SVG
// using currentColor so they follow the theme; raster brand marks render via
// bgIcon with a rounded square to match the other PNG-backed icons.
const SvgPi        = () => inlineSvgIcon(PI_SVG);
const SvgCopilot   = () => inlineSvgIcon(COPILOT_SVG);
const SvgGrok       = () => inlineSvgIcon(GROK_SVG);
const SvgAider     = () => bgIcon(AIDER_DATA_URL, '1em', { borderRadius: 'var(--radius-xs)' });
const SvgKimi      = () => bgIcon(KIMICODE_DATA_URL, '1em', { borderRadius: 'var(--radius-xs)' });
const SvgCrush     = () => bgIcon(CRUSH_DATA_URL, '1em', { borderRadius: 'var(--radius-xs)' });
const SvgGoose     = () => bgIcon(GOOSE_DATA_URL, '1em', { borderRadius: 'var(--radius-xs)' });

// Coffee 101 card icon — animated coffee mark (same as the brand mark
// now portaled into the titlebar from Explorer.tsx): steam wave loops 3s, cup
// body draws on first paint then fills. Inlined SVG so currentColor
// follows the theme accent. Sized at 1em so it scales with the launchpad
// card font-size like other utility cards.
//
// Component is named SvgInstaller (not SvgCoffee101) because the launchpad
// card key is `'installer'` — kept that way to preserve users' existing
// localStorage pin state (`coffee_pinned_items` may contain "agent:installer").
// The card itself is no longer a one-click installer (that approach was
// abandoned, see the click handler comment); it now opens the Coffee 101
// course on coffeecli.com.
const SvgInstaller = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="1em"
    height="1em"
    viewBox="0 0 24 24"
    style={{ flexShrink: 0, color: 'var(--accent)' }}
  >
    <defs>
      <mask id="coffee101IconMask">
        <path
          fill="none"
          stroke="#fff"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          d="M8 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M12 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M16 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4"
        >
          {/* Linux gate — see Explorer.tsx brand-icon for full rationale.
              SMIL `path d` morphing inside a `<mask>` has no GPU path on
              WebKit2GTK; on the launchpad this card sits alongside the
              brand icon and together they pegged WebKit + coffee-cli at
              ~1.2 cores idle on Wayland (verified live via SSH /proc
              sampling). Static `d` on Linux = no steam drift, full glyph. */}
          {!__IS_LINUX__ && (
            <animate
              attributeName="d"
              dur="3s"
              repeatCount="indefinite"
              values="M8 0c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M12 0c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M16 0c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4;M8 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M12 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M16 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4"
            />
          )}
        </path>
        <path d="M4 7h16v0h-16v12h16v-32h-16Z">
          <animate
            fill="freeze"
            attributeName="d"
            begin="1s"
            dur="0.6s"
            to="M4 2h16v5h-16v12h16v-24h-16Z"
          />
        </path>
      </mask>
    </defs>
    <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2">
      <path
        fill="currentColor"
        fillOpacity="0"
        strokeDasharray="48"
        d="M17 9v9c0 1.66 -1.34 3 -3 3h-6c-1.66 0 -3 -1.34 -3 -3v-9Z"
      >
        <animate fill="freeze" attributeName="stroke-dashoffset" dur="0.6s" values="48;0" />
        <animate fill="freeze" attributeName="fill-opacity" begin="1.6s" dur="0.4s" to="1" />
      </path>
      <path
        fill="none"
        strokeDasharray="16"
        strokeDashoffset="16"
        d="M17 9h3c0.55 0 1 0.45 1 1v3c0 0.55 -0.45 1 -1 1h-3"
      >
        <animate fill="freeze" attributeName="stroke-dashoffset" begin="0.6s" dur="0.3s" to="0" />
      </path>
    </g>
    <path fill="currentColor" d="M0 0h24v24H0z" mask="url(#coffee101IconMask)" />
  </svg>
);

// Two-Split (independent) — 2 filled solid rectangles with a visible gap between.
// Reads as "two standalone windows" → solid = individual, gap = separation.
const SvgTwoSplit = () => (
  <svg
    width="1em"
    height="1em"
    viewBox="0 0 24 24"
    fill="currentColor"
    stroke="none"
    style={{ flexShrink: 0, color: 'var(--accent)', verticalAlign: '-0.125em' }}
  >
    <rect x="4"  y="4" width="7.5" height="16" />
    <rect x="12.5" y="4" width="7.5" height="16" />
  </svg>
);

// Three-Split (independent) — 3 filled tall rectangles with gaps between.
const SvgThreeSplit = () => (
  <svg
    width="1em"
    height="1em"
    viewBox="0 0 24 24"
    fill="currentColor"
    stroke="none"
    style={{ flexShrink: 0, color: 'var(--accent)', verticalAlign: '-0.125em' }}
  >
    <rect x="3.5"  y="4" width="5" height="16" />
    <rect x="9.5"  y="4" width="5" height="16" />
    <rect x="15.5" y="4" width="5" height="16" />
  </svg>
);

// Four-Split (independent) — 4 filled squares in a 2×2 grid with visible gaps
// between them. Solid blocks + gaps convey "4 independent PTYs, zero
// coordination" — the inverse of multi-agent's shared outer frame.
const SvgFourSplit = () => (
  <svg
    width="1em"
    height="1em"
    viewBox="0 0 24 24"
    fill="currentColor"
    stroke="none"
    style={{ flexShrink: 0, color: 'var(--accent)', verticalAlign: '-0.125em' }}
  >
    <rect x="4"    y="4"    width="7.5" height="7.5" />
    <rect x="12.5" y="4"    width="7.5" height="7.5" />
    <rect x="4"    y="12.5" width="7.5" height="7.5" />
    <rect x="12.5" y="12.5" width="7.5" height="7.5" />
  </svg>
);

// ── Platform-aware Terminal Icon & Label ─────────────────────────────────────

const detectOS = (): 'win' | 'mac' | 'linux' => {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('win')) return 'win';
  if (ua.includes('mac')) return 'mac';
  return 'linux';
};

// Terminal icon — same flicker-avoidance strategy as the other tool icons:
// PowerShell ships as raw SVG markup (rendered via dangerouslySetInnerHTML,
// fully synchronous); macOS/Linux PNG rasters render as CSS background-image
// with a base64 data URI source. No <img> in either branch.
const TerminalIcon = () => {
  const os = detectOS();
  if (os === 'win') return inlineSvgIcon(TERMINAL_PWSH_SVG, '1em', { borderRadius: 'var(--radius-xs)' });
  const dataUrl = os === 'mac' ? TERMINAL_MAC_DATA_URL : TERMINAL_LINUX_DATA_URL;
  return bgIcon(dataUrl, '1em', { borderRadius: 'var(--radius-xs)' });
};

// (terminal label now from i18n: t('tool.terminal'))

const SvgPlus = ({ active }: { active: boolean }) => (
  <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, color: active ? 'var(--accent)' : 'inherit' }}>
    <line x1="12" y1="5" x2="12" y2="19"></line>
    <line x1="5" y1="12" x2="19" y2="12"></line>
  </svg>
);

// Pin sanitizer: must mirror AGENT_CATALOG keys below. Used at init to
// drop obsolete IDs from `coffee_pinned_items` (e.g. `agent:vibeid`
// from back when /vibeid was a launcher tool, before it became a
// regular skill). Without this, retired pins inflate the
// "Agents N" counter on the library tab — the stale cards
// render nothing because no AGENT_CATALOG entry matches, but they
// still count. Update this set when adding or removing AGENT_CATALOG
// entries below.
const VALID_PIN_KEYS = new Set<string>([
  'claude', 'opencode', 'mimocode', 'openclaw', 'codex', 'grok', 'antigravity', 'qwen', 'hermes', 'terminal',
  'pi', 'crush', 'aider', 'kimicode', 'goose', 'copilot',
  'installer', 'four-split', 'three-split', 'two-split',
]);

// Tabs that show the status-grid ("Dynamic Island") indicator: every AI CLI.
// Hook-wired tools (claude/codex/opencode/mimocode/hermes/kimicode) drive it
// live off session.agentStatus; the rest have no status bus and sit at
// static 'idle' green — the "fake island" baseline so every AI-CLI tab reads
// consistently.
// Non-CLI tabs (terminal/remote/history/splits/installer) get no indicator.
const TAB_STATUS_TOOLS = new Set<string>([
  'claude', 'codex', 'grok', 'opencode', 'mimocode', 'hermes',
  'antigravity', 'qwen', 'openclaw',
  'pi', 'crush', 'aider', 'kimicode', 'goose', 'copilot',
]);

export function CenterPanel() {
  const { state, dispatch } = useAppState();
  const t = useT();
  const terminals = state.terminals;
  const activeTerminalId = state.activeTerminalId;
  // Diff tab surface: visible only in tab mode with a selection. The diff
  // chrome-tab sits in the strip beside terminal tabs; diffTabActive tracks
  // whether it (not a terminal tab) is the focused surface.
  const diffTabVisible = state.diffMode === 'tab' && state.diffSelection !== null;
  const diffTabActive = state.diffTabActive;
  // Diff tab title = basename of the selected file (mirrors DiffPanel's own
  // header name). Computed here so the chrome-tab strip shows it without
  // mounting the DiffPanel body.
  const diffTabTitle = useMemo(() => {
    const p = state.diffSelection?.path ?? '';
    return p.replace(/\\/g, '/').split('/').pop() || p || (t('task.tab.changes' as any) || 'Diff');
  }, [state.diffSelection?.path, t]);

  // Toast carries an id (timestamp) so React re-mounts the element on
  // every showToast() call — the slideDownToast animation is `forwards`
  // and only runs once per mount, so without a fresh key, rapid
  // back-to-back toasts wouldn't visually re-trigger (user sees nothing
  // after the first one even though state is updating). Keying by id
  // forces a remount → fresh animation pass each time.
  const [toast, setToast] = useState<{ msg: string; id: number } | null>(null);
  const showToast = (msg: string) => setToast({ msg, id: Date.now() });
  const [toolsInstalled, setToolsInstalled] = useState<Record<string, boolean>>({});
  // Per-tool launch override modal (gear icon → opens settings for that tool).
  const [configModalTool, setConfigModalTool] = useState<{ key: string; label: string } | null>(null);
  const [showLibrary, setShowLibrary] = useState(false);
  const [libraryTab, setLibraryTab] = useState<'agents' | 'skills'>('agents');
  const [pinnedItems, setPinnedItems] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem('coffee_pinned_items');
      if (stored !== null) {
        let arr = JSON.parse(stored);
        if (!Array.isArray(arr)) return [];
        // Migrate the retired multi-agent pin to four-split so upgrading
        // users keep a card in that home-screen slot instead of an empty
        // hole — the coordinated multi-agent tool was removed and the
        // independent four-split is its closest replacement. Dedup after,
        // in case four-split was already pinned.
        arr = arr.map((id: unknown) => (id === 'agent:multi-agent' ? 'agent:four-split' : id));
        arr = arr.filter((id: unknown, i: number) => arr.indexOf(id) === i);
        // Drop stale pin IDs from retired AGENT_CATALOG entries (e.g.
        // `agent:vibeid` after /vibeid became a skill, or the other retired
        // coordinated tools `agent:two-agent` / `agent:three-agent` /
        // `agent:hyper-agent`). These ghosts render nothing but inflate the
        // "Agents N" counter.
        arr = arr.filter((id: unknown) =>
          typeof id === 'string' && id.startsWith('agent:') && VALID_PIN_KEYS.has(id.slice('agent:'.length))
        );
        try { localStorage.setItem('coffee_pinned_items', JSON.stringify(arr)); } catch {}
        return arr;
      }
      // First launch: pre-pin a useful default set so the desktop isn't
      // empty out of the box (4 AI CLIs covering major providers + 2
      // utilities). Returning users' pin choices are respected (stored !==
      // null path above).
      const defaults = [
        'agent:claude',
        'agent:codex',
        'agent:opencode',
        'agent:antigravity',
        'agent:four-split',
        'agent:terminal',
      ];
      localStorage.setItem('coffee_pinned_items', JSON.stringify(defaults));
      return defaults;
    } catch { return []; }
  });

  // Agent list is fully local (baked into BUILTIN_AI_CLI_FALLBACK below) — no
  // loading / cache state here. The remote catalog fetch at
  // coffeecli.com/agents/catalog.json was deleted in v1.1.5 to eliminate
  // first-paint icon flashes and reduce startup network dependency.

  // Built-in inline SVG icons keyed by agent id. Used when catalog entry id matches;
  // otherwise falls back to entry.icon URL.
  const BUILTIN_ICONS: Record<string, React.ReactNode> = {
    claude: <SvgClaude />,
    opencode: <SvgOpenCode />,
    mimocode: <SvgMimo />,
    openclaw: <SvgOpenClaw />,
    codex: <SvgCodex />,
    grok: <SvgGrok />,
    antigravity: <SvgAntigravity />,
    qwen: <SvgQwen />,
    hermes: <SvgHermes />,
    pi: <SvgPi />,
    crush: <SvgCrush />,
    aider: <SvgAider />,
    kimicode: <SvgKimi />,
    goose: <SvgGoose />,
    copilot: <SvgCopilot />,
  };

  // Built-in AI CLI catalog. Fully local — no remote fetch. Display
  // names are sourced from the Rust registry (see lib/tool-info.ts);
  // the order here is the launchpad's preferred presentation order.
  const BUILTIN_AI_CLI_FALLBACK: { key: ToolType; label: string }[] = [
    'claude', 'opencode', 'mimocode', 'openclaw', 'codex', 'grok', 'antigravity', 'qwen', 'hermes',
    // Pi (T2) + Crush/Aider/Goose/Copilot (T3 launch-only). Kimi Code is T1.
    'pi', 'crush', 'aider', 'kimicode', 'goose', 'copilot',
  ].map((key) => ({ key: key as ToolType, label: getToolDisplayName(key) }));

  // Unified agent catalog — fully local. The remote catalog fetch
  // (coffeecli.com/agents/catalog.json) was deleted in v1.1.5; product
  // decision is that software is bundled with the app (delete-logic-not-add).
  // AI CLIs and utilities are both hardcoded below.
  // - `type`: semantic category ('ai-cli' | 'utility'). Lets future code group/filter items.
  // - `requiresCwd`: behavior flag — drives folder-button + cwd display on Desktop cards.
  const AGENT_CATALOG: { key: ToolType; label: string; icon: React.ReactNode; type: 'ai-cli' | 'utility'; requiresCwd: boolean }[] = (() => {
    // OpenClaw (persona forge) is directory-agnostic — its primary
    // workflow is global persona/skill management, not a project folder.
    // Skip the folder-picker + cwd display so it launches in one click,
    // like utilities. Hermes Agent IS folder-aware (its splash screen
    // displays the launch cwd, and its tools can scope to a project),
    // so it gets the folder-picker on its launchpad card just like
    // Claude Code / Codex.
    const CWD_AGNOSTIC_AI_CLI = new Set<ToolType>(['openclaw']);
    const aiCliEntries = BUILTIN_AI_CLI_FALLBACK.map(item => ({
      key: item.key,
      label: item.label,
      icon: BUILTIN_ICONS[item.key as string] ?? null,
      type: 'ai-cli' as const,
      requiresCwd: !CWD_AGNOSTIC_AI_CLI.has(item.key),
    }));

    // "Agent Tools" grid on the Library page: Terminal + Coffee 101, then
    // the independent split tools descending 4→3→2.
    const utilities = [
      // Terminal is an AI-CLI-like tool (needs cwd) rather than a 'utility'.
      { key: 'terminal' as ToolType, label: t('tool.terminal'), icon: <TerminalIcon />, type: 'ai-cli' as const, requiresCwd: true },
      { key: 'installer' as ToolType, label: 'Coffee 101', icon: <SvgInstaller />, type: 'utility' as const, requiresCwd: false },
      // ─── Independent split (descending 4→3→2): N side-by-side PTYs ──
      {
        key: 'four-split' as ToolType,
        label: t('tool.four_split' as any),
        icon: <SvgFourSplit />,
        type: 'utility' as const,
        requiresCwd: false,
      },
      {
        key: 'three-split' as ToolType,
        label: t('tool.three_split' as any),
        icon: <SvgThreeSplit />,
        type: 'utility' as const,
        requiresCwd: false,
      },
      {
        key: 'two-split' as ToolType,
        label: t('tool.two_split' as any),
        icon: <SvgTwoSplit />,
        type: 'utility' as const,
        requiresCwd: false,
      },
    ];

    return [...aiCliEntries, ...utilities];
  })();

  const togglePin = (id: string) => {
    setPinnedItems(prev => {
      const isPinned = prev.includes(id);
      let next: string[];
      if (isPinned) {
        next = prev.filter(x => x !== id);
      } else {
        next = [...prev, id];
      }
      try { localStorage.setItem('coffee_pinned_items', JSON.stringify(next)); } catch {}
      return next;
    });
  };

  // (renderPinIcon removed — selection state is now indicated by the
  // .library-item.is-pinned border + opacity, not a right-side icon.)
  // Tracks last successful checkToolsInstalled() scan (epoch ms). Used
  // to skip the back-to-desktop re-scan if it would just repeat work
  // we already did seconds ago — the laggy "click 9-dot, wait, library
  // opens" feel was 7 CLIs × up to 1s of serial PATH scan blocking the
  // IPC queue between back-click and the next 9-dot click.
  const lastToolsScanAt = useRef<number>(0);
  // Previous toolsInstalled snapshot — diffed against each new scan so
  // we can fire installHookForTool exactly when a CLI flips from
  // not-installed → installed during a Coffee CLI session. `null`
  // sentinel = "we haven't scanned yet"; the very first scan does not
  // trigger any install IPCs because startup's install_all() already
  // covered whatever was on PATH at launch — diffing against `null`
  // would re-fire those redundantly.
  const prevToolsInstalledRef = useRef<Record<string, boolean> | null>(null);
  const applyToolsInstalled = (result: Record<string, boolean>) => {
    const prev = prevToolsInstalledRef.current;
    if (prev !== null) {
      for (const tool of Object.keys(result)) {
        if (result[tool] === true && prev[tool] === false) {
          commands.installHookForTool(tool).catch(() => {});
        }
      }
    }
    prevToolsInstalledRef.current = result;
    // Unchanged result (the common case on a foreground rescan — tools don't
    // get installed/removed between alt-tabs) keeps the same ref so React skips
    // the re-render. setToolsInstalled always receives a fresh IPC object, so
    // without this an unchanged rescan reconciles the whole CenterPanel and a
    // tab switch right after returning to the foreground stutters (#43 #5).
    setToolsInstalled(curr => {
      const keys = Object.keys(result);
      const same = keys.length === Object.keys(curr).length
        && keys.every(k => curr[k] === result[k]);
      return same ? curr : result;
    });
    lastToolsScanAt.current = Date.now();
  };

  // ── Remote Terminal SSH form state ─────────────────────────────────────────
  const [showRemoteForm, setShowRemoteForm] = useState(false);
  const [remoteProtocol, setRemoteProtocol] = useState<'ssh' | 'ws'>('ssh');
  const [sshHost, setSshHost] = useState('');
  const [sshPort, setSshPort] = useState('22');
  const [sshUser, setSshUser] = useState('root');
  const [sshPass, setSshPass] = useState('');
  
  const [remoteHistory, setRemoteHistory] = useState<RemoteHistoryItem[]>(() => {
    try { return JSON.parse(localStorage.getItem('remote_terminal_history') || '[]'); } catch { return []; }
  });

  const saveRemoteHistory = (item: Omit<RemoteHistoryItem, 'id'>) => {
    setRemoteHistory(prev => {
      const filtered = prev.filter(p => !(p.host === item.host && p.port === item.port && p.protocol === item.protocol));
      const next = [{ id: crypto.randomUUID(), ...item }, ...filtered].slice(0, 10);
      localStorage.setItem('remote_terminal_history', JSON.stringify(next));
      return next;
    });
  };

  const deleteRemoteHistory = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setRemoteHistory(prev => {
      const next = prev.filter(p => p.id !== id);
      localStorage.setItem('remote_terminal_history', JSON.stringify(next));
      return next;
    });
  };
  const [connStatus, setConnStatus] = useState<'idle' | 'connecting' | 'failed'>('idle');
  const [lastCwdByTool, setLastCwdByTool] = useState<Record<string, string>>({});
  // Global recent project folders (across all folder-using tools) — backs the
  // folder-icon dropdown. Separate from the per-tool last-cwd above.
  const [recentFolders, setRecentFolders] = useState<string[]>(() => {
    try { const r = localStorage.getItem('coffee:recent-folders'); return r ? JSON.parse(r) : []; } catch { return []; }
  });
  const [folderMenu, setFolderMenu] = useState<{ x: number; y: number; tool: ToolType } | null>(null);
  const pushRecentFolder = (folder: string) => {
    setRecentFolders(prev => {
      const next = [folder, ...prev.filter(f => f !== folder)].slice(0, 8);
      try { localStorage.setItem('coffee:recent-folders', JSON.stringify(next)); } catch {}
      return next;
    });
  };
  const removeRecentFolder = (folder: string) => {
    setRecentFolders(prev => {
      const next = prev.filter(f => f !== folder);
      try { localStorage.setItem('coffee:recent-folders', JSON.stringify(next)); } catch {}
      return next;
    });
  };

  // ── Global focus enforcer ────────────────────────────────────────────────
  // One pair of window listeners for the whole app (previously each
  // TierTerminal added its own focusin + mouseup handlers, causing O(N)
  // dispatch per click with N tabs). When focus wanders to the body or a
  // non-input element, steal it back for the currently active terminal.
  const activeIdRef = useRef(activeTerminalId);
  useEffect(() => { activeIdRef.current = activeTerminalId; }, [activeTerminalId]);
  useEffect(() => {
    const enforce = () => {
      setTimeout(() => {
        const el = document.activeElement;
        // Any focused INPUT/TEXTAREA is the real target, INCLUDING xterm's
        // .xterm-helper-textarea. Earlier this branch excluded the xterm
        // helper to "steal focus back to the active terminal", but that
        // broke the multi-agent quadrant — every pane has its own xterm
        // helper, and stealing the focus always landed on the wrong one.
        // The enforcer now only pulls focus back when it wanders to
        // genuinely non-input DOM (<div>, <body>, a clicked tab bar).
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
          return;
        }
        const id = activeIdRef.current;
        if (id) focusTerminal(id);
      }, 10);
    };
    window.addEventListener('focusin', enforce);
    window.addEventListener('mouseup', enforce);
    return () => {
      window.removeEventListener('focusin', enforce);
      window.removeEventListener('mouseup', enforce);
    };
  }, []);

  // Load sticky config — non-sensitive fields from localStorage, password from OS keychain
  useEffect(() => {
    try {
      const saved = localStorage.getItem('coffee_remote_cfg');
      if (saved) {
        const c = JSON.parse(saved);
        if (c.protocol) setRemoteProtocol(c.protocol);
        if (c.host) setSshHost(c.host);
        if (c.port) setSshPort(String(c.port));
        if (c.username) setSshUser(c.username);
        if (isTauri && c.host && c.username) {
          commands.loadPassword(c.host, c.username)
            .then(pw => { if (pw) setSshPass(pw); })
            .catch(() => {});
        }
      }
    } catch (e) {}
  }, []);

  // Derived state — must be before hooks that depend on it
  const activeSession = terminals.find(t => t.id === activeTerminalId);
  const isLaunchpadMode = activeSession && activeSession.tool === null;
  // Mirrored into a ref so the window-foreground rescan (which has [] deps and
  // can't see the latest value otherwise) can skip work while in a terminal tab.
  const isLaunchpadModeRef = useRef(isLaunchpadMode);
  useEffect(() => { isLaunchpadModeRef.current = isLaunchpadMode; }, [isLaunchpadMode]);



  // Detect tool availability only when the Desktop (not Library) is actually visible.
  // Library is pure UI: pin/unpin never trigger IPC, scan is silent during browsing.
  // Scan runs on:
  //   - Launchpad first shown
  //   - Remote catalog refreshed
  //   - User returns from Library to Desktop (back arrow) — picks up new pins' install state
  // Never on pinnedItems changes → pin click stays instant.
  useEffect(() => {
    if (!isTauri || !isLaunchpadMode) return;
    if (showLibrary) return; // Library open: stay silent
    // Debounce: rapid 9-dot ↔ back toggles would otherwise stack up
    // checkToolsInstalled() IPCs (PATH scan for 7 CLIs, ~200ms-1s each
    // on Windows). The serial IPC queue blocked React reconciliation
    // and the next mode-switch click looked dead. Only fire after the
    // user has actually settled on the launchpad for 300ms.
    //
    // Cache gate (30s TTL): tool install state doesn't change just
    // because the user toggled in/out of Library — binaries are on
    // PATH or not regardless of pin actions. Skipping the rescan when
    // we just did one seconds ago kills the "click back, wait, click
    // 9-dot, lag" feel without losing the legitimate refresh-after-
    // a-real-install case (TTL expires after idle).
    const SCAN_TTL_MS = 30_000;
    const handle = setTimeout(() => {
      if (Date.now() - lastToolsScanAt.current < SCAN_TTL_MS) return;
      commands.checkToolsInstalled()
        .then(applyToolsInstalled)
        .catch(() => {});
      try {
        const raw = localStorage.getItem('coffee:last-cwd-by-tool');
        if (raw) setLastCwdByTool(JSON.parse(raw));
      } catch {}
    }, 300);
    return () => clearTimeout(handle);
  }, [isLaunchpadMode, showLibrary]);

  // Window-focus rescan — picks up CLIs the user just installed in an
  // external terminal without forcing them to restart Coffee CLI. The
  // launchpad-mode useEffect above only re-fires when isLaunchpadMode
  // / showLibrary actually change; sitting on the launchpad while
  // alt-tabbing out to install a CLI doesn't toggle either, so the
  // scan-cache stays warm and the gray card never flips. Focus event
  // is the natural "user just came back, may have done something
  // external" signal. Bypasses the SCAN_TTL_MS cache for the same
  // reason. Debounced (500ms) so rapid alt-tab spam doesn't stack
  // up serial PATH scans on the IPC queue.
  //
  // Routed through window-focus-filter so the spurious blur+focus pair
  // emitted by `start_dragging()` on Windows doesn't fire a 770ms PATH
  // scan every time the user grabs the titlebar (root cause of the
  // first-drag stall on Windows; Linux is unaffected).
  useEffect(() => {
    if (!isTauri) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = onWindowForeground(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        // Only the launchpad shows per-tool install state. Rescanning while the
        // user is inside a terminal tab is wasted work whose setState reflows
        // the whole CenterPanel, making the next tab switch stutter (#43 #5).
        // Re-entering the launchpad runs its own (TTL-gated) rescan anyway.
        if (!isLaunchpadModeRef.current) return;
        commands.checkToolsInstalled()
          .then(applyToolsInstalled)
          .catch(() => {});
      }, 500);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, []);

  // Auto-hide toast — keyed on toast.id so rapid replacements (toggle
  // spam) reset the timer cleanly: previous timer is cleared, new 3s
  // window starts from the latest message.
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [toast?.id]);


  const handleAddTab = () => {
    dispatch({
      type: 'ADD_TERMINAL',
      session: { id: crypto.randomUUID(), tool: null, folderPath: null }
    });
  };

  // External launch (`coffee-cli launch --tool <id> [--cwd <dir>]`) — reached
  // from the cold-start drain (takePendingLaunch) and the warm-start
  // single-instance forward ('launch-request' event). Reuses an idle
  // launchpad tab when one exists so the agent never hijacks a tab that
  // already runs a session; otherwise opens a fresh tab (no cap — matches
  // the + button, which is also uncapped so launcher scripts never stall).
  const launchCtxRef = useRef({ terminals, activeTerminalId });
  useEffect(() => { launchCtxRef.current = { terminals, activeTerminalId }; });
  const applyLaunchRequest = (tool: ToolType, cwd?: string) => {
    if (!BUILTIN_AI_CLI_FALLBACK.some(item => item.key === tool)) return;
    const { terminals: terms, activeTerminalId: activeId } = launchCtxRef.current;
    const current = terms.find(t => t.id === activeId);
    let id: string;
    if (current && current.tool === null) {
      id = current.id;
    } else {
      const idle = terms.find(t => t.tool === null);
      if (idle) {
        id = idle.id;
        dispatch({ type: 'SET_ACTIVE_TERMINAL', id });
      } else {
        id = crypto.randomUUID();
        dispatch({ type: 'ADD_TERMINAL', session: { id, tool: null, folderPath: cwd ?? null } });
      }
    }
    if (cwd) {
      dispatch({ type: 'SET_FOLDER', path: cwd });
      setLastCwdByTool(prev => {
        const next = { ...prev, [tool as string]: cwd };
        try { localStorage.setItem('coffee:last-cwd-by-tool', JSON.stringify(next)); } catch { /* storage full/blocked — non-fatal */ }
        return next;
      });
      pushRecentFolder(cwd);
    }
    dispatch({ type: 'SET_TERMINAL_TOOL', id, tool });
  };

  // Drain the cold-start launch request once on mount, then keep listening
  // for warm-start forwards emitted by the single-instance plugin (second
  // process invoked as `launch …` — the running instance never restarts).
  useEffect(() => {
    if (!isTauri) return;
    commands.takePendingLaunch()
      .then(req => { if (req) applyLaunchRequest(req.tool as ToolType, req.cwd); })
      .catch(() => {});
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        unlisten = await listen<{ tool: string; cwd?: string }>('launch-request', e => {
          applyLaunchRequest(e.payload.tool as ToolType, e.payload.cwd);
        });
      } catch { /* event bridge unavailable (e.g. browser dev) — ignore */ }
    })();
    return () => { if (unlisten) unlisten(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCloseTab = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    dispatch({ type: 'REMOVE_TERMINAL', id });
  };

  // ── Tab drag-to-reorder ─────────────────────────────────────────────────
  // Browser-style: pointer-down a tab, drag horizontally past 5px, drop
  // wherever you want it. Pointer events (not HTML5 drag-and-drop) because
  // Tauri v2 + WebView2 swallows intra-app dragstart on Windows when its
  // own file-drop capture is enabled (memory: reference_webview2_html5_drag).
  const tabsHeaderRef = useRef<HTMLDivElement | null>(null);
  // Active drag state. `fromIdx` / `targetIdx` are positions in the
  // **visible tab strip** (filtered, in DOM order) — not the underlying
  // `state.terminals` array — because the slide-aside math operates on
  // what the user actually sees. `slotWidth` is the dragged tab's
  // visual footprint (own width + the flex `gap`); siblings translateX
  // by ±slotWidth to make room.
  const [tabDrag, setTabDrag] = useState<{
    sessionId: string;
    deltaX: number;
    fromIdx: number;
    targetIdx: number;
    slotWidth: number;
  } | null>(null);
  // Suppress the click that would otherwise fire on pointerup at end of
  // a drag (the click handler activates the tab — we don't want a drop
  // to count as an activation if the tab moved).
  const tabDragSuppressClickRef = useRef(false);

  // The chrome tab strip renders into the titlebar (Windows-Terminal style),
  // not a separate row inside the content — the tabs sit on the drag bar like
  // Chrome / the OS terminals. We keep ALL the tab logic/state here (the tabs
  // ARE the center's terminals) and just portal the rendered strip up into
  // TitleBar's #titlebar-tab-slot. Slot resolves after first mount; the strip
  // renders one frame later, which is imperceptible.
  const [tabSlot, setTabSlot] = useState<HTMLElement | null>(null);
  useEffect(() => { setTabSlot(document.getElementById('titlebar-tab-slot')); }, []);

  const onTabPointerDown = (e: React.PointerEvent<HTMLDivElement>, sessionId: string) => {
    // Ignore non-primary buttons + clicks on close button / status indicator
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('.tab-close-btn')) return;

    const headerEl = tabsHeaderRef.current;
    if (!headerEl) return;

    // Snapshot every visible tab's center X at drag start. Used by
    // drop AND by the shift math during drag — DOM is animating
    // during drag, so re-measuring would feed back into itself.
    const tabEls = Array.from(
      headerEl.querySelectorAll<HTMLElement>('.chrome-tab[data-session-id]'),
    );
    const positions = tabEls.map(el => {
      const rect = el.getBoundingClientRect();
      return {
        sessionId: el.dataset.sessionId!,
        center: rect.left + rect.width / 2,
        width: rect.width,
      };
    });
    const fromIdx = positions.findIndex(p => p.sessionId === sessionId);
    if (fromIdx < 0) return;
    const ownPos = positions[fromIdx];

    // Dragged tab's "occupied slot width" = distance from its center to
    // its nearest neighbor's center. This includes the flex `gap`
    // between tabs, so siblings shifting by slotWidth visually fill
    // the vacated slot exactly.
    let slotWidth: number;
    if (fromIdx + 1 < positions.length) {
      slotWidth = positions[fromIdx + 1].center - ownPos.center;
    } else if (fromIdx > 0) {
      slotWidth = ownPos.center - positions[fromIdx - 1].center;
    } else {
      slotWidth = ownPos.width; // only one tab — no siblings to shift anyway
    }

    const startX = e.clientX;
    let started = false;
    const THRESHOLD = 5;

    // For a given cursor X, what's the without-dragged-array index that
    // the dragged tab would land on? Derived from the dragged tab's
    // visual center vs every OTHER tab's recorded center. Returns a
    // value in [0, positions.length - 1] — same domain as the
    // `insertIdx` the reducer uses.
    const computeTargetIdx = (clientX: number): number => {
      const draggedCenter = ownPos.center + (clientX - startX);
      let count = 0;
      for (let i = 0; i < positions.length; i++) {
        if (i === fromIdx) continue;
        if (positions[i].center > draggedCenter) return count;
        count++;
      }
      return count;
    };

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (!started && Math.abs(dx) < THRESHOLD) return;
      started = true;
      setTabDrag({
        sessionId,
        deltaX: dx,
        fromIdx,
        targetIdx: computeTargetIdx(ev.clientX),
        slotWidth,
      });
    };

    const onUp = (ev: PointerEvent) => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      if (started) {
        // Suppress the upcoming click (tab activation) — the user dragged,
        // they didn't click. Cleared on the next click that fires.
        tabDragSuppressClickRef.current = true;
        const targetIdx = computeTargetIdx(ev.clientX);
        // beforeId = the tab at `targetIdx` in the without-dragged strip;
        // `null` when dropping past every other tab (insert at end).
        const others = positions.filter((_, i) => i !== fromIdx);
        const beforeId = targetIdx < others.length ? others[targetIdx].sessionId : null;
        dispatch({ type: 'REORDER_TERMINAL', sessionId, beforeId });
      }
      setTabDrag(null);
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  };

  const onTabClickGuarded = (sessionId: string) => {
    if (tabDragSuppressClickRef.current) {
      tabDragSuppressClickRef.current = false;
      return;
    }
    dispatch({ type: 'SET_ACTIVE_TERMINAL', id: sessionId });
  };

  const formatCwd = (cwd: string): string => {
    if (!cwd) return '';
    // Detect Windows path (e.g. C:\... or c:/...)
    const isWin = /^[a-zA-Z]:/.test(cwd);
    if (isWin) {
      // Uppercase drive letter, normalize to backslashes
      const formatted = cwd[0].toUpperCase() + ':' + cwd.slice(2).replace(/\//g, '\\');
      return formatted.length > 30 ? '\u2026' + formatted.slice(-28) : formatted;
    }
    // Unix path — show last 2 segments
    const parts = cwd.split('/').filter(Boolean);
    if (parts.length === 0) return cwd;
    const label = parts.length >= 2
      ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}`
      : parts[parts.length - 1];
    return label.length > 30 ? '\u2026' + label.slice(-28) : label;
  };

  const selectTool = (tool: ToolType, toolData?: string, cwd?: string) => {
    // Concurrent multi-agent Tabs are now supported as of the per-pane
    // MCP / per-pane system-prompt rework: each pane has its own MCP
    // listener (different port), Claude panes write zero workspace
    // files, and `list_panes` / `send_to_pane` filter by the caller's
    // own Tab id so two open multi-agent Tabs never see each other.
    // The old single-instance lock that lived here has been removed.
    if (activeTerminalId) {
      if (cwd) {
        dispatch({ type: 'SET_FOLDER', path: cwd });
        setLastCwdByTool(prev => {
          const next = { ...prev, [tool as string]: cwd };
          try { localStorage.setItem('coffee:last-cwd-by-tool', JSON.stringify(next)); } catch {}
          return next;
        });
        pushRecentFolder(cwd);
      }
      dispatch({ type: 'SET_TERMINAL_TOOL', id: activeTerminalId, tool, toolData });
    }
  };

  const handlePickFolder = async (toolKey: ToolType) => {
    if (!toolKey) return;
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({ directory: true });
      if (selected && typeof selected === 'string') {
        selectTool(toolKey, undefined, selected);
      }
    } catch (err) {
      console.error('[CenterPanel] Folder picker failed:', err);
    }
  };

  const handleRemoteConnect = async () => {
    if (!sshHost.trim()) return;
    if (remoteProtocol === 'ssh' && !sshUser.trim()) return;
    
    setConnStatus('connecting');

    saveRemoteHistory({ protocol: remoteProtocol, host: sshHost.trim(), port: sshPort.trim(), user: sshUser.trim() });

    // Validate network connection using real TCP check instead of mock
    let isOffline = false;
    try {
      const portNum = parseInt(sshPort) || (remoteProtocol === 'ssh' ? 22 : 7681);
      const isReachable = await commands.checkNetworkPort(sshHost.trim(), portNum);
      if (!isReachable) isOffline = true;
    } catch(err) {
      isOffline = true;
    }

    if (isOffline) {
      setConnStatus('failed');
      setTimeout(() => setConnStatus('idle'), 3000);
      return;
    }

    const connDataObj = {
      protocol: remoteProtocol,
      host: sshHost.trim(),
      port: parseInt(sshPort) || (remoteProtocol === 'ssh' ? 22 : 7681),
      username: sshUser.trim(),
      // password intentionally omitted — stored in OS keychain, not localStorage
    };

    try {
      localStorage.setItem('coffee_remote_cfg', JSON.stringify(connDataObj));
    } catch(e) {}

    // Save password to OS keychain (Windows Credential Manager / macOS Keychain)
    if (isTauri && sshPass) {
      commands.savePassword(sshHost.trim(), sshUser.trim(), sshPass).catch(() => {});
    }

    // connData sent in-memory to Rust for the connection — includes password
    const connData = JSON.stringify({ ...connDataObj, password: sshPass });

    selectTool('remote', connData);
    setShowRemoteForm(false);
    setConnStatus('idle');
  };

  // Last path segment, Windows ("\") and POSIX ("/") safe. null when path unknown.
  const cwdBasename = (p: string | null | undefined): string | null => {
    if (!p) return null;
    const trimmed = p.replace(/[\\/]+$/, '');
    if (!trimmed) return '/';
    if (/^[A-Za-z]:$/.test(trimmed)) return trimmed + '\\';
    const parts = trimmed.split(/[\\/]/);
    return parts[parts.length - 1] || trimmed;
  };

  // Local shell-bearing tabs show cwd basename (Explorer-style): icon = tool identity,
  // text = location. Remote/non-shell tabs keep their existing labels.
  const renderTabContent = (session: typeof terminals[0], isActive: boolean) => {
    const cwd = cwdBasename(session.folderPath);
    const pathTip = session.folderPath ?? undefined;
    switch (session.tool) {
      case 'claude': return { icon: <SvgClaude />, title: cwd ?? getToolDisplayName('claude'), tooltip: pathTip };
      case 'qwen': return { icon: <SvgQwen />, title: cwd ?? getToolDisplayName('qwen'), tooltip: pathTip };
      // OpenClaw / Hermes are directory-agnostic tools — their tab title
      // stays as the tool name regardless of any inherited folderPath.
      case 'hermes': return { icon: <SvgHermes />, title: getToolDisplayName('hermes'), tooltip: undefined };
      case 'opencode': return { icon: <SvgOpenCode />, title: cwd ?? getToolDisplayName('opencode'), tooltip: pathTip };
      case 'mimocode': return { icon: <SvgMimo />, title: cwd ?? getToolDisplayName('mimocode'), tooltip: pathTip };
      case 'openclaw': return { icon: <SvgOpenClaw />, title: getToolDisplayName('openclaw'), tooltip: undefined };
      case 'codex': return { icon: <SvgCodex />, title: cwd ?? getToolDisplayName('codex'), tooltip: pathTip };
      case 'grok': return { icon: <SvgGrok />, title: cwd ?? getToolDisplayName('grok'), tooltip: pathTip };
      case 'antigravity': return { icon: <SvgAntigravity />, title: cwd ?? getToolDisplayName('antigravity'), tooltip: pathTip };
      // Directory-aware tabs (icon + cwd basename). Pi and the T3 set
      // (Crush/Aider/Goose/Copilot) are hookless — no real status bus, so
      // they get the static "fake" island via TAB_STATUS_TOOLS below.
      // Kimi Code renders the same shape but is hook-wired (T1): its
      // island is live off session.agentStatus.
      case 'pi': return { icon: <SvgPi />, title: cwd ?? getToolDisplayName('pi'), tooltip: pathTip };
      case 'crush': return { icon: <SvgCrush />, title: cwd ?? getToolDisplayName('crush'), tooltip: pathTip };
      case 'aider': return { icon: <SvgAider />, title: cwd ?? getToolDisplayName('aider'), tooltip: pathTip };
      case 'kimicode': return { icon: <SvgKimi />, title: cwd ?? getToolDisplayName('kimicode'), tooltip: pathTip };
      case 'goose': return { icon: <SvgGoose />, title: cwd ?? getToolDisplayName('goose'), tooltip: pathTip };
      case 'copilot': return { icon: <SvgCopilot />, title: cwd ?? getToolDisplayName('copilot'), tooltip: pathTip };
      case 'remote': {
        let title = t('tool.remote') as string;
        if (session.toolData) {
          try {
            const data = JSON.parse(session.toolData);
            if (data.protocol === 'ssh' && data.username && data.host) {
              title = `${data.username}@${data.host}`;
            } else if (data.host) {
              title = data.host;
            }
          } catch (e) {}
        }
        return { icon: <TerminalIcon />, title, tooltip: undefined };
      }
      case 'terminal': return { icon: <TerminalIcon />, title: cwd ?? t('tool.terminal'), tooltip: pathTip };
      case 'two-split': return { icon: <SvgTwoSplit />, title: cwd ?? t('tool.two_split' as any), tooltip: pathTip };
      case 'three-split': return { icon: <SvgThreeSplit />, title: cwd ?? t('tool.three_split' as any), tooltip: pathTip };
      case 'four-split': return { icon: <SvgFourSplit />, title: cwd ?? t('tool.four_split' as any), tooltip: pathTip };
      default: return { icon: <SvgPlus active={isActive} />, title: t('tab.new'), tooltip: undefined };
    }
  };

  // ── Custom background (image/video) ──────────────────────────────────────
  // Background state lives in global AppState (set via theme menu in Explorer)
  const bgPath = state.bgPath;
  const bgType = state.bgType;
  // Glass AND Carbon shapes force terminal-as-transparent even without an
  // in-app wallpaper, so the backdrop bleeds through (body bg is dropped /
  // replaced by the carbon mesh in those [data-shape] overrides). Without
  // this, the xterm canvas renders its solid `bgOpaque` and covers the
  // backdrop exactly where it matters most — the largest surface.
  const isBackdropShape = state.currentShape === 'glass' || state.currentShape === 'carbon';
  const hasBg = (bgType !== 'none' && bgPath !== '') || isBackdropShape;

  // Convert wallpaper path to a displayable URL. User-picked local
  // files go through Tauri's convertFileSrc (asset protocol) for
  // zero-copy streaming, with a file:// fallback for non-Tauri
  // (e.g. browser dev) contexts.
  const [bgUrl, setBgUrl] = useState('');
  useEffect(() => {
    // Two reasons to keep bgUrl empty:
    //   1. hasBg is false — wallpaper layer is off entirely.
    //   2. hasBg is true but bgPath is empty — happens when Glass shape
    //      forces hasBg=true to pull the terminal canvas transparent,
    //      but the user has no wallpaper picked. Without this second
    //      guard, the fall-through below would call convertFileSrc('')
    //      → Tauri returns a stub asset URL → <img> renders the
    //      broken-image icon over a black backdrop. Users perceived this
    //      as "切到 Glass 后左上角出现裂开图标 + 整个区域变黑".
    if (!hasBg || !bgPath) { setBgUrl(''); return; }
    import('@tauri-apps/api/core').then(({ convertFileSrc }) => {
      setBgUrl(convertFileSrc(bgPath));
    }).catch(() => {
      setBgUrl('file:///' + bgPath.replace(/\\/g, '/'));
    });
  }, [hasBg, bgPath]);

  return (
    <>
      {/* Premium Toast Notification — Portaled to document.body so it
          escapes any ancestor's overflow:hidden and renders against
          the real viewport, not the launchpad-container interior.
          With position:fixed + viewport-relative top, the slide-down
          animation now reads as "drop in from the top of the
          window" (the iOS system-banner idiom) instead of "slide
          out from inside the terminal area." Also makes the toast
          visible in every mode (terminal mode, launchpad mode,
          library mode), not just when the launchpad is mounted. */}
      {toast && createPortal(
        <div key={toast.id} className="toast-notification">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
          {toast.msg}
        </div>,
        document.body
      )}
      {tabSlot && createPortal(
      <div ref={tabsHeaderRef} className="chrome-tabs-header" data-count={terminals.filter(s => !s.isHidden || s.id === activeTerminalId).length}>
        {(() => {
          // Pre-compute visible-strip index for each session so the inner
          // map can do O(1) shift lookups without re-filtering.
          const visibleIdxBySid = new Map<string, number>();
          let v = 0;
          for (const s of terminals) {
            if (s.isHidden && s.id !== activeTerminalId) continue;
            visibleIdxBySid.set(s.id, v++);
          }
          return terminals.map(session => {
          if (session.isHidden && session.id !== activeTerminalId) return null;

          // A terminal tab is "active" only when it's the focused surface —
          // when the diff tab is focused (diffTabActive), no terminal tab
          // should show the active highlight (the diff chrome-tab does).
          const isActive = session.id === activeTerminalId && !diffTabActive;
          const { icon, title: baseTitle } = renderTabContent(session, isActive);
          // Tool's live OSC 0/2 title (Claude Code conversation summary, etc.)
          // overrides the cwd basename when the tool has set a non-empty one.
          const title = session.toolTitle?.trim() || baseTitle;
          const isDragging = tabDrag?.sessionId === session.id;

          // Sibling shift: while a different tab is being dragged, this
          // tab translateX-es by ±slotWidth to make room for / fill in
          // the dragged tab's vacated slot. Browser-tab "slide aside".
          //
          // Math: in the visible-strip's without-dragged array, the
          // dragged tab will land at position `targetIdx`. Each sibling
          // at original visible-index `j` (j !== fromIdx) maps to a
          // without-dragged index of either `j` (if j < fromIdx) or
          // `j - 1` (if j > fromIdx). Compare that to targetIdx:
          //   - if j < fromIdx and its without-idx < targetIdx → no shift
          //   - if j < fromIdx and its without-idx >= targetIdx → shift right (+slotWidth)
          //   - if j > fromIdx and its without-idx < targetIdx → shift left (-slotWidth)
          //   - if j > fromIdx and its without-idx >= targetIdx → no shift
          let siblingShift = 0;
          if (tabDrag && !isDragging) {
            const j = visibleIdxBySid.get(session.id);
            if (j !== undefined) {
              const withoutIdx = j < tabDrag.fromIdx ? j : j - 1;
              if (j < tabDrag.fromIdx && withoutIdx >= tabDrag.targetIdx) {
                siblingShift = tabDrag.slotWidth;
              } else if (j > tabDrag.fromIdx && withoutIdx < tabDrag.targetIdx) {
                siblingShift = -tabDrag.slotWidth;
              }
            }
          }

          const dragStyle: React.CSSProperties | undefined = isDragging
            ? { transform: `translateX(${tabDrag!.deltaX}px)` }
            : siblingShift !== 0
              ? { transform: `translateX(${siblingShift}px)` }
              : undefined;

          return (
            <div
              key={session.id}
              data-session-id={session.id}
              className={`chrome-tab ${isActive ? 'active' : ''} ${isDragging ? 'dragging' : ''}`}
              style={dragStyle}
              onClick={() => onTabClickGuarded(session.id)}
              onPointerDown={(e) => onTabPointerDown(e, session.id)}
            >
              {icon}
              <span className="tab-title" style={{ flex: '0 1 auto', minWidth: 0, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>{title}</span>
              <div className="tab-actions">
                {/* Indicator gate — every AI CLI gets the island (see
                    TAB_STATUS_TOOLS). Hook-wired tools (claude/codex/opencode
                    via forwarders, mimocode via its preset-driven status
                    ticker, hermes, kimicode) drive color off session.agentStatus.
                    Hookless CLIs (antigravity/qwen/openclaw/pi, plus
                    the T3 set crush/aider/goose/copilot) have no agentStatus,
                    so the grid sits at
                    static 'idle' green — the "fake island" baseline. Non-CLI
                    tabs (terminal/remote/history/splits) get no indicator. */}
                {TAB_STATUS_TOOLS.has(session.tool as string) && (
                  <div className={`tab-status-grid status-${
                    session.agentStatus === 'wait_input' ? 'waiting' : session.agentStatus ?? 'idle'
                  }${__IS_LINUX__ ? ' tab-status-grid--static' : ''}`}>
                    {/* Linux gate — the 9 dot wave/snake/ripple animations are
                        opacity-loop infinites with box-shadow halos. WebKit2GTK
                        + Cairo doesn't promote these to compositor layers, so
                        each frame re-rasters the box-shadow blur on CPU; with
                        N tabs that's 9N indefinite repaints. Linux gets a
                        single static colored dot instead — same idle/working/
                        waiting color signal, zero animation cost. */}
                    {__IS_LINUX__
                      ? <div className="tab-status-dot tab-status-dot--solo" />
                      : Array.from({ length: 9 }, (_, i) => <div key={i} className="tab-status-dot" />)}
                  </div>
                )}
                <button
                   className="tab-close-btn"
                   onClick={(e) => handleCloseTab(e, session.id)}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                  </svg>
                </button>
              </div>
            </div>
          );
        });
        })()}

        {/* Diff tab — a peer of the terminal tabs in the strip, but not a
            PTY. Visible only in tab mode with a selection. Clicking it
            focuses the diff surface (SET_DIFF_TAB_ACTIVE); its X clears the
            diff entirely. No status-grid (diff has no agent state). */}
        {diffTabVisible && (
          <div
            className={`chrome-tab ${diffTabActive ? 'active' : ''}`}
            onClick={() => dispatch({ type: 'SET_DIFF_TAB_ACTIVE', active: true })}
          >
            {/* Diff tab glyph: a document with text lines — reads as "file
                content view" (the diff is a read-only file viewer), in the
                same icon family as the terminal/tool tabs. currentColor so
                it follows the theme like the other tab icons. */}
            <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
              <line x1="8" y1="13" x2="16" y2="13"/>
              <line x1="8" y1="17" x2="16" y2="17"/>
            </svg>
            <span className="tab-title" style={{ flex: '0 1 auto', minWidth: 0, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>{diffTabTitle}</span>
            <div className="tab-actions">
              <button
                className="tab-close-btn"
                onClick={(e) => { e.stopPropagation(); dispatch({ type: 'CLEAR_DIFF' }); }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            </div>
          </div>
        )}

        <button className="chrome-tab-new" onClick={handleAddTab}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
        </button>
      </div>,
      tabSlot)}
      <div className="main-content">

        {terminals.map(t => t.tool !== null ? (
          <div
            key={t.id}
            className="terminal-wrapper"
            data-session-id={t.id}
            style={{
              // Hide every terminal wrapper while the diff tab is focused —
              // the diff surface takes over the content area (the underlying
              // PTYs stay mounted, just not displayed).
              display: (t.id === activeTerminalId && !diffTabActive) ? 'flex' : 'none',
              width: '100%',
              height: '100%',
              position: 'relative'
            }}
          >
            {t.tool === 'two-split' ? (
              <FourSplitGrid
                tab={t}
                hasBg={hasBg}
                bgUrl={bgUrl}
                bgType={bgType}
                paneCount={2}
              />
            ) : t.tool === 'three-split' ? (
              <FourSplitGrid
                tab={t}
                hasBg={hasBg}
                bgUrl={bgUrl}
                bgType={bgType}
                paneCount={3}
              />
            ) : t.tool === 'four-split' ? (
              // Independent Quad: 4 side-by-side PTYs, each its own CLI +
              // folder, zero coordination.
              <FourSplitGrid
                tab={t}
                hasBg={hasBg}
                bgUrl={bgUrl}
                bgType={bgType}
                paneCount={4}
              />
            ) : (
              <ErrorBoundary key={`err-${t.id}-${t.restartKey || 0}`} fallbackLabel="Tier Terminal Error">
                <TierTerminal
                  key={`tier-${t.id}-${t.restartKey || 0}`}
                  sessionId={t.id}
                  tool={t.tool}
                  toolName={AGENT_CATALOG.find(a => a.key === t.tool)?.label}
                  theme={state.currentTheme}
                  lang={state.currentLang}
                  isActive={t.id === activeTerminalId && !diffTabActive}
                  toolData={t.toolData}
                  folderPath={t.folderPath}
                  resumeToken={t.resumeToken}
                  hasBg={hasBg}
                  bgUrl={bgUrl}
                  bgType={bgType}
                  termColorScheme={state.termColorScheme}
                  termFont={state.termFont}
                />
              </ErrorBoundary>
            )}
          </div>
        ) : null)}

        {/* Diff tab content — fills the content area when the diff tab is
            focused. The DiffPanel body handles its own loading/error/too-large
            states; mode="tab" makes it fill this slot (no portal/backdrop). */}
        {diffTabVisible && diffTabActive && state.diffSelection && (
          <div className="terminal-wrapper" style={{ display: 'flex', width: '100%', height: '100%', position: 'relative' }}>
            <DiffPanel
              mode="tab"
              path={state.diffSelection.path}
              repoRoot={state.diffSelection.repoRoot}
              rel={state.diffSelection.rel}
              kind={state.diffSelection.kind}
              commitHash={state.diffSelection.commitHash}
              onClose={() => dispatch({ type: 'CLEAR_DIFF' })}
              onToggleExpanded={() => dispatch({ type: 'SET_DIFF_MODE', mode: 'overlay' })}
              added={state.diffSelection.added}
              deleted={state.diffSelection.deleted}
            />
          </div>
        )}

        {isLaunchpadMode && activeTerminalId && !diffTabActive && (
          <div className={`launchpad-container${hasBg && bgUrl ? ' launchpad-has-bg' : ''}`} style={{ position: 'relative' }}>
            {hasBg && bgUrl && (
              <div className="launchpad-bg">
                {bgType === 'video'
                  ? <video src={bgUrl} autoPlay loop muted playsInline onError={() => { setBgUrl(''); }} />
                  : <img src={bgUrl} alt="" onError={() => { setBgUrl(''); }} />}
              </div>
            )}
            {/* Close button removed: handles via Tab bar */}
            <div className="launchpad-slider-viewport">
              <div className={`launchpad-slider-track ${showLibrary ? 'slide-to-library' : ''}`}>

                {/* ─── Page 1: Desktop (pinned items) ─── */}
                <div className="launchpad-page">
                  <div className="launchpad-inner">
                    {(() => {
                      const pinnedAgents = AGENT_CATALOG.filter(a => pinnedItems.includes(`agent:${a.key}`));

                      if (pinnedAgents.length === 0) {
                        return null;
                      }

                      // Coordinated multi-agent is single-instance. If any
                      // Concurrent multi-agent Tabs are now supported —
                      // each Tab gets its own per-pane MCP servers on
                      // distinct ports, Claude panes write zero workspace
                      // files, and the MCP `list_panes` / `send_to_pane`
                      // tools filter by Tab id. So we no longer grey out
                      // the multi-agent cards just because one Tab is
                      // already open.
                      return (
                        <div className="launchpad-grid">
                          {pinnedAgents.map(tool => {
                            const isTerminal = tool.key === 'terminal';
                            const installed = isTerminal || toolsInstalled[tool.key ?? ''] !== false;
                            const disabled = !installed;
                            return (
                              <div key={`agent-${tool.key}`} className={`launchpad-card-group ${disabled ? 'launchpad-card-disabled' : ''}`}>
                                <div
                                  className="launchpad-card"
                                  onClick={() => {
                                    if (disabled) return;
                                    // The "Coffee 101" card (key kept as
                                    // 'installer' for backward compat with
                                    // pinned-state in localStorage) is no
                                    // longer a one-click installer — that
                                    // approach was abandoned because reliable
                                    // cross-platform install of git/node/
                                    // python + each AI CLI is intractable
                                    // and failure modes leave users worse off
                                    // than self-serve. The card now opens the
                                    // Claude Code course on coffeecli.com,
                                    // which is the upstream of all our
                                    // install/usage knowledge.
                                    if (tool.key === 'installer') {
                                      commands.openUrl('https://coffeecli.com/courses/claude-code').catch(() => {});
                                      return;
                                    }
                                    selectTool(tool.key, undefined, lastCwdByTool[tool.key!]);
                                  }}
                                >
                                  <div className="launchpad-icon">{tool.icon}</div>
                                  <div className="launchpad-card-info">
                                    <span style={isTerminal ? { display: 'inline-flex', alignItems: 'center', gap: '6px' } : undefined}>
                                      {tool.label}
                                      {isTerminal && (
                                        <span
                                          className="remote-link-hint"
                                          onClick={(e) => { e.stopPropagation(); setShowRemoteForm(true); }}
                                        >
                                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                            <circle cx="12" cy="12" r="10"/>
                                            <path d="M2 12h20"/>
                                            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
                                          </svg>
                                        </span>
                                      )}
                                    </span>
                                    {tool.requiresCwd && lastCwdByTool[tool.key!] && (
                                      <span className="launchpad-card-cwd">
                                        {formatCwd(lastCwdByTool[tool.key!])}
                                      </span>
                                    )}
                                  </div>
                                  {tool.requiresCwd && (
                                    <div className="launchpad-folder-btn" onClick={(e) => {
                                      e.stopPropagation();
                                      if (disabled) return;
                                      // No recents yet → behave like before (straight to the picker).
                                      if (recentFolders.length === 0) { handlePickFolder(tool.key!); return; }
                                      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                      setFolderMenu({ x: r.left, y: r.bottom + 4, tool: tool.key! });
                                    }}>
                                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                                      </svg>
                                    </div>
                                  )}
                                </div>
                              </div>
                            );
                          })}

                        </div>
                      );
                    })()}

                    {/* "Can't detect?" help link - for users whose PATH was
                        garbled by an English-only AI terminal tool: CJK /
                        non-ASCII path segments become mojibake so `where`
                        can't resolve the binary and the card stays greyed.
                        Hover reveals the cause + 3 fixes. Sits between the
                        pinned cards and the heatmap; tiny + muted so it
                        doesn't compete with the cards. Tooltip is a themed
                        data-tip pill (same pattern as the heatmap / commit
                        subject tooltips), not a native title=. */}
                    <div className="detect-help">
                      <span
                        className="detect-help-trigger"
                        data-tip={t('launchpad.detect_help_tip' as any)}
                      >
                        {t('launchpad.detect_help_trigger' as any)}
                      </span>
                      {/* "Switch model" — external link to EchoBird, our
                          sister project for switching/comparing AI models.
                          Sits next to "Can't detect?" in the same muted
                          footer row. Tooltip explains where it goes; click
                          opens via commands.openUrl (system browser, NOT an
                          in-app webview — we don't do in-app viewers, see
                          feedback_no_in_app_file_viewers). Same data-tip pill
                          pattern as the detect-help trigger. */}
                      <a
                        className="switch-model-trigger"
                        href="https://echobird.ai/"
                        target="_blank"
                        rel="noopener noreferrer"
                        data-tip={t('launchpad.switch_model_tip' as any)}
                        onClick={(e) => {
                          e.preventDefault();
                          commands.openUrl('https://echobird.ai/').catch(() => {});
                        }}
                      >
                        {t('launchpad.switch_model_trigger' as any)}
                      </a>
                    </div>

                    {/* Activity heatmap — sits below the pinned cards so
                        when Gambit's input panel grows from the bottom and
                        squeezes available height, the heatmap (decorative)
                        gets cropped first, not the pinned cards (functional).
                        Renders independently of pinned state so a brand-
                        new install still sees the grid. */}
                    <ContributionHeatmap />

                    {/* ─── Remote Terminal Connection Form ─── */}
                    {showRemoteForm && (
                      <div className="remote-form-overlay">
                        <div className="remote-form-wrapper">
                          <div className="remote-form-card">
                            <div className="remote-form-header">
                            <TerminalIcon />
                            <span>{t('remote.title' as any)}</span>
                            <button className="remote-form-close" onClick={() => setShowRemoteForm(false)}>
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                            </button>
                          </div>
                          <div className="remote-form-body">
                            {/* Protocol Toggle */}
                            <div className="remote-protocol-toggle">
                              <button
                                className={`remote-proto-btn ${remoteProtocol === 'ssh' ? 'active' : ''}`}
                                onClick={() => { setRemoteProtocol('ssh'); setSshPort('22'); }}
                              >SSH</button>
                              <button
                                className={`remote-proto-btn ${remoteProtocol === 'ws' ? 'active' : ''}`}
                                onClick={() => { setRemoteProtocol('ws'); setSshPort('7681'); }}
                              >WebSocket</button>
                            </div>
                            <div className="remote-form-row">
                              <label>{t('remote.host' as any)}</label>
                              <div className="remote-form-host-row">
                                <input
                                  type="text"
                                  placeholder={t('remote.host_placeholder' as any) || "192.168.1.100"}
                                  value={sshHost}
                                  onChange={e => setSshHost(e.target.value)}
                                  className="remote-input remote-input-host"
                                  autoFocus
                                  onKeyDown={e => e.key === 'Enter' && handleRemoteConnect()}
                                />
                                <span className="remote-port-sep">:</span>
                                <input
                                  type="text"
                                  placeholder={remoteProtocol === 'ssh' ? '22' : '7681'}
                                  value={sshPort}
                                  onChange={e => setSshPort(e.target.value)}
                                  className="remote-input remote-input-port"
                                  onKeyDown={e => e.key === 'Enter' && handleRemoteConnect()}
                                />
                              </div>
                            </div>
                            {remoteProtocol === 'ssh' && (
                              <>
                                <div className="remote-form-row">
                                  <label>{t('remote.username' as any)}</label>
                                  <input
                                    type="text"
                                    placeholder="root"
                                    value={sshUser}
                                    onChange={e => setSshUser(e.target.value)}
                                    className="remote-input"
                                    onKeyDown={e => e.key === 'Enter' && handleRemoteConnect()}
                                  />
                                </div>
                                <div className="remote-form-row">
                                  <label>{t('remote.password' as any)}</label>
                                  <input
                                    type="password"
                                    value={sshPass}
                                    onChange={e => setSshPass(e.target.value)}
                                    className="remote-input"
                                    onKeyDown={e => e.key === 'Enter' && handleRemoteConnect()}
                                  />
                                </div>
                              </>
                            )}
                            <button
                              className={`remote-connect-btn status-${connStatus}`}
                              onClick={handleRemoteConnect}
                              disabled={!sshHost.trim() || (remoteProtocol === 'ssh' && !sshUser.trim()) || connStatus !== 'idle'}
                            >
                              {connStatus === 'connecting' && t('remote.connecting' as any)}
                              {connStatus === 'failed' && t('remote.connect_failed' as any)}
                              {connStatus === 'idle' && t('remote.connect' as any)}
                            </button>
                          </div>
                        </div>

                        {/* History Pills */}
                        {remoteHistory.length > 0 && (
                          <div className="remote-history-pills">
                            {remoteHistory.map(item => (
                              <div
                                key={item.id}
                                className={`remote-pill remote-pill-${item.protocol}`}
                                onClick={async () => {
                                  setRemoteProtocol(item.protocol);
                                  setSshHost(item.host);
                                  setSshPort(item.port);
                                  if (item.protocol === 'ssh') setSshUser(item.user);
                                  
                                  setConnStatus('connecting');
                                  saveRemoteHistory(item); // Refresh history order
                                  
                                  let isOffline = false;
                                  try {
                                    const portNum = parseInt(item.port) || (item.protocol === 'ssh' ? 22 : 7681);
                                    const isReachable = await commands.checkNetworkPort(item.host.trim(), portNum);
                                    if (!isReachable) isOffline = true;
                                  } catch(err) {
                                    isOffline = true;
                                  }

                                  if (isOffline) {
                                    setConnStatus('failed');
                                    setTimeout(() => setConnStatus('idle'), 3000);
                                    return;
                                  }

                                  const connDataObj = {
                                    protocol: item.protocol,
                                    host: item.host.trim(),
                                    port: parseInt(item.port) || (item.protocol === 'ssh' ? 22 : 7681),
                                    username: item.user || '',
                                    // password omitted from localStorage
                                  };
                                  try { localStorage.setItem('coffee_remote_cfg', JSON.stringify(connDataObj)); } catch(e) {}
                                  // Load password for this specific host from keychain, fall back to current sshPass state
                                  const doConnect = (pw: string) => {
                                    if (isTauri && pw) commands.savePassword(item.host.trim(), item.user || '', pw).catch(() => {});
                                    selectTool('remote', JSON.stringify({ ...connDataObj, password: pw }));
                                  };
                                  if (isTauri && item.host && item.user) {
                                    commands.loadPassword(item.host.trim(), item.user)
                                      .then(pw => doConnect(pw ?? sshPass))
                                      .catch(() => doConnect(sshPass));
                                  } else {
                                    doConnect(sshPass);
                                  }
                                  setShowRemoteForm(false);
                                  setConnStatus('idle');
                                }}
                              >
                                <span className="remote-pill-proto">{item.protocol}</span>
                                <span>{item.host}</span>
                                <button className="remote-pill-close" onClick={(e) => deleteRemoteHistory(item.id, e)}>
                                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  </div>
                </div>

                {/* ─── Page 2: Library (Agents | Skills) ─── */}
                <div className={`launchpad-page library-page${libraryTab === 'skills' ? ' library-page--skills' : ''}`}>
                  <div className="launchpad-inner">
                    {libraryTab === 'agents' ? (
                      <>
                        {/* Section 1: AI CLI agents — 4-col grid (default) */}
                        <div className="library-grid">
                          {AGENT_CATALOG.filter(item => item.type === 'ai-cli').map(item => {
                            const pinId = `agent:${item.key}`;
                            const isPinned = pinnedItems.includes(pinId);
                            const hasGear = (['claude', 'codex', 'grok', 'antigravity', 'qwen', 'opencode', 'mimocode', 'openclaw', 'hermes', 'pi', 'kimicode'] as const).includes(item.key as any);
                            return (
                              <div
                                key={item.key}
                                className={`library-item ${isPinned ? 'is-pinned' : ''}`}
                                onClick={() => togglePin(pinId)}
                              >
                                <div className="library-item-icon">{item.icon}</div>
                                <span className="library-item-name">{item.label}</span>
                                {hasGear && (
                                  <span
                                    className="library-gear-btn"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setConfigModalTool({ key: item.key as string, label: item.label });
                                    }}
                                  >
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                      <circle cx="12" cy="12" r="3"/>
                                      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                                    </svg>
                                  </span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                        {/* Section 2: Agent Tools — 4-col grid so the
                            coordinated 4/3/2 agent cards line up directly
                            above the independent 4/3/2 split cards:
                              Row 1: multi-agent / three-agent / two-agent / Coffee 101
                              Row 2: four-split  / three-split / two-split / hyper-agent */}
                        <div className="library-section-title">{t('library.agent_tools' as any)}</div>
                        <div className="library-grid library-grid--tools">
                          {AGENT_CATALOG.filter(item => item.type === 'utility').map(item => {
                            const pinId = `agent:${item.key}`;
                            const isPinned = pinnedItems.includes(pinId);
                            // Utility tools (multi-agent / Coffee 101 /
                            // hyper-agent / N-split) don't take a launch
                            // path — no gear, just border-as-state.
                            return (
                              <div
                                key={item.key}
                                className={`library-item ${isPinned ? 'is-pinned' : ''}`}
                                onClick={() => togglePin(pinId)}
                              >
                                <div className="library-item-icon">{item.icon}</div>
                                <span className="library-item-name">{item.label}</span>
                              </div>
                            );
                          })}
                        </div>
                      </>
                    ) : (
                      <SkillsPanel showToast={showToast} />
                    )}
                  </div>

                </div>

              </div>
            </div>

            {/* ── Top-anchored chrome (always mounted, opacity-toggled) ──
                Placed OUTSIDE the slider track so it doesn't slide
                horizontally with the page transition. Instead each
                chrome group cross-fades against the other based on
                showLibrary. Slide is for content (nav between modes);
                fade is for chrome (the mode label). Mixing the two
                kinds of motion reads more polished than forcing one
                animation type onto both. */}
            <div
              className={`launchpad-chrome launchpad-chrome--desktop ${showLibrary ? '' : 'is-visible'}`}
              aria-hidden={showLibrary}
            >
              <button
                className="mode-switch-btn"
                onClick={() => setShowLibrary(true)}
                aria-label="Open library"
              >
                <div className="mode-switch-icon">
                  {/* 2×2 app grid = "open the tools/apps library" — the
                      macOS Launchpad / iOS App Library metaphor for this
                      button's actual job. The "+" in the last cell reads as
                      "more / add a tool". Replaces the former gear, which
                      collided with the settings-screen gear and mis-read as
                      "设置" rather than "应用页". A grid is concrete here, not
                      abstract — it depicts the apps the button opens. */}
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="7.5" height="7.5" rx="1.6"/>
                    <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6"/>
                    <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6"/>
                    <line x1="17.25" y1="14.3" x2="17.25" y2="20.2"/>
                    <line x1="14.3" y1="17.25" x2="20.2" y2="17.25"/>
                  </svg>
                </div>
              </button>
            </div>

            <div
              className={`launchpad-chrome launchpad-chrome--library ${showLibrary ? 'is-visible' : ''}`}
              aria-hidden={!showLibrary}
            >
              <button
                className="mode-switch-btn launchpad-chrome-back"
                onClick={() => setShowLibrary(false)}
                aria-label="Back to desktop"
              >
                <div className="mode-switch-icon">
                  {/* Pure chevron < — no extension line, fewer strokes,
                      visually paired with the gear (both naked glyphs,
                      same stroke width, same hit area). */}
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="15 18 9 12 15 6"/>
                  </svg>
                </div>
              </button>
            </div>

            {/* Tab pill — hoisted OUT of launchpad-chrome--library so
                backdrop-filter can render correctly. With it nested
                under the chrome, the parent's opacity 0→1 fade
                isolated a stacking context for the duration of the
                transition; backdrop-filter inside that isolate has
                no wallpaper to sample, so the pill rendered as a
                flat near-transparent rect during the fade and the
                glass blur "snapped in" the moment opacity hit 1 —
                that was the visible flash. As a sibling here the
                pill owns its own opacity fade, which scales the
                post-backdrop-filter result (only ANCESTOR opacity
                isolates) — so the frosted glass reveals smoothly
                in sync with the back-chevron's cross-fade. */}
            <div
              className={`library-tabs library-tabs--top ${showLibrary ? 'is-visible' : ''}`}
              aria-hidden={!showLibrary}
            >
              <button
                className={`library-tab ${libraryTab === 'agents' ? 'active' : ''}`}
                onClick={() => setLibraryTab('agents')}
              >
                Agents {pinnedItems.length}
              </button>
              <button
                className={`library-tab ${libraryTab === 'skills' ? 'active' : ''}`}
                onClick={() => setLibraryTab('skills')}
              >
                Skills
              </button>
            </div>

          </div>
                )}
      </div>

      {/* Per-tool launch override modal. Mounted at root so its fixed-
          position backdrop covers the whole window, not just the
          launchpad area. */}
      {configModalTool && (
        <ToolConfigModal
          toolKey={configModalTool.key}
          toolLabel={configModalTool.label}
          onClose={() => setConfigModalTool(null)}
        />
      )}
      {folderMenu && (
        <RecentFolderMenu
          x={folderMenu.x}
          y={folderMenu.y}
          recent={recentFolders}
          openLabel={t('launchpad.open_folder' as any) || 'Open folder…'}
          onPick={(f) => { selectTool(folderMenu.tool, undefined, f); setFolderMenu(null); }}
          onRemove={(f) => removeRecentFolder(f)}
          onOpenNew={() => { const tk = folderMenu.tool; setFolderMenu(null); handlePickFolder(tk); }}
          onClose={() => setFolderMenu(null)}
        />
      )}
    </>
  );
}
