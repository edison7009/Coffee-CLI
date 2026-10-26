import { Fragment, useState, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { focusTerminal } from '../../lib/focus-registry';
import { onWindowForeground } from '../../lib/window-focus-filter';
import { TierTerminal } from './TierTerminal';
import { AgentPages } from '../agent/AgentPages';
import { ClaudeConversation } from './ClaudeConversation';
import { CodexConversation } from './CodexConversation';
import { UsageDashboard } from './UsageDashboard';
import { ToolSettingsPage } from './ToolSettingsPage';
import { LaunchModeControl } from './LaunchModeControl';
import { SessionSplitDividers } from './SessionSplitDividers';
import { sessionSplitRects, splitSessionIds } from '../../lib/session-split-layout';
import { ToolConfigModal } from './ToolConfigModal';
import { ContributionHeatmap } from './ContributionHeatmap';
import { ErrorBoundary } from '../common/ErrorBoundary';
import { DiffPanel } from '../right/DiffPanel';
import { getTabOrder, supportsAgentStatus, useAppState, type ClaudeMode, type ToolType } from '../../store/app-state';
import { isFrostShape } from '../../lib/personalization';
import { isClaudeConversation, isCodexConversation } from '../../lib/chat-tools';

// Dropdown shown when a tool card is clicked: the globally
// recent project folders (any tool that used one) + "Open folder…" last.
// Clicking a recent launches THIS card's tool in that folder, anchored
// below the card. Portal-rendered with outside-click
// / Esc to close — same pattern as the terminal context menu.
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
              className="folder-menu-del close-button"
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
import CLAUDE_SVG from '../../icons-inline/claude.svg?raw';
import CODEX_SVG from '../../icons-inline/codex.svg?raw';
import ANTIGRAVITY_SVG from '../../icons-inline/antigravity.svg?raw';
import MIMOCODE_DATA_URL from '../../icons-inline/mimocode.png?inline';
import HERMES_DATA_URL from '../../icons-inline/hermes.png?inline';
import TERMINAL_MAC_DATA_URL from '../../icons-inline/terminal-macos.png?inline';
import TERMINAL_LINUX_DATA_URL from '../../icons-inline/terminal-linux.png?inline';
import TERMINAL_PWSH_SVG from '../../icons-inline/terminal-powershell.svg?raw';
// Additional tool icons (Pi = T2; Kimi Code = T1; Crush/Aider/Goose/Copilot = T3).
// SVG → ?raw, PNG → ?inline, same pipeline as the tools above.
import PI_SVG from '../../icons-inline/pi.svg?raw';
import COPILOT_SVG from '../../icons-inline/copilot.svg?raw';
import GROK_SVG from '../../icons-inline/grok.svg?raw';
import OPENCLAW_SVG from '../../icons-inline/openclaw.svg?raw';
import KILO_SVG from '../../icons-inline/kilo.svg?raw';
import CURSOR_SVG from '../../icons-inline/cursor.svg?raw';
import CLINE_SVG from '../../icons-inline/cline.svg?raw';
import OMP_SVG from '../../icons-inline/omp.svg?raw';
import CODEBUDDY_SVG from '../../icons-inline/codebuddy.svg?raw';
import MUSE_DATA_URL from '../../icons-inline/muse.png?inline';
import KIRO_SVG from '../../icons-inline/kiro.svg?raw';
import MINIMAX_SVG from '../../icons-inline/minimax.svg?raw';
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
// Antigravity brand mark — Lobe Icons set, 4-color ribbon under a mountain
// mask. Inlined as a string so multiple Launchpad mounts share the same
// gradient/filter ids without re-paint (same rationale as the other inline
// SVGs above). Source SVG had `width="1em" height="1em"`; normalized to
// `width="100%" height="100%"` so it fills the CSS-controlled 44px slot
// like the other tool icons.
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
const SvgMimo      = () => bgIcon(MIMOCODE_DATA_URL, '1em', { borderRadius: 'var(--radius-xs)' });
// Kilo Code (OpenCode fork, `kilo` binary) — official square favicon mark
// from kilo.ai. Hard-square art gets a rounded crop.
const SvgKilo      = () => inlineSvgIcon(KILO_SVG, '1em', { borderRadius: 'var(--radius-xs)', overflow: 'hidden' });
const SvgOpenClaw  = () => inlineSvgIcon(OPENCLAW_SVG);
const SvgCodex       = () => inlineSvgIcon(CODEX_SVG);
const SvgAntigravity = () => inlineSvgIcon(ANTIGRAVITY_SVG);
// PNG-backed icons render via CSS background-image with data-URI sources
// (see bgIcon). Hermes uses `cover` to fill the rounded square.
const SvgHermes      = () => bgIcon(HERMES_DATA_URL, '1em', { borderRadius: 'var(--radius-xs)', backgroundSize: 'cover' });
// Additional tool icons. Pi and Copilot are inline SVG brand marks; raster
// brand marks render via bgIcon.
const SvgPi        = () => inlineSvgIcon(PI_SVG);
const SvgCopilot   = () => inlineSvgIcon(COPILOT_SVG);
const SvgGrok       = () => inlineSvgIcon(GROK_SVG);
const SvgAider     = () => bgIcon(AIDER_DATA_URL, '1em', { borderRadius: 'var(--radius-xs)' });
const SvgKimi      = () => bgIcon(KIMICODE_DATA_URL, '1em', { borderRadius: 'var(--radius-xs)' });
const SvgCrush     = () => bgIcon(CRUSH_DATA_URL, '1em', { borderRadius: 'var(--radius-xs)' });
// Goose is a monochrome PNG, so its alpha channel masks the inherited theme color.
const SvgGoose     = () => bgIcon(GOOSE_DATA_URL, '1em', {
  backgroundImage: 'none',
  backgroundColor: 'currentColor',
  WebkitMask: `url(${GOOSE_DATA_URL}) center / contain no-repeat`,
  mask: `url(${GOOSE_DATA_URL}) center / contain no-repeat`,
});
// Cursor / Cline are monochrome currentColor marks (like Grok) so they follow
// the theme text color via inline SVG; Oh-My-Pi keeps its full-color gradient.
const SvgCursor    = () => inlineSvgIcon(CURSOR_SVG);
const SvgCline     = () => inlineSvgIcon(CLINE_SVG);
const SvgOmp       = () => inlineSvgIcon(OMP_SVG);
// CodeBuddy is a full-color gradient squircle (like OpenClaw / Oh-My-Pi) —
// inline SVG so the markup's own fills render verbatim and synchronously.
const SvgCodeBuddy = () => inlineSvgIcon(CODEBUDDY_SVG);
const SvgMuse = () => bgIcon(MUSE_DATA_URL);
const SvgKiro = () => inlineSvgIcon(KIRO_SVG);
const SvgMiniMax = () => inlineSvgIcon(MINIMAX_SVG);

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

// Tool → glyph map, shared by the chrome-tab AND the Gambit workspace chip
// (ActiveGambit repeats the active tab's icon in the compose footer so the
// chip reads as "tool + directory", the same icon+name pairing as the tab).
// renderTabContent keeps title/tooltip logic and falls back to SvgPlus for
// the placeholder new-tab; this owns ONLY the icon so there's one source of
// truth for which glyph a tool renders. Returns undefined for unknown tools
// (Gambit hides the icon rather than showing a wrong one).
const getToolIcon = (tool: ToolType): React.ReactNode => {
  switch (tool) {
    case 'claude': return <SvgClaude />;
    case 'qwen': return <SvgQwen />;
    case 'hermes': return <SvgHermes />;
    case 'opencode': return <SvgOpenCode />;
    case 'mimocode': return <SvgMimo />;
    case 'kilo': return <SvgKilo />;
    case 'openclaw': return <SvgOpenClaw />;
    case 'codex': return <SvgCodex />;
    case 'grok': return <SvgGrok />;
    case 'antigravity': return <SvgAntigravity />;
    case 'pi': return <SvgPi />;
    case 'crush': return <SvgCrush />;
    case 'aider': return <SvgAider />;
    case 'kimicode': return <SvgKimi />;
    case 'goose': return <SvgGoose />;
    case 'copilot': return <SvgCopilot />;
    case 'cursor': return <SvgCursor />;
    case 'cline': return <SvgCline />;
    case 'omp': return <SvgOmp />;
    case 'codebuddy': return <SvgCodeBuddy />;
    case 'muse': return <SvgMuse />;
    case 'kiro': return <SvgKiro />;
    case 'minimax': return <SvgMiniMax />;
    case 'remote':
    case 'terminal': return <TerminalIcon />;
    default: return undefined;
  }
};
export { getToolIcon };

// Pin sanitizer: must mirror AGENT_CATALOG keys below. Used at init to
// drop obsolete IDs from `coffee_pinned_items` (e.g. `agent:vibeid`
// from back when /vibeid was a launcher tool, before it became a
// regular skill). Without this, retired pins inflate the
// "Agents N/MAX_PINS" counter on the library tab — the stale cards
// render nothing because no AGENT_CATALOG entry matches, but they
// still count. Update this set when adding or removing AGENT_CATALOG
// entries below.
const VALID_PIN_KEYS = new Set<string>([
  'claude', 'opencode', 'mimocode', 'kilo', 'openclaw', 'codex', 'grok', 'antigravity', 'qwen', 'hermes', 'terminal',
  'pi', 'crush', 'aider', 'kimicode', 'goose', 'copilot', 'cursor', 'cline', 'omp',
  'codebuddy', 'muse', 'kiro', 'minimax',
]);

const CONFIGURABLE_AGENT_TOOLS = new Set<ToolType>([
  'claude', 'codex', 'grok', 'qwen', 'opencode',
  'mimocode', 'kilo', 'openclaw', 'hermes', 'pi', 'kimicode', 'omp',
  'codebuddy',
]);

// Dynamic Island visibility follows the shared agent-status capability: native
// OSC title tools plus TUIs covered by the rendered-screen semantic parser.
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
  const agentPageActive = state.agentPageActive;
  const usageOpen = state.usageOpen;
  const utilityPageOpen = usageOpen || state.toolSettingsOpen;
  const contentActive = !utilityPageOpen && !diffTabActive && !agentPageActive;
  const splitIds = splitSessionIds(state.sessionSplit);
  const splitVisible = contentActive && splitIds.length > 1 && splitIds.includes(activeTerminalId ?? '');
  const splitRects = splitVisible ? sessionSplitRects(state.sessionSplit!).leaves : [];
  const closeSplitLabel = t('split.close_pane');
  // Diff tab title = basename of the selected file (mirrors DiffPanel's own
  // header name). Computed here so the chrome-tab strip shows it without
  // mounting the DiffPanel body.
  const diffTabTitle = useMemo(() => {
    const p = state.diffSelection?.path ?? '';
    return p.replace(/\\/g, '/').split('/').pop() || p || (t('task.tab.changes') || 'Diff');
  }, [state.diffSelection?.path, t]);

  const [toolsInstalled, setToolsInstalled] = useState<Record<string, boolean>>({});
  // Per-tool launch override modal (gear icon → opens settings for that tool).
  const [configModalTool, setConfigModalTool] = useState<{ key: string; label: string } | null>(null);
  const [pinnedItems, setPinnedItems] = useState<string[]>(() => {
    // Hard cap must match MAX_PINS constant below. Inlined as a literal
    // because MAX_PINS is declared after this initializer runs.
    const CAP = 6;
    try {
      const stored = localStorage.getItem('coffee_pinned_items');
      if (stored !== null) {
        let arr = JSON.parse(stored);
        if (!Array.isArray(arr)) return [];
        arr = arr.filter((id: unknown, i: number) => arr.indexOf(id) === i);
        // Drop stale pin IDs from retired AGENT_CATALOG entries (e.g.
        // `agent:vibeid` after /vibeid became a skill, or the other retired
        // coordinated tools `agent:two-agent` / `agent:three-agent` /
        // `agent:hyper-agent`). These ghosts render nothing but inflate the
        // "Agents N/6" counter.
        arr = arr.filter((id: unknown) =>
          typeof id === 'string' && id.startsWith('agent:') && VALID_PIN_KEYS.has(id.slice('agent:'.length))
        );
        // Defensive cap: historical bugs (e.g. earlier migrations that
        // pushed past the limit) may have left > CAP items in storage.
        // Trim and persist back so the state stays consistent.
        if (arr.length > CAP) arr = arr.slice(0, CAP);
        try { localStorage.setItem('coffee_pinned_items', JSON.stringify(arr)); } catch { /* Best-effort operation; failure is non-fatal. */ }
        return arr;
      }
      // First launch: pre-pin 6 useful defaults so desktop shows a full MAX_PINS
      // grid out of the box (4 AI CLIs covering major providers + 2 utilities).
      // Returning users' pin choices are respected (stored !== null path above).
      const defaults = [
        'agent:claude',
        'agent:codex',
        'agent:opencode',
        'agent:antigravity',
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
    mimocode: <SvgMimo />,
    kilo: <SvgKilo />,
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
    cursor: <SvgCursor />,
    cline: <SvgCline />,
    omp: <SvgOmp />,
    codebuddy: <SvgCodeBuddy />,
    muse: <SvgMuse />,
    kiro: <SvgKiro />,
    minimax: <SvgMiniMax />,
  };

  // Built-in AI CLI catalog. Fully local — no remote fetch. Display
  // names are sourced from the Rust registry (see lib/tool-info.ts);
  // the order here is the launchpad's preferred presentation order.
  const BUILTIN_AI_CLI_FALLBACK: { key: ToolType; label: string }[] = [
    'claude', 'codex', 'cursor', 'copilot', 'antigravity',
    'openclaw', 'hermes', 'opencode', 'pi', 'cline', 'goose', 'aider',
    'omp', 'crush', 'qwen', 'kilo', 'kiro', 'kimicode',
    'codebuddy', 'grok', 'mimocode', 'minimax', 'muse',
  ].map((key) => ({ key: key as ToolType, label: getToolDisplayName(key) }));

  // Unified agent catalog — fully local. The remote catalog fetch
  // (coffeecli.com/agents/catalog.json) was deleted in v1.1.5; product
  // decision is that software is bundled with the app (delete-logic-not-add).
  // AI CLIs and utilities are both hardcoded below.
  // - `type`: semantic category ('ai-cli' | 'utility'). Lets future code group/filter items.
  // - `requiresCwd`: opens the directory chooser before launching from a Desktop card.
  const AGENT_CATALOG: { key: ToolType; label: string; icon: React.ReactNode; type: 'ai-cli' | 'utility'; requiresCwd: boolean }[] = (() => {
    // OpenClaw (persona forge) is directory-agnostic — its primary
    // workflow is global persona/skill management, not a project folder.
    // Skip the folder-picker so it launches in one click,
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

    return [...aiCliEntries, { key: 'terminal' as ToolType, label: t('tool.terminal'), icon: <TerminalIcon />, type: 'ai-cli' as const, requiresCwd: true }];
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
      try { localStorage.setItem('coffee_pinned_items', JSON.stringify(next)); } catch { /* Best-effort operation; failure is non-fatal. */ }
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
  // we can maintain its presentation integration exactly when a CLI flips from
  // not-installed → installed during a Coffee CLI session. `null`
  // sentinel = "we haven't scanned yet"; the very first scan does not
  // trigger any maintenance IPCs because startup's maintain_all() already
  // covered whatever was on PATH at launch — diffing against `null`
  // would re-fire those redundantly.
  const prevToolsInstalledRef = useRef<Record<string, boolean> | null>(null);
  const applyToolsInstalled = (result: Record<string, boolean>) => {
    const prev = prevToolsInstalledRef.current;
    if (prev !== null) {
      for (const tool of Object.keys(result)) {
        if (result[tool] === true && prev[tool] === false) {
          commands.maintainToolIntegration(tool).catch(() => {});
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
  const [claudeLaunchMode, setClaudeLaunchMode] = useState<ClaudeMode>(() => {
    try { return localStorage.getItem('coffee:claude-launch-mode') === 'terminal' ? 'terminal' : 'conversation'; } catch { return 'conversation'; }
  });
  const changeClaudeLaunchMode = (mode: ClaudeMode) => {
    setClaudeLaunchMode(mode);
    try { localStorage.setItem('coffee:claude-launch-mode', mode); } catch { /* optional preference */ }
  };
  const [codexLaunchMode, setCodexLaunchMode] = useState<ClaudeMode>(() => {
    try { return localStorage.getItem('coffee:codex-launch-mode') === 'terminal' ? 'terminal' : 'conversation'; } catch { return 'conversation'; }
  });
  const changeCodexLaunchMode = (mode: ClaudeMode) => {
    setCodexLaunchMode(mode);
    try { localStorage.setItem('coffee:codex-launch-mode', mode); } catch { /* optional preference */ }
  };
  // Shared recent project folders, most recently used first.
  const [recentFolders, setRecentFolders] = useState<string[]>(() => {
    try { const r = localStorage.getItem('coffee:recent-folders'); return r ? JSON.parse(r) : []; } catch { return []; }
  });
  const [folderMenu, setFolderMenu] = useState<{ x: number; y: number; tool: ToolType } | null>(null);
  const pushRecentFolder = (folder: string) => {
    setRecentFolders(prev => {
      const next = [folder, ...prev.filter(f => f !== folder)].slice(0, 8);
      try { localStorage.setItem('coffee:recent-folders', JSON.stringify(next)); } catch { /* Best-effort operation; failure is non-fatal. */ }
      return next;
    });
  };
  const removeRecentFolder = (folder: string) => {
    setRecentFolders(prev => {
      const next = prev.filter(f => f !== folder);
      try { localStorage.setItem('coffee:recent-folders', JSON.stringify(next)); } catch { /* Best-effort operation; failure is non-fatal. */ }
      return next;
    });
  };

  // ── Global focus enforcer ────────────────────────────────────────────────
  // One pair of window listeners for the whole app (previously each
  // TierTerminal added its own focusin + mouseup handlers, causing O(N)
  // dispatch per click with N tabs). When focus wanders to the body or a
  // non-input element, steal it back for the currently active terminal.
  const activeIdRef = useRef(contentActive ? activeTerminalId : null);
  useEffect(() => { activeIdRef.current = contentActive ? activeTerminalId : null; }, [activeTerminalId, contentActive]);
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
        // Comboboxes and search controls also retain keyboard focus.
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.getAttribute('role') === 'combobox' || el.getAttribute('role') === 'separator' || el.closest('[role="search"]'))) {
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
    } catch { /* Best-effort operation; failure is non-fatal. */ }
  }, []);

  // Derived state — must be before hooks that depend on it
  const activeSession = terminals.find(t => t.id === activeTerminalId);
  const isLaunchpadMode = activeSession && activeSession.tool === null;
  // Mirrored into a ref so the window-foreground rescan (which has [] deps and
  // can't see the latest value otherwise) can skip work while in a terminal tab.
  const isLaunchpadModeRef = useRef(isLaunchpadMode);
  useEffect(() => { isLaunchpadModeRef.current = isLaunchpadMode && !utilityPageOpen; }, [isLaunchpadMode, utilityPageOpen]);



  // Detect tool availability only when the Desktop (not Library) is actually visible.
  // Library is pure UI: pin/unpin never trigger IPC, scan is silent during browsing.
  // Scan runs on:
  //   - Launchpad first shown
  //   - Remote catalog refreshed
  // Returning to the launcher refreshes install state without reacting to pin changes.
  useEffect(() => {
    if (!isTauri || !isLaunchpadMode || utilityPageOpen) return;
    const SCAN_TTL_MS = 30_000;
    const handle = setTimeout(() => {
      if (Date.now() - lastToolsScanAt.current < SCAN_TTL_MS) return;
      commands.checkToolsInstalled()
        .then(applyToolsInstalled)
        .catch(() => {});
    }, 300);
    return () => clearTimeout(handle);
  }, [isLaunchpadMode, utilityPageOpen]);

  // Window-focus rescan — picks up CLIs the user just installed in an
  // external terminal without forcing them to restart Coffee CLI. The
  // launchpad-mode useEffect above only re-fires when isLaunchpadMode
  // / utilityPageOpen actually change; sitting on the launchpad while
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



  // The sidebar opens the tool selector without adding an empty titlebar tab.
  useEffect(() => {
    const openNewSession = () => {
      const idle = terminals.find(session => session.tool === null);
      if (idle) dispatch({ type: 'SET_ACTIVE_TERMINAL', id: idle.id });
      else dispatch({ type: 'ADD_TERMINAL', session: { id: crypto.randomUUID(), tool: null, folderPath: null } });
    };
    window.addEventListener('coffee-new-session', openNewSession);
    return () => window.removeEventListener('coffee-new-session', openNewSession);
  }, [terminals, dispatch]);

  // External launch (`coffee-cli launch --tool <id> [--cwd <dir>]`) — reached
  // from the cold-start drain (takePendingLaunch) and the warm-start
  // single-instance forward ('launch-request' event). Reuses an idle
  // launchpad tab when one exists so the agent never hijacks a tab that
  // already runs a session; otherwise opens a fresh session without a cap.
  const launchCtxRef = useRef({ terminals, activeTerminalId });
  const coldLaunchRef = useRef<ReturnType<typeof commands.takePendingLaunch> | null>(null);
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
      pushRecentFolder(cwd);
    }
    dispatch({ type: 'SET_TERMINAL_TOOL', id, tool });
  };

  // Drain the cold-start launch request once on mount, then keep listening
  // for warm-start forwards emitted by the single-instance plugin (second
  // process invoked as `launch …` — the running instance never restarts).
  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;
    (coldLaunchRef.current ??= commands.takePendingLaunch())
      .then(req => { if (!cancelled && req) applyLaunchRequest(req.tool as ToolType, req.cwd); })
      .catch(() => {});
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        if (cancelled) return;
        const handle = await listen<{ tool: string; cwd?: string }>('launch-request', e => {
          if (!cancelled) applyLaunchRequest(e.payload.tool as ToolType, e.payload.cwd);
        });
        if (cancelled) handle(); else unlisten = handle;
      } catch { /* event bridge unavailable (e.g. browser dev) — ignore */ }
    })();
    return () => { cancelled = true; unlisten?.(); };
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
  // **visible tab strip** (including Agent pages, in DOM order) — not the underlying
  // `state.terminals` array — because the slide-aside math operates on
  // what the user actually sees. `slotWidth` is the dragged tab's
  // visual footprint (own width + the flex `gap`); siblings translateX
  // by ±slotWidth to make room.
  const [tabDrag, setTabDrag] = useState<{
    tabId: string;
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

  const onTabPointerDown = (e: React.PointerEvent<HTMLDivElement>, tabId: string) => {
    // Ignore non-primary buttons + clicks on close button / status indicator
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('.tab-close-btn')) return;

    const headerEl = tabsHeaderRef.current;
    if (!headerEl) return;

    // Snapshot every visible tab's center X at drag start. Used by
    // drop AND by the shift math during drag — DOM is animating
    // during drag, so re-measuring would feed back into itself.
    const tabEls = Array.from(
      headerEl.querySelectorAll<HTMLElement>('.chrome-tab[data-tab-id]'),
    );
    const positions = tabEls.map(el => {
      const rect = el.getBoundingClientRect();
      return {
        tabId: el.dataset.tabId!,
        center: rect.left + rect.width / 2,
        width: rect.width,
      };
    });
    const fromIdx = positions.findIndex(p => p.tabId === tabId);
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
        tabId,
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
        const beforeId = targetIdx < others.length ? others[targetIdx].tabId : null;
        dispatch({ type: 'REORDER_TAB', tabId, beforeId });
      }
      setTabDrag(null);
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  };

  const onTabClickGuarded = (tabId: string) => {
    if (tabDragSuppressClickRef.current) {
      tabDragSuppressClickRef.current = false;
      return;
    }
    if (tabId === 'agent:agent' || tabId === 'agent:config') {
      dispatch({ type: 'OPEN_AGENT_PAGE', page: tabId === 'agent:agent' ? 'agent' : 'config' });
    } else {
      dispatch({ type: 'SET_ACTIVE_TERMINAL', id: tabId });
    }
  };

  const getTabDragStyle = (tabId: string, visibleIndex: number): React.CSSProperties | undefined => {
    if (!tabDrag) return undefined;
    if (tabDrag.tabId === tabId) return { transform: `translateX(${tabDrag.deltaX}px)` };
    const withoutIdx = visibleIndex < tabDrag.fromIdx ? visibleIndex : visibleIndex - 1;
    const shift = visibleIndex < tabDrag.fromIdx && withoutIdx >= tabDrag.targetIdx
      ? tabDrag.slotWidth
      : visibleIndex > tabDrag.fromIdx && withoutIdx < tabDrag.targetIdx ? -tabDrag.slotWidth : 0;
    return shift ? { transform: `translateX(${shift}px)` } : undefined;
  };

  const selectTool = async (tool: ToolType, toolData?: string, cwd?: string) => {
    if (tool === 'claude' && !cwd) { void handlePickFolder(tool); return; }
    if (cwd) {
      const checks = await commands.checkProjectDirectories([cwd]).catch(() => []);
      if (activeIdRef.current !== activeTerminalId) return;
      if (checks.some(check => check.status === 'missing' || check.status === 'not_directory')) {
        removeRecentFolder(cwd);
        void handlePickFolder(tool);
        return;
      }
    }
    // Concurrent multi-agent Tabs are now supported as of the per-pane
    // MCP / per-pane system-prompt rework: each pane has its own MCP
    // listener (different port), Claude panes write zero workspace
    // files, and `list_panes` / `send_to_pane` filter by the caller's
    // own Tab id so two open multi-agent Tabs never see each other.
    // The old single-instance lock that lived here has been removed.
    if (activeTerminalId) {
      if (cwd) {
        pushRecentFolder(cwd);
      }
      dispatch({ type: 'LAUNCH_TERMINAL_TOOL', id: activeTerminalId, tool, toolData, cwd, claudeMode: tool === 'claude' ? claudeLaunchMode : undefined, codexMode: tool === 'codex' ? codexLaunchMode : undefined });
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

  const openToolFolderMenu = (tool: ToolType, anchor: HTMLElement) => {
    if (recentFolders.length === 0) { void handlePickFolder(tool); return; }
    const card = anchor.closest('.launchpad-card');
    const rect = (card ?? anchor).getBoundingClientRect();
    setFolderMenu({ x: rect.left + rect.width * 0.55, y: rect.bottom + 4, tool });
    void commands.checkProjectDirectories(recentFolders).then(checks => {
      for (const check of checks) {
        if (check.status === 'missing' || check.status === 'not_directory') removeRecentFolder(check.path);
      }
    }).catch(() => {});
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
    } catch {
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
    } catch { /* Best-effort operation; failure is non-fatal. */ }

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
    // Icon comes from the shared tool→glyph map (also used by the Gambit
    // workspace chip) so the tab and the compose footer can't drift apart.
    // The placeholder new-tab (tool === null) falls back to the plus glyph.
    const icon = getToolIcon(session.tool) ?? <SvgPlus active={isActive} />;
    switch (session.tool) {
      case 'claude': return { icon, title: cwd ?? getToolDisplayName('claude'), tooltip: pathTip };
      case 'qwen': return { icon, title: cwd ?? getToolDisplayName('qwen'), tooltip: pathTip };
      // OpenClaw / Hermes are directory-agnostic tools — their tab title
      // stays as the tool name regardless of any inherited folderPath.
      case 'hermes': return { icon, title: getToolDisplayName('hermes'), tooltip: undefined };
      case 'opencode': return { icon, title: cwd ?? getToolDisplayName('opencode'), tooltip: pathTip };
      case 'mimocode': return { icon, title: cwd ?? getToolDisplayName('mimocode'), tooltip: pathTip };
      case 'kilo': return { icon, title: cwd ?? getToolDisplayName('kilo'), tooltip: pathTip };
      case 'openclaw': return { icon, title: getToolDisplayName('openclaw'), tooltip: undefined };
      case 'codex': return { icon, title: cwd ?? getToolDisplayName('codex'), tooltip: pathTip };
      case 'grok': return { icon, title: cwd ?? getToolDisplayName('grok'), tooltip: pathTip };
      case 'antigravity': return { icon, title: cwd ?? getToolDisplayName('antigravity'), tooltip: pathTip };
      // Directory-aware tabs use their icon plus cwd basename. Status-capable
      // TUIs below can still show an island through rendered-screen semantics.
      case 'pi': return { icon, title: cwd ?? getToolDisplayName('pi'), tooltip: pathTip };
      case 'crush': return { icon, title: cwd ?? getToolDisplayName('crush'), tooltip: pathTip };
      case 'aider': return { icon, title: cwd ?? getToolDisplayName('aider'), tooltip: pathTip };
      case 'kimicode': return { icon, title: cwd ?? getToolDisplayName('kimicode'), tooltip: pathTip };
      case 'goose': return { icon, title: cwd ?? getToolDisplayName('goose'), tooltip: pathTip };
      case 'copilot': return { icon, title: cwd ?? getToolDisplayName('copilot'), tooltip: pathTip };
      case 'cursor': return { icon, title: cwd ?? getToolDisplayName('cursor'), tooltip: pathTip };
      case 'cline': return { icon, title: cwd ?? getToolDisplayName('cline'), tooltip: pathTip };
      case 'omp': return { icon, title: cwd ?? getToolDisplayName('omp'), tooltip: pathTip };
      case 'codebuddy': return { icon, title: cwd ?? getToolDisplayName('codebuddy'), tooltip: pathTip };
      case 'muse': return { icon, title: cwd ?? getToolDisplayName('muse'), tooltip: pathTip };
      case 'kiro': return { icon, title: cwd ?? getToolDisplayName('kiro'), tooltip: pathTip };
      case 'minimax': return { icon, title: cwd ?? getToolDisplayName('minimax'), tooltip: pathTip };
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
          } catch { /* Best-effort operation; failure is non-fatal. */ }
        }
        return { icon, title, tooltip: undefined };
      }
      case 'terminal': return { icon, title: cwd ?? t('tool.terminal'), tooltip: pathTip };
      default: return { icon: <SvgPlus active={isActive} />, title: t('tab.new'), tooltip: undefined };
    }
  };

  // ── Custom background (image/video) ──────────────────────────────────────
  // Background state lives in global AppState (set via theme menu in Explorer)
  const bgPath = state.bgPath;
  const bgType = state.bgType;
  // Glass, Carbon, Monogram, and Character Flow force terminal-as-transparent even without an
  // in-app wallpaper, so the backdrop bleeds through (body bg is dropped /
  // replaced by the shape texture in those [data-shape] overrides). Without
  // this, the xterm canvas renders its solid `bgOpaque` and covers the
  // backdrop exactly where it matters most — the largest surface.
  const isBackdropShape = state.currentShape === 'glass' || isFrostShape(state.currentShape) || state.currentShape === 'carbon' || state.currentShape === 'monogram' || state.currentShape === 'characters';
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
      {tabSlot && createPortal(
      <div ref={tabsHeaderRef} className="chrome-tabs-header" data-count={terminals.filter(s => s.tool !== null && (!s.isHidden || s.id === activeTerminalId)).length + state.agentPages.length}>
        {(() => {
          const sessions = new Map(terminals.map(session => [session.id, session]));
          const visibleTabs = getTabOrder(state).filter(id => {
            const session = sessions.get(id);
            return !session || session.tool !== null && (!session.isHidden || id === activeTerminalId);
          });
          return visibleTabs.map((tabId, visibleIndex) => {
          const isDragging = tabDrag?.tabId === tabId;
          const dragStyle = getTabDragStyle(tabId, visibleIndex);
          if (tabId === 'agent:agent' || tabId === 'agent:config') {
            const page = tabId === 'agent:agent' ? 'agent' : 'config';
            return (
              <div key={tabId} data-tab-id={tabId}
                className={`chrome-tab ${agentPageActive === page && !utilityPageOpen ? 'active' : ''} ${isDragging ? 'dragging' : ''}`}
                style={dragStyle} onClick={() => onTabClickGuarded(tabId)}
                onPointerDown={event => onTabPointerDown(event, tabId)}>
                <span className="tab-title">{page === 'agent' ? 'Coffee Agent' : t('agent.page.settings')}</span>
                <div className="tab-actions tab-actions--close-only">
                  <button type="button" className="tab-close-btn close-button" aria-label={t(page === 'agent' ? 'agent.page.close_agent' : 'agent.page.close_settings')} onClick={event => { event.stopPropagation(); dispatch({ type: 'CLOSE_AGENT_PAGE', page }); }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m18 6-12 12M6 6l12 12" /></svg>
                  </button>
                </div>
              </div>
            );
          }
          const session = sessions.get(tabId)!;

          // A terminal tab is "active" only when it's the focused surface —
          // when the diff tab is focused (diffTabActive), no terminal tab
          // should show the active highlight (the diff chrome-tab does).
          const isActive = session.id === activeTerminalId && contentActive;
          const { icon, title: baseTitle } = renderTabContent(session, isActive);
          // Tool's live OSC 0/2 title (Claude Code conversation summary, etc.)
          // overrides the cwd basename when the tool has set a non-empty one.
          // Muse inherits its Windows launcher's title; keep the workspace name.
          const title = session.tool === 'muse' ? baseTitle : session.toolTitle?.trim() || baseTitle;
          const showAgentStatus = supportsAgentStatus(session.tool)
            && (['claude', 'codex', 'kimicode', 'omp'].includes(session.tool ?? '') || session.agentStatus !== undefined);
          return (
            <div
              key={session.id}
              data-session-id={session.id}
              data-tab-id={session.id}
              className={`chrome-tab ${isActive ? 'active' : ''} ${isDragging ? 'dragging' : ''}`}
              style={dragStyle}
              onClick={() => onTabClickGuarded(session.id)}
              onPointerDown={(e) => onTabPointerDown(e, session.id)}
            >
              {icon}
              <span className="tab-title" style={{ flex: '0 1 auto', minWidth: 0, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>{title}</span>
              <div className={`tab-actions${showAgentStatus ? '' : ' tab-actions--close-only'}`}>
                {showAgentStatus && (
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
                   className="tab-close-btn close-button"
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
            className={`chrome-tab ${diffTabActive && !utilityPageOpen ? 'active' : ''}`}
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
            <div className="tab-actions tab-actions--close-only">
              <button
                className="tab-close-btn close-button"
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

      </div>,
      tabSlot)}
      <div className={`main-content${splitVisible ? ' has-session-split' : ''}`}>

        {terminals.map(t => t.tool !== null ? (
          <div
            key={t.id}
            className={`terminal-wrapper${splitVisible && splitIds.includes(t.id) ? ` session-split-pane${t.id === activeTerminalId ? ' is-focused' : ''}` : ''}`}
            data-session-id={t.id}
            data-split-eligible="true"
            onPointerDownCapture={() => { if (splitVisible && splitIds.includes(t.id) && t.id !== activeTerminalId) dispatch({ type: 'SET_ACTIVE_TERMINAL', id: t.id }); }}
            onFocusCapture={() => { if (splitVisible && splitIds.includes(t.id) && t.id !== activeTerminalId) dispatch({ type: 'SET_ACTIVE_TERMINAL', id: t.id }); }}
            style={{
              // Hide every terminal wrapper while the diff tab is focused —
              // the diff surface takes over the content area (the underlying
              // PTYs stay mounted, just not displayed).
              display: (contentActive && (splitVisible ? splitIds.includes(t.id) : t.id === activeTerminalId)) ? 'flex' : 'none',
              width: `${splitRects.find(rect => rect.id === t.id)?.width ?? 100}%`,
              height: `${splitRects.find(rect => rect.id === t.id)?.height ?? 100}%`,
              position: splitVisible ? 'absolute' : 'relative',
              left: splitVisible ? `${splitRects.find(rect => rect.id === t.id)?.left ?? 0}%` : undefined,
              top: splitVisible ? `${splitRects.find(rect => rect.id === t.id)?.top ?? 0}%` : undefined,
            }}
          >
            {isCodexConversation(t) ? (
              <CodexConversation key={`codex-${t.id}-${t.restartKey ?? 0}`} sessionId={t.id} cwd={t.folderPath} resumeToken={t.resumeToken} isActive={t.id === activeTerminalId && contentActive} isVisible={contentActive && (splitVisible ? splitIds.includes(t.id) : t.id === activeTerminalId)} hasBg={hasBg} bgUrl={bgUrl} bgType={bgType} />
            ) : isClaudeConversation(t) ? (
              <ClaudeConversation
                key={`claude-${t.id}-${t.restartKey ?? 0}`}
                sessionId={t.id}
                cwd={t.folderPath}
                resumeToken={t.resumeToken}
                isActive={t.id === activeTerminalId && contentActive}
                isVisible={contentActive && (splitVisible ? splitIds.includes(t.id) : t.id === activeTerminalId)}
                hasBg={hasBg}
                bgUrl={bgUrl}
                bgType={bgType}
              />
            ) : (
              <>
                <div className="terminal-mode-surface">
                  <ErrorBoundary key={`err-${t.id}-${t.restartKey || 0}`} fallbackLabel="Tier Terminal Error">
                    <TierTerminal
                      key={`tier-${t.id}-${t.restartKey || 0}`}
                      sessionId={t.id}
                      tool={t.tool}
                      toolName={AGENT_CATALOG.find(a => a.key === t.tool)?.label}
                      theme={state.currentTheme}
                      lang={state.currentLang}
                      isActive={t.id === activeTerminalId && contentActive}
                      isVisible={contentActive && (splitVisible ? splitIds.includes(t.id) : t.id === activeTerminalId)}
                      toolData={t.toolData}
                      folderPath={t.folderPath}
                      resumeToken={t.resumeToken}
                      strictCwd={t.strictCwd}
                      hasBg={hasBg}
                      bgUrl={bgUrl}
                      bgType={bgType}
                      termColorScheme={state.termColorScheme}
                      termFont={state.termFont}
                    />
                  </ErrorBoundary>
                </div>
              </>
            )}
            {splitVisible && splitIds.includes(t.id) && <button className="pane-number-badge pane-number-badge--closable close-button" aria-label={`${closeSplitLabel} ${splitIds.indexOf(t.id) + 1}`} onClick={event => { event.stopPropagation(); dispatch({ type: 'CLOSE_SESSION_SPLIT', id: t.id }); }}>
              <span className="pane-badge-num">{splitIds.indexOf(t.id) + 1}</span><span className="pane-badge-x" aria-hidden="true">×</span>
            </button>}
          </div>
        ) : null)}
        {splitVisible && state.sessionSplit && <SessionSplitDividers layout={state.sessionSplit} />}

        {/* Diff tab content — fills the content area when the diff tab is
            focused. The DiffPanel body handles its own loading/error/too-large
            states; mode="tab" makes it fill this slot (no portal/backdrop). */}
        {diffTabVisible && diffTabActive && !utilityPageOpen && state.diffSelection && (
          <div className="terminal-wrapper" style={{ display: 'flex', width: '100%', height: '100%', position: 'relative' }}>
            <DiffPanel
              mode="tab"
              path={state.diffSelection.path}
              repoRoot={state.diffSelection.repoRoot}
              rel={state.diffSelection.rel}
              kind={state.diffSelection.kind}
              fileSize={state.diffSelection.fileSize}
              commitHash={state.diffSelection.commitHash}
              onClose={() => dispatch({ type: 'CLEAR_DIFF' })}
              onToggleExpanded={() => dispatch({ type: 'SET_DIFF_MODE', mode: 'overlay' })}
              added={state.diffSelection.added}
              deleted={state.diffSelection.deleted}
            />
          </div>
        )}

        {state.agentPages.map(page => (
          <div key={page} className="terminal-wrapper" style={{ display: agentPageActive === page && !utilityPageOpen ? 'flex' : 'none', width: '100%', height: '100%' }}>
            <AgentPages page={page} />
          </div>
        ))}

        {usageOpen && <UsageDashboard />}
        <ToolSettingsPage active={state.toolSettingsOpen} tools={AGENT_CATALOG.filter(item => pinnedItems.includes(`agent:${item.key}`)).map(item => ({ value: item.key as string, label: item.label, icon: item.icon }))} count={pinnedItems.length} limit={MAX_PINS}>
          {[true, false].map(enabled => {
            const items = AGENT_CATALOG.filter(item => item.type === 'ai-cli' && pinnedItems.includes(`agent:${item.key}`) === enabled);
            return items.length > 0 ? <Fragment key={String(enabled)}>
              {!enabled && pinnedItems.length > 0 && <hr className="library-divider" />}
              <div className="library-grid" data-enabled={enabled}>
                {items.map(item => {
                  const pinId = `agent:${item.key}`;
                  const isPinned = pinnedItems.includes(pinId);
                  const hasGear = CONFIGURABLE_AGENT_TOOLS.has(item.key);
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
                      <div className={`library-toggle${isPinned ? ' on' : ''}`}><div className="library-toggle-knob" /></div>
                    </div>
                  );
                })}
              </div>
            </Fragment> : null;
          })}
        </ToolSettingsPage>
        {isLaunchpadMode && activeTerminalId && contentActive && (
          <div className={`launchpad-container${hasBg && bgUrl ? ' launchpad-has-bg' : ''}`} style={{ position: 'relative' }}>
            {hasBg && bgUrl && (
              <div className="launchpad-bg">
                {bgType === 'video'
                  ? <video src={bgUrl} autoPlay loop muted playsInline onError={() => { setBgUrl(''); }} />
                  : <img src={bgUrl} alt="" onError={() => { setBgUrl(''); }} />}
              </div>
            )}
                <div className="launchpad-page">
                  <div className="launchpad-inner">
                    {(() => {
                      const pinnedAgents = AGENT_CATALOG.filter(a => pinnedItems.includes(`agent:${a.key}`));

                      if (pinnedAgents.length === 0) {
                        return null;
                      }

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
                                  onClick={(event) => {
                                    if (disabled) return;
                                    if (tool.requiresCwd) { openToolFolderMenu(tool.key, event.currentTarget); return; }
                                    selectTool(tool.key);
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
                                  </div>
                                  {CONFIGURABLE_AGENT_TOOLS.has(tool.key) && <button type="button" className="launchpad-config" aria-label={`${tool.label} ${t('settings.title')}`} onClick={event => { event.stopPropagation(); setFolderMenu(null); setConfigModalTool({ key: tool.key as string, label: tool.label }); }}>
                                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                      <circle cx="12" cy="12" r="3" />
                                      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                                    </svg>
                                  </button>}
                                  {tool.type === 'ai-cli' && <LaunchModeControl value={tool.key === 'claude' ? claudeLaunchMode : tool.key === 'codex' ? codexLaunchMode : 'terminal'} disabled={disabled} label={tool.key === 'codex' ? 'Codex' : undefined} onChange={tool.key === 'claude' ? changeClaudeLaunchMode : tool.key === 'codex' ? changeCodexLaunchMode : undefined} />}
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
                        data-tip={t('launchpad.detect_help_tip')}
                      >
                        {t('launchpad.detect_help_trigger')}
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
                        data-tip={t('launchpad.switch_model_tip')}
                        onClick={(e) => {
                          e.preventDefault();
                          commands.openUrl('https://echobird.ai/').catch(() => {});
                        }}
                      >
                        {t('launchpad.switch_model_trigger')}
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
                            <span>{t('remote.title')}</span>
                            <button className="remote-form-close close-button" onClick={() => setShowRemoteForm(false)}>
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
                              <label>{t('remote.host')}</label>
                              <div className="remote-form-host-row">
                                <input
                                  type="text"
                                  placeholder={t('remote.host_placeholder') || "192.168.1.100"}
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
                                  <label>{t('remote.username')}</label>
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
                                  <label>{t('remote.password')}</label>
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
                              {connStatus === 'connecting' && t('remote.connecting')}
                              {connStatus === 'failed' && t('remote.connect_failed')}
                              {connStatus === 'idle' && t('remote.connect')}
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
                                  } catch {
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
                                  try { localStorage.setItem('coffee_remote_cfg', JSON.stringify(connDataObj)); } catch { /* Best-effort operation; failure is non-fatal. */ }
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
                                <button className="remote-pill-close close-button" onClick={(e) => deleteRemoteHistory(item.id, e)}>
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
          openLabel={t('launchpad.open_folder') || 'Open folder…'}
          onPick={(f) => { selectTool(folderMenu.tool, undefined, f); setFolderMenu(null); }}
          onRemove={(f) => removeRecentFolder(f)}
          onOpenNew={() => { const tk = folderMenu.tool; setFolderMenu(null); handlePickFolder(tk); }}
          onClose={() => setFolderMenu(null)}
        />
      )}
    </>
  );
}

