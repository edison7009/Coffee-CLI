import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { focusTerminal } from '../../lib/focus-registry';
import { TierTerminal } from './TierTerminal';
import { ChatReader } from './ChatReader';
import { SkillsPanel } from './SkillsPanel';
import { MultiAgentGrid } from './MultiAgentGrid';
import { FourSplitGrid } from './FourSplitGrid';
import { HyperAgentPanel } from './HyperAgentPanel';
import { ToolConfigModal } from './ToolConfigModal';
import { ContributionHeatmap } from './ContributionHeatmap';
import { ErrorBoundary } from '../common/ErrorBoundary';
import { useAppState, type ToolType } from '../../store/app-state';

interface RemoteHistoryItem {
  id: string;
  protocol: 'ssh' | 'ws';
  host: string;
  port: string;
  user: string;
}
import { isTauri, commands } from '../../tauri';
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
const GEMINI_SVG    = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="100%" height="100%"><defs><linearGradient gradientUnits="userSpaceOnUse" id="gemini-fill" x1="24" x2="0" y1="6.587" y2="16.494"><stop stop-color="#EE4D5D"/><stop offset=".328" stop-color="#B381DD"/><stop offset=".476" stop-color="#207CFE"/></linearGradient></defs><path d="M0 4.391A4.391 4.391 0 014.391 0h15.217A4.391 4.391 0 0124 4.391v15.217A4.391 4.391 0 0119.608 24H4.391A4.391 4.391 0 010 19.608V4.391z" fill="url(#gemini-fill)"/><path clip-rule="evenodd" d="M19.74 1.444a2.816 2.816 0 012.816 2.816v15.48a2.816 2.816 0 01-2.816 2.816H4.26a2.816 2.816 0 01-2.816-2.816V4.26A2.816 2.816 0 014.26 1.444h15.48zM7.236 8.564l7.752 3.728-7.752 3.727v2.802l9.557-4.596v-3.866L7.236 5.763v2.801z" fill="#1E1E2E" fill-rule="evenodd"/></svg>';
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
// OpenCode — inline SVG (see OPENCODE_SVG comment). The PNG variant lived
// here briefly for pixel parity with the brand's apple-touch-icon, but the
// trade-off (fixed flash-on-mount in WebView2) wasn't worth it; the inline
// SVG with rounded outer rect matches the brand visually within a pixel or two.
const SvgOpenCode  = () => inlineSvgIcon(OPENCODE_SVG);
const SvgOpenClaw  = () => inlineSvgIcon(OPENCLAW_SVG);
const SvgCodex     = () => inlineSvgIcon(CODEX_SVG);
const SvgGemini    = () => inlineSvgIcon(GEMINI_SVG);
// PNG-backed icons render via CSS background-image with data-URI sources
// (see bgIcon). Hermes uses `cover` to fill the rounded square.
const SvgHermes    = () => bgIcon(HERMES_DATA_URL, '1em', { borderRadius: 'var(--radius-xs)', backgroundSize: 'cover' });

// Coffee 101 card icon — animated coffee mark (same as the left-panel
// brand header in Explorer.tsx panel-header): steam wave loops 3s, cup
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

// Hyper-Agent — central admin node with radiating connections to four
// satellite agent nodes. Evokes "one orchestrator commanding a team
// across all panes". Single accent color, mix of filled center + smaller
// satellite dots so the hub-and-spokes structure reads at icon size.
const SvgHyperAgent = () => (
  <svg
    width="1em"
    height="1em"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ flexShrink: 0, color: 'var(--accent)', verticalAlign: '-0.125em' }}
  >
    {/* Connection lines from center to each satellite */}
    <line x1="12" y1="12" x2="5"  y2="5"  />
    <line x1="12" y1="12" x2="19" y2="5"  />
    <line x1="12" y1="12" x2="5"  y2="19" />
    <line x1="12" y1="12" x2="19" y2="19" />
    {/* Central admin node — filled */}
    <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
    {/* Four satellite agent nodes — outlined */}
    <circle cx="5"  cy="5"  r="2" />
    <circle cx="19" cy="5"  r="2" />
    <circle cx="5"  cy="19" r="2" />
    <circle cx="19" cy="19" r="2" />
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

export function CenterPanel() {
  const { state, dispatch } = useAppState();
  const t = useT();
  const terminals = state.terminals;
  const activeTerminalId = state.activeTerminalId;

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

  // Agent list is fully local (baked into BUILTIN_AI_CLI_FALLBACK below) — no
  // loading / cache state here. The remote catalog fetch at
  // coffeecli.com/agents/catalog.json was deleted in v1.1.5 to eliminate
  // first-paint icon flashes and reduce startup network dependency.

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
  // decision is that software is bundled with the app (delete-logic-not-add).
  // AI CLIs and utilities are both hardcoded below.
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
    //   Row 1: multi-agent | three-agent | two-agent | Coffee 101
    //   Row 2: four-split  | three-split | two-split | hyper-agent
    // Coordinated row on top, independent row below, each descending
    // 4→3→2 so the pane counts align column-by-column (4↔4, 3↔3, 2↔2)
    // and the two rightmost slots hold standalone utilities.
    const utilities = [
      // Terminal is an AI-CLI-like tool (needs cwd) rather than a 'utility'.
      { key: 'terminal' as ToolType, label: t('tool.terminal'), icon: <TerminalIcon />, type: 'ai-cli' as const, requiresCwd: true },
      // ─── Row 1: coordinated (descending 4→3→2) + Coffee 101 link ────
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
      // ─── Row 2: independent (descending 4→3→2) + hyper-agent ──────
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
      // Hyper-Agent — cross-tab admin MCP for OpenClaw / Hermes Agent
      // to remote-control the running agent team. No cwd needed.
      { key: 'hyper-agent' as ToolType, label: t('tool.hyper_agent' as any), icon: <SvgHyperAgent />, type: 'utility' as const, requiresCwd: false },
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

  // (renderPinIcon removed — selection state is now indicated by the
  // .library-item.is-pinned border + opacity, not a right-side icon.)
  // Tracks last successful checkToolsInstalled() scan (epoch ms). Used
  // to skip the back-to-desktop re-scan if it would just repeat work
  // we already did seconds ago — the laggy "click 9-dot, wait, library
  // opens" feel was 7 CLIs × up to 1s of serial PATH scan blocking the
  // IPC queue between back-click and the next 9-dot click.
  const lastToolsScanAt = useRef<number>(0);

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
        .then(result => {
          setToolsInstalled(result);
          lastToolsScanAt.current = Date.now();
        })
        .catch(() => {});
      try {
        const raw = localStorage.getItem('coffee:last-cwd-by-tool');
        if (raw) setLastCwdByTool(JSON.parse(raw));
      } catch {}
    }, 300);
    return () => clearTimeout(handle);
  }, [isLaunchpadMode, showLibrary]);

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
    if (terminals.length >= 5) {
      showToast(t('session.max'));
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
      case 'claude': return { icon: <SvgClaude />, title: cwd ?? 'Claude Code', tooltip: pathTip };
      case 'qwen': return { icon: <SvgQwen />, title: cwd ?? 'Qwen Code', tooltip: pathTip };
      // OpenClaw / Hermes are directory-agnostic tools — their tab title
      // stays as the tool name regardless of any inherited folderPath.
      case 'hermes': return { icon: <SvgHermes />, title: 'Hermes Agent', tooltip: undefined };
      case 'opencode': return { icon: <SvgOpenCode />, title: cwd ?? 'OpenCode', tooltip: pathTip };
      case 'openclaw': return { icon: <SvgOpenClaw />, title: 'OpenClaw', tooltip: undefined };
      case 'codex': return { icon: <SvgCodex />, title: cwd ?? 'Codex CLI', tooltip: pathTip };
      case 'gemini': return { icon: <SvgGemini />, title: cwd ?? 'Gemini CLI', tooltip: pathTip };
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
      case 'hyper-agent': return { icon: <SvgHyperAgent />, title: t('tool.hyper_agent' as any), tooltip: undefined };
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
  // Glass shape forces terminal-as-transparent even without an in-app
  // wallpaper, so the OS desktop bleeds through (body bg is dropped to
  // transparent in the [data-shape="glass"] override). Without this,
  // the xterm canvas renders its solid `bgOpaque` and breaks the glass
  // illusion exactly where it matters most — the largest surface.
  const hasBg = (bgType !== 'none' && bgPath !== '') || state.currentShape === 'glass';

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
                {/* Indicator gate. AI CLIs with hook integration —
                    claude/codex/opencode each have a forwarder (Python
                    script for claude+codex, Bun plugin for opencode)
                    wired to the same agent-status bus. Color follows
                    session.agentStatus. Anything else (terminal,
                    history, multi-agent, etc.) gets no indicator. */}
                {(session.tool === 'claude' || session.tool === 'codex' || session.tool === 'opencode') && (
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
        })}

        <button className="chrome-tab-new" onClick={handleAddTab}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
        </button>
      </div>
      <div className="main-content">

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
            ) : t.tool === 'hyper-agent' ? (
              <HyperAgentPanel
                hasBg={hasBg}
                bgUrl={bgUrl}
                bgType={bgType}
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
                                    // Hyper-Agent opens as a singleton system tab (like
                                    // history). It does not consume one of the 5 user
                                    // workspace tabs — it's an MCP admin endpoint, not a
                                    // workspace.
                                    if (tool.key === 'hyper-agent') {
                                      dispatch({ type: 'OPEN_HYPER_AGENT_TAB' });
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

                        </div>
                      );
                    })()}

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
                <div className="launchpad-page library-page">
                  <div className="launchpad-inner">
                    {libraryTab === 'agents' ? (
                      <>
                        {/* Section 1: AI CLI agents — 4-col grid (default) */}
                        <div className="library-grid">
                          {AGENT_CATALOG.filter(item => item.type === 'ai-cli').map(item => {
                            const pinId = `agent:${item.key}`;
                            const isPinned = pinnedItems.includes(pinId);
                            const hasGear = (['claude', 'codex', 'gemini', 'qwen', 'opencode', 'openclaw', 'hermes'] as const).includes(item.key as any);
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
                  {/* Gear at entry = "manage your tools" (broad scope).
                      Per-tool gears inside = "configure this tool"
                      (narrow scope). Same symbol, nested semantics —
                      same pattern as magnifying glass for global vs
                      in-page search. Globally trained "齿轮 = 设置"
                      mental model beats the abstract 9-dot grid for
                      mass-market users. */}
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="3"/>
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
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
                Agents {pinnedItems.length}/{MAX_PINS}
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
    </>
  );
}

