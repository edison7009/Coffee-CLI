import { useState, useEffect, useRef } from 'react';
import { focusTerminal } from '../../lib/focus-registry';
import { TierTerminal } from './TierTerminal';
import { DosPlayer } from './DosPlayer';
import { ChatReader } from './ChatReader';
import { MultiAgentGrid } from './MultiAgentGrid';
import { FourSplitGrid } from './FourSplitGrid';
import { ErrorBoundary } from '../common/ErrorBoundary';
import { useAppState, type ToolType } from '../../store/app-state';

export interface RemoteHistoryItem {
  id: string;
  protocol: 'ssh' | 'ws';
  host: string;
  port: string;
  user: string;
}
import { isTauri, commands } from '../../tauri';
import { useT } from '../../i18n/useT';
import { fetchGameCatalog, type RemoteGameEntry } from '../../utils/game-catalog';
import './CenterPanel.css';

// Tool icons — all assets live under /icons/tools/.
// Adding a new tool = drop an SVG/PNG in that folder + reference the URL here.

// `decoding="sync"` tells WebView2 to block paint until the image is
// fully decoded. Combined with the App-mount preload in App.tsx that
// warms both the HTTP cache AND the decoded-pixel cache via img.decode(),
// this guarantees icons appear on the very first render instead of
// flashing in one frame later. Without sync decoding, even a cached PNG
// still hits the async decode pipeline per-<img>-element-mount.
const toolIcon = (src: string, size = '1em', extra: React.CSSProperties = {}) => (
  <img
    src={src}
    alt=""
    loading="eager"
    decoding="sync"
    style={{ width: size, height: size, flexShrink: 0, objectFit: 'contain', ...extra }}
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
const GEMINI_SVG    = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="100%" height="100%"><defs><linearGradient gradientUnits="userSpaceOnUse" id="gemini-fill" x1="24" x2="0" y1="6.587" y2="16.494"><stop stop-color="#EE4D5D"/><stop offset=".328" stop-color="#B381DD"/><stop offset=".476" stop-color="#207CFE"/></linearGradient></defs><path d="M0 4.391A4.391 4.391 0 014.391 0h15.217A4.391 4.391 0 0124 4.391v15.217A4.391 4.391 0 0119.608 24H4.391A4.391 4.391 0 010 19.608V4.391z" fill="url(#gemini-fill)"/><path clip-rule="evenodd" d="M19.74 1.444a2.816 2.816 0 012.816 2.816v15.48a2.816 2.816 0 01-2.816 2.816H4.26a2.816 2.816 0 01-2.816-2.816V4.26A2.816 2.816 0 014.26 1.444h15.48zM7.236 8.564l7.752 3.728-7.752 3.727v2.802l9.557-4.596v-3.866L7.236 5.763v2.801z" fill="#1E1E2E" fill-rule="evenodd"/></svg>';
const QWEN_SVG      = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="100%" height="100%"><defs><linearGradient id="qwen-fill" x1="0%" x2="100%" y1="0%" y2="0%"><stop offset="0%" stop-color="#6336E7" stop-opacity=".84"/><stop offset="100%" stop-color="#6F69F7" stop-opacity=".84"/></linearGradient></defs><path d="M12.604 1.34c.393.69.784 1.382 1.174 2.075a.18.18 0 00.157.091h5.552c.174 0 .322.11.446.327l1.454 2.57c.19.337.24.478.024.837-.26.43-.513.864-.76 1.3l-.367.658c-.106.196-.223.28-.04.512l2.652 4.637c.172.301.111.494-.043.77-.437.785-.882 1.564-1.335 2.34-.159.272-.352.375-.68.37-.777-.016-1.552-.01-2.327.016a.099.099 0 00-.081.05 575.097 575.097 0 01-2.705 4.74c-.169.293-.38.363-.725.364-.997.003-2.002.004-3.017.002a.537.537 0 01-.465-.271l-1.335-2.323a.09.09 0 00-.083-.049H4.982c-.285.03-.553-.001-.805-.092l-1.603-2.77a.543.543 0 01-.002-.54l1.207-2.12a.198.198 0 000-.197 550.951 550.951 0 01-1.875-3.272l-.79-1.395c-.16-.31-.173-.496.095-.965.465-.813.927-1.625 1.387-2.436.132-.234.304-.334.584-.335a338.3 338.3 0 012.589-.001.124.124 0 00.107-.063l2.806-4.895a.488.488 0 01.422-.246c.524-.001 1.053 0 1.583-.006L11.704 1c.341-.003.724.032.9.34zm-3.432.403a.06.06 0 00-.052.03L6.254 6.788a.157.157 0 01-.135.078H3.253c-.056 0-.07.025-.041.074l5.81 10.156c.025.042.013.062-.034.063l-2.795.015a.218.218 0 00-.2.116l-1.32 2.31c-.044.078-.021.118.068.118l5.716.008c.046 0 .08.02.104.061l1.403 2.454c.046.081.092.082.139 0l5.006-8.76.783-1.382a.055.055 0 01.096 0l1.424 2.53a.122.122 0 00.107.062l2.763-.02a.04.04 0 00.035-.02.041.041 0 000-.04l-2.9-5.086a.108.108 0 010-.113l.293-.507 1.12-1.977c.024-.041.012-.062-.035-.062H9.2c-.059 0-.073-.026-.043-.077l1.434-2.505a.107.107 0 000-.114L9.225 1.774a.06.06 0 00-.053-.031zm6.29 8.02c.046 0 .058.02.034.06l-.832 1.465-2.613 4.585a.056.056 0 01-.05.029.058.058 0 01-.05-.029L8.498 9.841c-.02-.034-.01-.052.028-.054l.216-.012 6.722-.012z" fill="url(#qwen-fill)" fill-rule="nonzero"/></svg>';
// OpenClaw brand (lobster mascot) — ported from Web-Home/agents/icons/openclaw.svg.
// Gradient IDs stay verbatim from the source asset; browsers scope them per-<svg>
// so multiple mounts don't clash.
const OPENCLAW_SVG  = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="100%" height="100%"><path d="M12 2.568c-6.33 0-9.495 5.275-9.495 9.495 0 4.22 3.165 8.44 6.33 9.494v2.11h2.11v-2.11s1.055.422 2.11 0v2.11h2.11v-2.11c3.165-1.055 6.33-5.274 6.33-9.494S18.33 2.568 12 2.568z" fill="url(#oc0)"/><path d="M3.56 9.953C.396 8.898-.66 11.008.396 13.118c1.055 2.11 3.164 1.055 4.22-1.055.632-1.477 0-2.11-1.056-2.11z" fill="url(#oc1)"/><path d="M20.44 9.953c3.164-1.055 4.22 1.055 3.164 3.165-1.055 2.11-3.164 1.055-4.22-1.055-.632-1.477 0-2.11 1.056-2.11z" fill="url(#oc2)"/><path d="M5.507 1.875c.476-.285 1.036-.233 1.615.037.577.27 1.223.774 1.937 1.488a.316.316 0 01-.447.447c-.693-.693-1.279-1.138-1.757-1.361-.475-.222-.795-.205-1.022-.069a.317.317 0 01-.326-.542zM16.877 1.913c.58-.27 1.14-.323 1.616-.038a.317.317 0 01-.326.542c-.227-.136-.547-.153-1.022.069-.478.223-1.064.668-1.756 1.361a.316.316 0 11-.448-.447c.714-.714 1.36-1.218 1.936-1.487z" fill="#FF4D4D"/><path d="M8.835 9.109a1.266 1.266 0 100-2.532 1.266 1.266 0 000 2.532zM15.165 9.109a1.266 1.266 0 100-2.532 1.266 1.266 0 000 2.532z" fill="#050810"/><path d="M9.046 8.16a.527.527 0 100-1.056.527.527 0 000 1.055zM15.376 8.16a.527.527 0 100-1.055.527.527 0 000 1.054z" fill="#00E5CC"/><defs><linearGradient gradientUnits="userSpaceOnUse" id="oc0" x1="-.659" x2="27.023" y1=".458" y2="22.855"><stop stop-color="#FF4D4D"/><stop offset="1" stop-color="#991B1B"/></linearGradient><linearGradient gradientUnits="userSpaceOnUse" id="oc1" x1="0" x2="4.311" y1="9.672" y2="14.949"><stop stop-color="#FF4D4D"/><stop offset="1" stop-color="#991B1B"/></linearGradient><linearGradient gradientUnits="userSpaceOnUse" id="oc2" x1="19.385" x2="24.399" y1="9.953" y2="14.462"><stop stop-color="#FF4D4D"/><stop offset="1" stop-color="#991B1B"/></linearGradient></defs></svg>';

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
// OpenCode uses the official square apple-touch-icon-v3.png from
// opencode.ai (180×180 RGBA, dark rounded square + white frame + grey
// inner block). The previous hand-drawn SVG approximation got the
// proportions wrong; using the brand asset directly guarantees parity
// with the official app icon and matches Codex/Gemini's square fill.
const SvgOpenCode  = () => toolIcon('/icons/tools/opencode.png', '1em', { borderRadius: 'var(--radius-xs)', objectFit: 'cover' });
const SvgOpenClaw  = () => inlineSvgIcon(OPENCLAW_SVG);
const SvgCodex     = () => inlineSvgIcon(CODEX_SVG);
const SvgGemini    = () => inlineSvgIcon(GEMINI_SVG);
// PNG-backed icons stay as <img> — tiny raster bitmaps don't benefit
// from inlining (base64 would bloat the bundle more than the HTTP
// round-trip they skip). They're small enough to load under a frame
// on warm cache.
const SvgVibeID    = () => toolIcon('/icons/tools/vibeid.png');
const SvgHermes    = () => toolIcon('/icons/tools/hermes.png', '1em', { borderRadius: 'var(--radius-xs)', objectFit: 'cover' });

// One-click installer glyph — clock face with hour hands. Inlined (instead
// of loading /icons/tools/installer.svg as <img>) so the stroke can inherit
// currentColor and follow the theme accent, matching our other in-house
// glyphs (multi-agent, four-split). Third-party logos (Claude, Gemini,
// Codex...) stay as <img> to preserve their brand colors.
//
// Coffee 101 card uses the same animated coffee mark as the left-panel
// brand header (see Explorer.tsx panel-header). Steam wave loops 3s,
// cup body draws on first paint then fills. Sized at 1em so it scales
// with the launchpad card font-size like other utility cards.
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
          <animate
            attributeName="d"
            dur="3s"
            repeatCount="indefinite"
            values="M8 0c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M12 0c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M16 0c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4;M8 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M12 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M16 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4"
          />
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

// Multi-Agent glyph — same lucide layout-grid path used by the titlebar's
// "2×2 grid" layout toggle. Inline so it tints with the theme (currentColor)
// and stays in lockstep with the titlebar. Rendered at 1em so it picks up
// the card/tab font-size (Launchpad card ≈ 22px, Tab ≈ 13px) without
// per-callsite tweaks.
// Multi-Agent glyph — one whole frame divided into 4 quadrants by a cross.
// Reads as "a single coordinated system split into 4 roles", matching the
// MCP peer-coordination model (the 4 panes share one workspace and one MCP
// endpoint, so conceptually they're one entity with 4 heads).
// Multi-Agent (4-pane coordination) — hollow outer frame with internal cross.
// One workspace shared by all panes → shared outer border, no gaps.
// Internal dividers use butt caps + inset endpoints so they stop at the
// inner edge of the outer frame instead of poking through it as small
// "ticks" at the corners.
const SvgMultiAgent = () => (
  <svg
    width="1em"
    height="1em"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="square"
    strokeLinejoin="miter"
    style={{ flexShrink: 0, color: 'var(--accent)', verticalAlign: '-0.125em' }}
  >
    <rect x="4" y="4" width="16" height="16" />
    <line x1="12" y1="5" x2="12" y2="19" strokeLinecap="butt" />
    <line x1="5" y1="12" x2="19" y2="12" strokeLinecap="butt" />
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

// Two-Agent (coordination) — hollow outer frame with one internal divider.
// Shared outer border = same workspace; internal line = two cooperating panes.
const SvgTwoAgent = () => (
  <svg
    width="1em"
    height="1em"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="square"
    strokeLinejoin="miter"
    style={{ flexShrink: 0, color: 'var(--accent)', verticalAlign: '-0.125em' }}
  >
    <rect x="4" y="4" width="16" height="16" />
    <line x1="12" y1="5" x2="12" y2="19" strokeLinecap="butt" />
  </svg>
);

// Three-Agent (coordination) — hollow outer frame with two internal dividers.
const SvgThreeAgent = () => (
  <svg
    width="1em"
    height="1em"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="square"
    strokeLinejoin="miter"
    style={{ flexShrink: 0, color: 'var(--accent)', verticalAlign: '-0.125em' }}
  >
    <rect x="4" y="4" width="16" height="16" />
    <line x1="9.33"  y1="5" x2="9.33"  y2="19" strokeLinecap="butt" />
    <line x1="14.67" y1="5" x2="14.67" y2="19" strokeLinecap="butt" />
  </svg>
);

// ── Platform-aware Terminal Icon & Label ─────────────────────────────────────

const detectOS = (): 'win' | 'mac' | 'linux' => {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('win')) return 'win';
  if (ua.includes('mac')) return 'mac';
  return 'linux';
};

const TERMINAL_ICON: Record<string, string> = {
  win: '/icons/tools/terminal-powershell.svg',
  mac: '/icons/tools/terminal-macos.png',
  linux: '/icons/tools/terminal-linux.png',
};

const TerminalIcon = () => {
  const os = detectOS();
  return (
    <img
      src={TERMINAL_ICON[os]}
      alt=""
      loading="eager"
      decoding="sync"
      style={{ width: '1em', height: '1em', borderRadius: 'var(--radius-xs)', objectFit: 'contain', flexShrink: 0 }}
    />
  );
};

// (terminal label now from i18n: t('tool.terminal'))

const SvgPlus = ({ active }: { active: boolean }) => (
  <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, color: active ? 'var(--accent)' : 'inherit' }}>
    <line x1="12" y1="5" x2="12" y2="19"></line>
    <line x1="5" y1="12" x2="19" y2="12"></line>
  </svg>
);

export function CenterPanel() {
  const { state, dispatch } = useAppState();
  const t = useT();
  const terminals = state.terminals;
  const activeTerminalId = state.activeTerminalId;

  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [toolsInstalled, setToolsInstalled] = useState<Record<string, boolean>>({});
  const [showArcadeGames, setShowArcadeGames] = useState(false);
  const [libraryTab, setLibraryTab] = useState<'agents' | 'games'>('agents');
  const [pinnedItems, setPinnedItems] = useState<string[]>(() => {
    // Hard cap must match MAX_PINS constant below. Inlined as a literal
    // because MAX_PINS is declared after this initializer runs.
    const CAP = 6;
    try {
      const stored = localStorage.getItem('coffee_pinned_items');
      if (stored !== null) {
        let arr = JSON.parse(stored);
        if (!Array.isArray(arr)) return [];
        // One-shot migration: existing users who launched before the
        // multi-agent quadrant shipped won't have it pinned. Inject it
        // once so they discover the feature. If they're already at cap,
        // evict the oldest pin to make room (they can unpin multi-agent
        // via the library if they don't want it).
        if (!arr.includes('agent:multi-agent')) {
          if (arr.length >= CAP) arr.shift();
          arr.push('agent:multi-agent');
        }
        // Defensive cap: historical bugs (e.g. earlier migrations that
        // pushed past the limit) may have left > CAP items in storage.
        // Trim and persist back so the state stays consistent.
        if (arr.length > CAP) arr = arr.slice(0, CAP);
        try { localStorage.setItem('coffee_pinned_items', JSON.stringify(arr)); } catch {}
        return arr;
      }
      // First launch: pre-pin 6 useful defaults so desktop shows a full MAX_PINS
      // grid out of the box (4 AI CLIs covering major providers + 2 utilities).
      // Returning users' pin choices are respected (stored !== null path above).
      const defaults = [
        'agent:claude',
        'agent:codex',
        'agent:opencode',
        'agent:gemini',
        'agent:multi-agent',
        'agent:terminal',
      ];
      localStorage.setItem('coffee_pinned_items', JSON.stringify(defaults));
      return defaults;
    } catch { return []; }
  });

  const MAX_PINS = 6;

  // Agent list is now fully local (baked into BUILTIN_AI_CLI_FALLBACK below)
  // so there is no loading / cache state here — the previous remote catalog
  // fetch at https://coffeecli.com/agents/catalog.json was deleted in v1.1.5
  // to eliminate first-paint icon flashes and reduce the app's startup
  // network dependency surface. Games still load remotely — see gamesLoading.
  const [gamesLoading, setGamesLoading] = useState<boolean>(true);

  // Auto-sync the VibeID skill on every launch. Small files (SKILL.md,
  // matrix.json, scripts) are re-fetched every time (~10 KB total, <1s on
  // normal networks) so existing users automatically pick up skill logic
  // upgrades without manually deleting ~/.claude/skills/vibeid/. Persona
  // images (~2 MB) are downloaded only on first install.
  useEffect(() => {
    if (!isTauri) return;
    (async () => {
      const BASE = 'https://coffeecli.com/CC-VibeID-test';
      // 16 Vibetype codes: mind (R/E) × craft (D/T) × arc (V/A) × flow (L/H).
      // Grouped by family: Logos (RD*), Forge (RT*), Muse (ED*), Kinetic (ET*).
      // Must match matrix.json persona keys and the actual PNG filenames at
      // ${BASE}/personas/images/<code>.png.
      const CODES = [
        'RDVL','RDVH','RDAL','RDAH','RTVL','RTVH','RTAL','RTAH',
        'EDVL','EDVH','EDAL','EDAH','ETVL','ETVH','ETAL','ETAH',
      ];
      const textFiles = [
        { remote: 'SKILL.md', local: 'SKILL.md' },
        { remote: 'matrix.json', local: 'matrix.json' },
        { remote: 'scripts/analyze.js', local: 'scripts/analyze.js' },
        { remote: 'scripts/inject.js', local: 'scripts/inject.js' },
      ];
      const pullText = async (f: { remote: string; local: string }) => {
        const res = await fetch(`${BASE}/${f.remote}`);
        if (!res.ok) throw new Error(`${f.remote}: ${res.status}`);
        const bytes = new TextEncoder().encode(await res.text());
        await commands.writeSkillFile(f.local, Array.from(bytes));
      };
      const pullBinary = async (f: { remote: string; local: string }) => {
        const res = await fetch(`${BASE}/${f.remote}`);
        if (!res.ok) throw new Error(`${f.remote}: ${res.status}`);
        const buf = new Uint8Array(await res.arrayBuffer());
        await commands.writeSkillFile(f.local, Array.from(buf));
      };
      try {
        // Always keep SKILL.md / matrix / scripts fresh.
        await Promise.all(textFiles.map(pullText));

        // Fetch persona images only if this is a fresh install.
        const installed = await commands.checkSkillInstalled('vibeid').catch(() => true);
        if (!installed) {
          const imageFiles = CODES.map(c => ({
            remote: `personas/images/${c}.png`,
            local: `images/${c}.png`,
          }));
          await Promise.all(imageFiles.map(pullBinary));
          console.log('[vibeid] first-time install complete (images + logic)');
        } else {
          console.log('[vibeid] skill logic synced (images already present)');
        }
      } catch (err) {
        console.warn('[vibeid] skill sync failed:', err);
      }
    })();
  }, []);

  // Built-in inline SVG icons keyed by agent id. Used when catalog entry id matches;
  // otherwise falls back to entry.icon URL.
  const BUILTIN_ICONS: Record<string, React.ReactNode> = {
    claude: <SvgClaude />,
    opencode: <SvgOpenCode />,
    openclaw: <SvgOpenClaw />,
    codex: <SvgCodex />,
    gemini: <SvgGemini />,
    qwen: <SvgQwen />,
    hermes: <SvgHermes />,
  };

  // Built-in AI CLI catalog. Fully local — no remote fetch.
  const BUILTIN_AI_CLI_FALLBACK: { key: ToolType; label: string }[] = [
    { key: 'claude', label: 'Claude Code' },
    { key: 'opencode', label: 'OpenCode' },
    { key: 'openclaw', label: 'OpenClaw' },
    { key: 'codex', label: 'Codex CLI' },
    { key: 'gemini', label: 'Gemini CLI' },
    { key: 'qwen', label: 'Qwen Code' },
    { key: 'hermes', label: 'Hermes Agent' },
  ];

  // Unified agent catalog — fully local. The remote catalog fetch
  // (coffeecli.com/agents/catalog.json) was deleted in v1.1.5; product
  // decision is that software is bundled with the app (delete-logic-not-add)
  // while games stay remote (see fetchGameCatalog). AI CLIs and utilities
  // are both hardcoded below.
  // - `type`: semantic category ('ai-cli' | 'utility'). Lets future code group/filter items.
  // - `requiresCwd`: behavior flag — drives folder-button + cwd display on Desktop cards.
  const AGENT_CATALOG: { key: ToolType; label: string; icon: React.ReactNode; type: 'ai-cli' | 'utility'; requiresCwd: boolean }[] = (() => {
    // OpenClaw (persona forge) and Hermes Agent are directory-agnostic —
    // they operate on global state, not a project folder. Skip the
    // folder-picker + cwd display so they launch in one click, like utilities.
    const CWD_AGNOSTIC_AI_CLI = new Set<ToolType>(['openclaw', 'hermes']);
    const aiCliEntries = BUILTIN_AI_CLI_FALLBACK.map(item => ({
      key: item.key,
      label: item.label,
      icon: BUILTIN_ICONS[item.key as string] ?? null,
      type: 'ai-cli' as const,
      requiresCwd: !CWD_AGNOSTIC_AI_CLI.has(item.key),
    }));

    // Utility order is deliberate for 4-column alignment in the
    // "Agent Tools" grid on the Library page:
    //   Row 1: multi-agent | three-agent | two-agent | installer
    //   Row 2: four-split  | three-split | two-split | vibeid
    // Coordinated row on top, independent row below, each descending
    // 4→3→2 so the pane counts align column-by-column (4↔4, 3↔3, 2↔2)
    // and the two rightmost slots hold standalone utilities.
    const utilities = [
      // Terminal is an AI-CLI-like tool (needs cwd) rather than a 'utility'.
      { key: 'terminal' as ToolType, label: t('tool.terminal'), icon: <TerminalIcon />, type: 'ai-cli' as const, requiresCwd: true },
      // ─── Row 1: coordinated (descending 4→3→2) + installer ─────────
      {
        key: 'multi-agent' as ToolType,
        label: t('tool.multi_agent' as any),
        icon: <SvgMultiAgent />,
        type: 'utility' as const,
        requiresCwd: true,
      },
      {
        key: 'three-agent' as ToolType,
        label: t('tool.three_agent' as any),
        icon: <SvgThreeAgent />,
        type: 'utility' as const,
        requiresCwd: true,
      },
      {
        key: 'two-agent' as ToolType,
        label: t('tool.two_agent' as any),
        icon: <SvgTwoAgent />,
        type: 'utility' as const,
        requiresCwd: true,
      },
      { key: 'installer' as ToolType, label: 'Coffee 101', icon: <SvgInstaller />, type: 'utility' as const, requiresCwd: false },
      // ─── Row 2: independent (descending 4→3→2) + vibeid ────────────
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
      // VibeID is a built-in skill-launcher utility: click → spawn `claude` binary
      // in a tab, then auto-write `/vibeid\r` to trigger the remote vibeid skill.
      { key: 'vibeid' as ToolType, label: t('tool.vibeid' as any), icon: <SvgVibeID />, type: 'utility' as const, requiresCwd: false },
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
        if (prev.length >= MAX_PINS) return prev;
        next = [...prev, id];
      }
      try { localStorage.setItem('coffee_pinned_items', JSON.stringify(next)); } catch {}
      return next;
    });
  };

  const renderPinIcon = (isPinned: boolean) => (
    isPinned ? (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <circle cx="9" cy="9" r="8" fill="currentColor" />
        <path d="M5.5 9.5L7.5 11.5L12.5 6.5" stroke="#1a1917" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ) : (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <circle cx="9" cy="9" r="8" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    )
  );
  const [arcadeGames, setArcadeGames] = useState<{name:string;path:string;size:number;icon?:string;title?:string}[]>([]);
  const [gameCatalog, setGameCatalog] = useState<RemoteGameEntry[]>([]);
  const [disableDrawer, setDisableDrawer] = useState(false);

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



  // Detect tool availability only when the Desktop (not Library) is actually visible.
  // Library is pure UI: pin/unpin never trigger IPC, scan is silent during browsing.
  // Scan runs on:
  //   - Launchpad first shown
  //   - Remote catalog refreshed
  //   - User returns from Library to Desktop (back arrow) — picks up new pins' install state
  // Never on pinnedItems changes → pin click stays instant.
  useEffect(() => {
    if (!isTauri || !isLaunchpadMode) return;
    if (showArcadeGames) return; // Library open: stay silent
    commands.checkToolsInstalled()
      .then(result => setToolsInstalled(result))
      .catch(() => {});
    try {
      const raw = localStorage.getItem('coffee:last-cwd-by-tool');
      if (raw) setLastCwdByTool(JSON.parse(raw));
    } catch {}
  }, [isLaunchpadMode, showArcadeGames]);

  // Auto-hide toast
  useEffect(() => {
    if (toastMsg) {
      const timer = setTimeout(() => setToastMsg(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [toastMsg]);


  const handleAddTab = () => {
    if (terminals.length >= 5) {
      setToastMsg(t('session.max'));
      return;
    }
    dispatch({
      type: 'ADD_TERMINAL',
      session: { id: crypto.randomUUID(), tool: null, folderPath: null }
    });
  };

  const handleCloseTab = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    dispatch({ type: 'REMOVE_TERMINAL', id });
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
    // VibeID launcher: before spawning /vibeid, make sure the /insights usage
    // report exists. If not, auto-run /insights in a pre-run tab and poll for
    // the report file. When it lands, kill the pre-run PTY and remount the
    // tab with tool='vibeid'. End-to-end one click.
    if (tool === 'vibeid' && isTauri) {
      handleVibeidSelect(cwd);
      return;
    }
    if (activeTerminalId) {
      if (cwd) {
        dispatch({ type: 'SET_FOLDER', path: cwd });
        setLastCwdByTool(prev => {
          const next = { ...prev, [tool as string]: cwd };
          try { localStorage.setItem('coffee:last-cwd-by-tool', JSON.stringify(next)); } catch {}
          return next;
        });
      }
      dispatch({ type: 'SET_TERMINAL_TOOL', id: activeTerminalId, tool, toolData });
    }
  };

  const handleVibeidSelect = async (cwd?: string) => {
    if (!activeTerminalId) return;
    const currentId = activeTerminalId;
    if (cwd) {
      dispatch({ type: 'SET_FOLDER', path: cwd });
    }

    // Step A: Pass the user's Coffee CLI UI locale to the skill via a
    // hint file at ~/.claude/skills/vibeid/.user_lang. The skill Step 0
    // reads this file first — 100% reliable. Scanning session jsonl
    // can mis-detect because the auto-run /insights tab is all English.
    try {
      const lang = state.currentLang || 'en';
      const bytes = Array.from(new TextEncoder().encode(lang));
      await commands.writeSkillFile('.user_lang', bytes);
    } catch {
      // Non-fatal — skill falls back to jsonl scanning.
    }

    // Step B: ALWAYS regenerate /insights on every click. The user
    // clicked because they want an up-to-date analysis *right now*;
    // reusing a stale report would give outdated personality results.
    const clickTs = Math.floor(Date.now() / 1000);

    dispatch({ type: 'SET_TERMINAL_TOOL', id: currentId, tool: 'insights_prerun' });

    // Step C: Poll report.html's mtime. mtime > clickTs (minus a small
    // clock-skew tolerance) means the report was freshly regenerated.
    // Then kill the /insights PTY and remount the tab as vibeid.
    const TOLERANCE_S = 5;
    const TIMEOUT_MS = 5 * 60 * 1000;
    const POLL_MS = 3000;
    const startMs = Date.now();
    const poll = window.setInterval(async () => {
      if (Date.now() - startMs > TIMEOUT_MS) {
        window.clearInterval(poll);
        setToastMsg(t('vibeid.insights_timeout') as string);
        return;
      }
      const mtime = await commands.checkVibeidReportMtime().catch(() => 0);
      if (mtime <= clickTs - TOLERANCE_S) return;
      window.clearInterval(poll);
      try { await commands.tierTerminalKill(currentId); } catch {}
      const newId = (crypto && 'randomUUID' in crypto)
        ? crypto.randomUUID()
        : `vibeid-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      dispatch({ type: 'SET_TERMINAL_TOOL', id: currentId, tool: 'vibeid' });
      dispatch({ type: 'RESTART_TERMINAL', id: currentId, newId });
    }, POLL_MS);
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

  // Game catalog loaded from coffeecli.com/play/game.json, re-resolved on lang change
  useEffect(() => {
    fetchGameCatalog(state.currentLang).then(setGameCatalog).catch(() => {});
  }, [state.currentLang]);

  // Fetch arcade catalog on mount (and on lang change) so pinned games can render on Desktop
  // without waiting for the user to open the Library.
  useEffect(() => {
    if (!isTauri) {
      setGamesLoading(false);
      return;
    }
    setGamesLoading(true);
    Promise.allSettled([commands.listJsdosBundles(), fetchGameCatalog(state.currentLang)])
      .then(([bundlesResult, catalogResult]) => {
        const localBundles: any[] = bundlesResult.status === 'fulfilled' ? bundlesResult.value : [];
        const catalog: RemoteGameEntry[] = catalogResult.status === 'fulfilled' ? catalogResult.value : [];
        const games = catalog.map(entry => {
          const cached = localBundles.find((b: any) => b.name.toLowerCase() === entry.file.toLowerCase());
          return { name: entry.file, path: cached ? cached.path : entry.download, size: cached ? cached.size : 0, icon: entry.icon, title: entry.title };
        });
        setArcadeGames(games);
      })
      .finally(() => setGamesLoading(false));
  }, [state.currentLang]);

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
      case 'claude': return { icon: <SvgClaude />, title: cwd ?? 'Claude Code', tooltip: pathTip };
      case 'qwen': return { icon: <SvgQwen />, title: cwd ?? 'Qwen Code', tooltip: pathTip };
      // OpenClaw / Hermes are directory-agnostic tools — their tab title
      // stays as the tool name regardless of any inherited folderPath.
      case 'hermes': return { icon: <SvgHermes />, title: 'Hermes Agent', tooltip: undefined };
      case 'opencode': return { icon: <SvgOpenCode />, title: cwd ?? 'OpenCode', tooltip: pathTip };
      case 'openclaw': return { icon: <SvgOpenClaw />, title: 'OpenClaw', tooltip: undefined };
      case 'codex': return { icon: <SvgCodex />, title: cwd ?? 'Codex CLI', tooltip: pathTip };
      case 'gemini': return { icon: <SvgGemini />, title: cwd ?? 'Gemini CLI', tooltip: pathTip };
      case 'installer': return { icon: <SvgInstaller />, title: 'Coffee 101', tooltip: undefined };
      // VibeID is a 2-phase flow under one logical operation: insights_prerun
      // gathers usage data, then vibeid analyzes it. Reuse the existing
      // `tool.vibeid` translation for both phases and suffix " (1/2)" /
      // " (2/2)" so progress reads as a single VibeID run, no extra i18n
      // keys needed.
      case 'insights_prerun': return { icon: <SvgVibeID />, title: `${t('tool.vibeid' as any)} (1/2)`, tooltip: undefined };
      case 'vibeid': return { icon: <SvgVibeID />, title: `${t('tool.vibeid' as any)} (2/2)`, tooltip: undefined };
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
      case 'multi-agent': return { icon: <SvgMultiAgent />, title: cwd ?? t('tool.multi_agent' as any), tooltip: pathTip };
      case 'two-agent': return { icon: <SvgTwoAgent />, title: cwd ?? t('tool.two_agent' as any), tooltip: pathTip };
      case 'three-agent': return { icon: <SvgThreeAgent />, title: cwd ?? t('tool.three_agent' as any), tooltip: pathTip };
      case 'two-split': return { icon: <SvgTwoSplit />, title: cwd ?? t('tool.two_split' as any), tooltip: pathTip };
      case 'three-split': return { icon: <SvgThreeSplit />, title: cwd ?? t('tool.three_split' as any), tooltip: pathTip };
      case 'four-split': return { icon: <SvgFourSplit />, title: cwd ?? t('tool.four_split' as any), tooltip: pathTip };
      case 'arcade': {
        const gameName = session.toolData || '';
        const meta = gameCatalog.find(m => m.file.toLowerCase() === gameName.toLowerCase());
        if (meta) {
          return { icon: <img src={meta.icon} alt="" style={{ width: '1em', height: '1em', borderRadius: 'var(--radius-xs)', objectFit: 'cover' }} />, title: meta.title, tooltip: undefined };
        }
        return { icon: <span style={{ fontSize: '1em' }}>🎮</span>, title: 'Coffee Play', tooltip: undefined };
      }
      case 'history': {
        let titleParam = 'History';
        if (session.toolData) {
          try {
            const parsed = JSON.parse(session.toolData);
            if (parsed.name) titleParam = parsed.name; // Use the session name instead for the tab
          } catch (e) {}
        }
        return {
          icon: <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M12 8v4l3 3"></path><circle cx="12" cy="12" r="10"></circle></svg>,
          title: titleParam,
          tooltip: undefined
        };
      }
      default: return { icon: <SvgPlus active={isActive} />, title: t('tab.new'), tooltip: undefined };
    }
  };

  // ── Custom background (image/video) ──────────────────────────────────────
  // Background state lives in global AppState (set via theme menu in Explorer)
  const bgPath = state.bgPath;
  const bgType = state.bgType;
  const hasBg = bgType !== 'none' && bgPath !== '';

  // Convert local file path to a displayable URL.
  // Use Tauri's convertFileSrc (asset protocol) for zero-copy streaming.
  const [bgUrl, setBgUrl] = useState('');
  useEffect(() => {
    if (!hasBg) { setBgUrl(''); return; }
    import('@tauri-apps/api/core').then(({ convertFileSrc }) => {
      setBgUrl(convertFileSrc(bgPath));
    }).catch(() => {
      setBgUrl('file:///' + bgPath.replace(/\\/g, '/'));
    });
  }, [hasBg, bgPath]);

  return (
    <>
      <div className="chrome-tabs-header" data-count={terminals.filter(s => !s.isHidden || s.id === activeTerminalId).length}>
        {terminals.map(session => {
          if (session.isHidden && session.id !== activeTerminalId) return null;

          const isActive = session.id === activeTerminalId;
          const { icon, title } = renderTabContent(session, isActive);

          return (
            <div
              key={session.id}
              className={`chrome-tab ${isActive ? 'active' : ''}`}
              onClick={() => dispatch({ type: 'SET_ACTIVE_TERMINAL', id: session.id })}
            >
              {icon}
              <span className="tab-title" style={{ flex: '0 1 auto', minWidth: 0, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>{title}</span>
              <div className="tab-actions">
                {(['claude', 'qwen', 'hermes', 'opencode', 'openclaw', 'codex', 'gemini', 'agent', 'installer', 'terminal', 'remote', 'vibeid', 'insights_prerun', 'multi-agent', 'two-agent', 'three-agent', 'two-split', 'three-split', 'four-split'] as const).includes(session.tool as 'claude' | 'qwen' | 'hermes' | 'opencode' | 'openclaw' | 'codex' | 'gemini' | 'agent' | 'installer' | 'terminal' | 'remote' | 'vibeid' | 'insights_prerun' | 'multi-agent' | 'two-agent' | 'three-agent' | 'two-split' | 'three-split' | 'four-split') && (
                  // Only Claude Code has a real hook-driven status machine.
                  // The other tools render the steady-green idle pulse —
                  // we explicitly chose not to guess their state from PTY
                  // output, which tends to produce misleading flicker.
                  // Claude's executing state uses the Claude-brand orange
                  // (#D97757) to match the "Thinking..." color in the CLI.
                  // Exception: VibeID's two-phase flow (insights_prerun → vibeid)
                  // is initiated by us and we know with certainty work is in
                  // flight; force `executing` so the dot animation reflects
                  // reality instead of looking idle for the full duration.
                  <div className={`tab-status-grid status-${
                    session.tool === 'claude'
                      ? (session.agentStatus === 'wait_input' ? 'waiting' : session.agentStatus ?? 'idle')
                      : (session.tool === 'vibeid' || session.tool === 'insights_prerun')
                        ? 'executing'
                        : 'idle'
                  }`}>
                    {Array.from({ length: 9 }, (_, i) => <div key={i} className="tab-status-dot" />)}
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
        })}

        <button className="chrome-tab-new" onClick={handleAddTab}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
        </button>
      </div>
      <div className="main-content">
        {/* Premium Toast Notification */}
        {toastMsg && (
          <div className="toast-notification">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
            {toastMsg}
          </div>
        )}

        {terminals.map(t => t.tool !== null ? (
          <div
            key={t.id}
            className="terminal-wrapper"
            data-session-id={t.id}
            style={{
              display: t.id === activeTerminalId ? 'flex' : 'none',
              width: '100%',
              height: '100%',
              position: 'relative'
            }}
          >
            {t.tool === 'history' ? (
              <ChatReader sessionId={t.id} />
            ) : t.tool === 'arcade' ? (
              <DosPlayer sessionId={t.id} />
            ) : t.tool === 'multi-agent' ? (
              // Independent four-pane peer mode. Standalone Tab type —
              // does not share layout with the single-terminal path
              // below. Every pane is a peer; any CLI can drive the
              // others via coffee-cli MCP tools.
              <MultiAgentGrid
                tab={t}
                hasBg={hasBg}
                bgUrl={bgUrl}
                bgType={bgType}
              />
            ) : t.tool === 'two-agent' ? (
              <MultiAgentGrid
                tab={t}
                hasBg={hasBg}
                bgUrl={bgUrl}
                bgType={bgType}
                paneCount={2}
              />
            ) : t.tool === 'three-agent' ? (
              <MultiAgentGrid
                tab={t}
                hasBg={hasBg}
                bgUrl={bgUrl}
                bgType={bgType}
                paneCount={3}
              />
            ) : t.tool === 'two-split' ? (
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
              // Independent Quad: same 2×2 pane grid as multi-agent but
              // with zero MCP coordination — panes cannot observe or
              // drive each other.
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
                  isActive={t.id === activeTerminalId}
                  toolData={t.toolData}
                  folderPath={t.folderPath}
                  hasBg={hasBg}
                  bgUrl={bgUrl}
                  bgType={bgType}
                  termColorScheme={state.termColorScheme}
                />
              </ErrorBoundary>
            )}
          </div>
        ) : null)}

        {isLaunchpadMode && activeTerminalId && (
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
              <div className={`launchpad-slider-track ${showArcadeGames ? 'slide-to-games' : ''}`}>
                
                {/* ─── Page 1: Desktop (pinned items) ─── */}
                <div className="launchpad-page">
                  <div className="launchpad-inner">
                    {(() => {
                      const pinnedAgents = AGENT_CATALOG.filter(a => pinnedItems.includes(`agent:${a.key}`));
                      const pinnedGames = arcadeGames.filter(g => pinnedItems.includes(`game:${g.name}`));

                      if (pinnedAgents.length === 0 && pinnedGames.length === 0) {
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
                                    <div className="launchpad-folder-btn" onClick={(e) => { e.stopPropagation(); if (!disabled) handlePickFolder(tool.key!); }}>
                                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                                      </svg>
                                    </div>
                                  )}
                                </div>
                              </div>
                            );
                          })}

                          {pinnedGames.map(game => {
                            const title = game.title || game.name.replace(/\.jsdos$/i, '').replace(/[_-]/g, ' ');
                            return (
                              <div key={`game-${game.name}`} className="launchpad-card-group">
                                <div
                                  className="launchpad-card"
                                  onClick={() => {
                                    selectTool('arcade');
                                    const sid = state.activeTerminalId;
                                    if (sid) dispatch({ type: 'SET_TERMINAL_TOOL', id: sid, tool: 'arcade', toolData: game.name });
                                  }}
                                >
                                  <div className="launchpad-icon">
                                    {game.icon
                                      ? <img src={game.icon} alt={title} style={{ width: '1.4em', height: '1.4em', borderRadius: 'var(--radius-xs)', objectFit: 'cover' }} />
                                      : '🎮'}
                                  </div>
                                  <div className="launchpad-card-info">
                                    <span>{title}</span>
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })()}

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

                {/* ─── Page 2: Library (Agents / Games) ─── */}
                <div className="launchpad-page library-page">
                  <div className="launchpad-inner">
                    {libraryTab === 'games' && gamesLoading && arcadeGames.length === 0 ? (
                      <div className="library-grid">
                        {Array.from({ length: 6 }, (_, i) => (
                          <div key={`skel-game-${i}`} className="library-item library-item-skeleton">
                            <div className="library-item-icon library-skeleton-block" />
                            <span className="library-skeleton-line" />
                            <div className="library-pin-btn library-skeleton-pin" />
                          </div>
                        ))}
                      </div>
                    ) : libraryTab === 'agents' ? (
                      <>
                        {/* Section 1: AI CLI agents — 4-col grid (default) */}
                        <div className="library-grid">
                          {AGENT_CATALOG.filter(item => item.type === 'ai-cli').map(item => {
                            const pinId = `agent:${item.key}`;
                            const isPinned = pinnedItems.includes(pinId);
                            return (
                              <div
                                key={item.key}
                                className="library-item"
                                onClick={() => togglePin(pinId)}
                              >
                                <div className="library-item-icon">{item.icon}</div>
                                <span className="library-item-name">{item.label}</span>
                                <div className={`library-pin-btn ${isPinned ? 'pinned' : ''}`}>
                                  {renderPinIcon(isPinned)}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                        {/* Section 2: Agent Tools — 4-col grid so the
                            coordinated 4/3/2 agent cards line up directly
                            above the independent 4/3/2 split cards:
                              Row 1: multi-agent / three-agent / two-agent / installer
                              Row 2: four-split  / three-split / two-split / vibeid */}
                        <div className="library-section-title">{t('library.agent_tools' as any)}</div>
                        <div className="library-grid library-grid--tools">
                          {AGENT_CATALOG.filter(item => item.type === 'utility').map(item => {
                            const pinId = `agent:${item.key}`;
                            const isPinned = pinnedItems.includes(pinId);
                            return (
                              <div
                                key={item.key}
                                className="library-item"
                                onClick={() => togglePin(pinId)}
                              >
                                <div className="library-item-icon">{item.icon}</div>
                                <span className="library-item-name">{item.label}</span>
                                <div className={`library-pin-btn ${isPinned ? 'pinned' : ''}`}>
                                  {renderPinIcon(isPinned)}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </>
                    ) : (
                      <div className="library-grid">
                        {arcadeGames.map(game => {
                          const title = game.title || game.name.replace(/\.jsdos$/i, '').replace(/[_-]/g, ' ');
                          const pinId = `game:${game.name}`;
                          const isPinned = pinnedItems.includes(pinId);
                          return (
                            <div
                              key={game.name}
                              className="library-item"
                              onClick={() => togglePin(pinId)}
                            >
                              <div className="library-item-icon">
                                {game.icon
                                  ? <img src={game.icon} alt={title} style={{ width: '1.4em', height: '1.4em', borderRadius: 'var(--radius-xs)', objectFit: 'cover' }} />
                                  : '🎮'}
                              </div>
                              <span className="library-item-name">{title}</span>
                              <div className={`library-pin-btn ${isPinned ? 'pinned' : ''}`}>
                                {renderPinIcon(isPinned)}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Pin counter above tabs */}
                  <div className="library-counter">{pinnedItems.length}/{MAX_PINS}</div>

                  {/* Bottom tab switcher: Agents / Games */}
                  <div className="library-tabs">
                    <button
                      className={`library-tab ${libraryTab === 'agents' ? 'active' : ''}`}
                      onClick={() => setLibraryTab('agents')}
                    >
                      Agents
                    </button>
                    <button
                      className={`library-tab ${libraryTab === 'games' ? 'active' : ''}`}
                      onClick={() => setLibraryTab('games')}
                    >
                      Games
                    </button>
                  </div>
                </div>
                
              </div>
            </div>

            {/* Global Mode switch button */}
            <div style={{ position: 'absolute', bottom: 18, right: 18 }}>
              <button
                className={`mode-switch-btn ${disableDrawer ? 'instant-click' : ''}`}
                onClick={() => {
                  setDisableDrawer(true);
                  setTimeout(() => setDisableDrawer(false), 500);
                  
                  if (!showArcadeGames) {
                    setShowArcadeGames(true);
                    if (isTauri) {
                      Promise.allSettled([commands.listJsdosBundles(), fetchGameCatalog(state.currentLang)])
                        .then(([bundlesResult, catalogResult]) => {
                          const localBundles: any[] = bundlesResult.status === 'fulfilled' ? bundlesResult.value : [];
                          const catalog: RemoteGameEntry[] = catalogResult.status === 'fulfilled' ? catalogResult.value : [];
                          const games = catalog.map(entry => {
                            const cached = localBundles.find((b: any) => b.name.toLowerCase() === entry.file.toLowerCase());
                            return { name: entry.file, path: cached ? cached.path : entry.download, size: cached ? cached.size : 0, icon: entry.icon, title: entry.title };
                          });
                          setArcadeGames(games);
                        });
                    }
                  } else {
                    setShowArcadeGames(false);
                  }
                }}
              >
                <div className="mode-switch-icon">
                  {!showArcadeGames ? (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
                      <circle cx="5" cy="5" r="1.6"/>
                      <circle cx="12" cy="5" r="1.6"/>
                      <circle cx="19" cy="5" r="1.6"/>
                      <circle cx="5" cy="12" r="1.6"/>
                      <circle cx="12" cy="12" r="1.6"/>
                      <circle cx="19" cy="12" r="1.6"/>
                      <circle cx="5" cy="19" r="1.6"/>
                      <circle cx="12" cy="19" r="1.6"/>
                      <circle cx="19" cy="19" r="1.6"/>
                    </svg>
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M19 12H5"/>
                      <path d="M12 19l-7-7 7-7"/>
                    </svg>
                  )}
                </div>
              </button>
            </div>

          </div>
                )}
      </div>
    </>
  );
}

