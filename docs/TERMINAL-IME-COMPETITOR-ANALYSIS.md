# Terminal IME Competitor Analysis

> Coffee-CLI competitive research: how 23 terminal emulators handle IME (Input Method Editor) positioning for CJK input, with focus on multi-monitor behavior.
>
> Last updated: 2026-04-16

---

## TL;DR

| Category | IME Approach | Multi-Monitor | Representative |
|----------|-------------|---------------|----------------|
| Native macOS | `NSTextInputClient` + `convertRectToScreen:` | Works correctly | iTerm2, Kitty |
| Native Windows | IMM32 `ImmSetCompositionWindow` or TSF `CoreTextEditContext` | Manual screen-coord conversion needed | Windows Terminal, mintty |
| Web-based (Electron/Tauri) | Hidden `<textarea>` positioned by xterm.js | **Chromium platform bug** -- candidate window may appear on wrong monitor | Tabby, Hyper, **Coffee-CLI** |
| Rust GPU | Delegate to winit/GLFW IME APIs | Handled by windowing library | Alacritty, WezTerm |

**Key insight**: Native terminals solve IME positioning via OS APIs that inherently handle multi-monitor. Web-based terminals all share the same Chromium coordinate-conversion limitation.

---

## macOS Terminals

### 1. iTerm2

| | |
|---|---|
| **Website** | https://iterm2.com/ |
| **GitHub** | https://github.com/gnachman/iTerm2 |
| **Engine** | Native Cocoa + CoreText/Metal GPU |
| **IME API** | `NSTextInputClient` on `PTYTextView` |
| **Multi-monitor** | No issues -- `convertRectToScreen:` handles it automatically |

**Implementation**: `firstRectForCharacterRange:` converts grid cursor to screen coordinates. Tracks `inputMethodEditorLength` for double-width CJK chars. Being a full native `NSView` is the gold standard -- the OS handles DPI and screen geometry automatically.

**Key source**: `sources/PTYTextView.m`

### 2. Warp

| | |
|---|---|
| **Website** | https://www.warp.dev/ |
| **GitHub** | https://github.com/warpdotdev/warp |
| **Engine** | Rust + Metal GPU (proprietary) |
| **IME API** | Incomplete |
| **Multi-monitor** | N/A -- basic IME still missing on Windows |

**Known issues**:
- [#9012](https://github.com/warpdotdev/warp/issues/9012) -- No preedit rendering on Windows (OPEN)
- [#8919](https://github.com/warpdotdev/warp/issues/8919) -- Korean last char dropped on Enter (OPEN)
- [#8566](https://github.com/warpdotdev/warp/issues/8566) -- Japanese Ctrl+H double deletion (OPEN)
- [#8597](https://github.com/warpdotdev/warp/issues/8597) -- Korean IME freezes on Linux

**Takeaway**: Cautionary example -- a GPU-first terminal that deprioritized IME, leaving CJK users without basic composition visibility.

### 3. Ghostty

| | |
|---|---|
| **Website** | https://ghostty.org/ |
| **GitHub** | https://github.com/ghostty-org/ghostty |
| **Engine** | Zig + Metal/OpenGL GPU |
| **IME API** | `NSTextInputClient` (still maturing) |
| **Multi-monitor** | No specific issues |

**Known issues**:
- [#12277](https://github.com/ghostty-org/ghostty/issues/12277) -- Chinese IME keystrokes leak into terminal (OPEN)
- [#11461](https://github.com/ghostty-org/ghostty/issues/11461) -- Korean preedit cancelled on arrow keys (milestone 1.3.2)
- [#2502](https://github.com/ghostty-org/ghostty/issues/2502) -- Preedit text doesn't wrap on long compositions
- [#4539](https://github.com/ghostty-org/ghostty/issues/4539) -- AquaSKK Japanese poorly handled

**Takeaway**: Still maturing. The keystroke leak (#12277) indicates `setMarkedText:`/`insertText:` flow is not fully filtering composed keystrokes from raw key events.

### 4. Alacritty

| | |
|---|---|
| **Website** | https://alacritty.org/ |
| **GitHub** | https://github.com/alacritty/alacritty |
| **Engine** | Rust + OpenGL via winit |
| **IME API** | Delegates to **winit** (`NSTextInputClient` on macOS) |
| **Multi-monitor** | No issues -- winit's `convertRectToScreen:` handles it |

**Implementation**: Calculates `ime_position` from `term::point_to_viewport()`, then calls `set_ime_cursor_area` on the winit window. The indirection through winit means Alacritty doesn't touch `firstRectForCharacterRange:` directly.

**Known issues**:
- [#6942](https://github.com/alacritty/alacritty/issues/6942) -- CJK IME input dropped on macOS (milestone 0.18.0)
- [#8079](https://github.com/alacritty/alacritty/issues/8079) -- Double space with CJK IME on macOS
- [#7341](https://github.com/alacritty/alacritty/issues/7341) -- Redundant IME position updates every frame

---

## Windows Terminals

### 5. Windows Terminal

| | |
|---|---|
| **GitHub** | https://github.com/microsoft/terminal |
| **Engine** | UWP/XAML + DirectX |
| **IME API** | **TSF 3.0** via `CoreTextEditContext` (modern, NOT IMM32) |
| **Multi-monitor** | Fixed via [PR #5609](https://github.com/microsoft/terminal/pull/5609) |

**Implementation**: `TSFInputControl.cpp` responds to `CoreTextLayoutRequestedEventArgs` by computing screen-coordinate `LayoutBounds`. Steps: get window position, get cursor client coords, translate to screen, apply control offset (tabs/margins), apply DPI scale.

**Known issues**:
- [#5470](https://github.com/microsoft/terminal/issues/5470) -- TSFInputControl alignment off on High DPI (FIXED)
- [#14349](https://github.com/microsoft/terminal/issues/14349) -- Japanese IME hangs

**Key source**: [`src/cascadia/TerminalControl/TSFInputControl.cpp`](https://github.com/microsoft/terminal/blob/main/src/cascadia/TerminalControl/TSFInputControl.cpp)

**DPI handling**: Per-monitor DPI aware (V2). Redraws canvas on window move to update IME bounds. Early bug: `LogicalDPI` always returned 96; had to use actual scale factor.

### 6. PowerShell 7

| | |
|---|---|
| **GitHub** | https://github.com/PowerShell/PowerShell |
| **Engine** | Hosted inside a terminal emulator (conhost or Windows Terminal) |
| **IME** | Delegated to the hosting terminal |

PowerShell itself does not handle IME -- it's a shell, not a terminal emulator. IME behavior depends entirely on the host terminal (conhost.exe, Windows Terminal, etc.).

### 7. Cmder / ConEmu

| | |
|---|---|
| **Website** | https://cmder.app/ / https://conemu.github.io/ |
| **GitHub** | https://github.com/cmderdev/cmder / https://github.com/Maximus5/ConEmu |
| **Engine** | Native Win32 (GDI) |
| **IME API** | **IMM32** (`WM_IME_CHAR`, `WM_IME_COMPOSITION`) |
| **Multi-monitor** | Historically buggy DPI scaling ([ConEmu #275](https://github.com/Maximus5/ConEmu/issues/275)) |

Cmder is a wrapper around ConEmu. ConEmu handles `WM_IME_CHAR` / `WM_IME_COMPOSITION` / `WM_IME_ENDCOMPOSITION` in `RealConsole.cpp`, posts `WM_IME_CHAR` to ChildGui window.

### 8. MobaXterm

| | |
|---|---|
| **Website** | https://mobaxterm.mobatek.net/ |
| **Engine** | Custom native Win32 + embedded X server |
| **IME API** | IMM32 (added in v7.0) |
| **Multi-monitor** | No public data |

Commercial, no public issue tracker. CJK keyboards "fully managed" per release notes. Font/charset must be manually set per session.

### 9. XShell

| | |
|---|---|
| **Website** | https://www.netsarang.com/products/xsh_overview.html |
| **Engine** | Native Win32 |
| **IME API** | IMM32 |
| **Multi-monitor** | No public data |

Commercial, no public issue tracker. Uses Windows encoding and OS-provided IME.

### 10. Fluent Terminal

| | |
|---|---|
| **GitHub** | https://github.com/felixse/FluentTerminal |
| **Engine** | UWP host + **xterm.js** WebView |
| **IME API** | Browser/WebView IME (hidden textarea) |
| **Multi-monitor** | Same Chromium/WebView limitation |

Delegates IME entirely to xterm.js `CompositionHelper`. No custom textarea positioning logic. Subject to same [xterm.js #5734](https://github.com/xtermjs/xterm.js/issues/5734) upstream bugs.

---

## Cross-Platform Terminals

### 11. Tabby

| | |
|---|---|
| **Website** | https://tabby.sh/ |
| **GitHub** | https://github.com/eugeny/tabby |
| **Engine** | Electron + xterm.js |
| **IME API** | xterm.js `CompositionHelper` (no custom overrides) |
| **Multi-monitor** | Chromium platform limitation |

**Known issues**:
- [#10867](https://github.com/eugeny/tabby/issues/10867) -- Chinese IME cursor shifts right, text misaligned (OPEN)
- [#11013](https://github.com/eugeny/tabby/issues/11013) -- Chinese punctuation broken with Sogou/WeChat IME on macOS (OPEN)
- [#11055](https://github.com/eugeny/tabby/issues/11055) -- Third-party voice input methods not working (OPEN)
- [#7256](https://github.com/eugeny/tabby/issues/7256) -- Repeated input when switching IME mode on macOS (OPEN)

### 12. Hyper

| | |
|---|---|
| **Website** | https://hyper.is/ |
| **GitHub** | https://github.com/vercel/hyper |
| **Engine** | Electron + xterm.js |
| **IME API** | xterm.js `CompositionHelper` (no custom overrides) |
| **Multi-monitor** | Chromium platform limitation |

**Known issues** (mostly resolved by xterm.js upstream fixes):
- [#2466](https://github.com/vercel/hyper/issues/2466) -- Chinese font wrong width, IME broken (2017, fixed)
- [#504](https://github.com/vercel/hyper/issues/504) -- Could not input Chinese/Japanese (fixed)
- [#1611](https://github.com/vercel/hyper/issues/1611) -- Windows 10 Chinese IME broke typing (fixed)

### 13. Kitty

| | |
|---|---|
| **Website** | https://sw.kovidgoyal.net/kitty/ |
| **GitHub** | https://github.com/kovidgoyal/kitty |
| **Engine** | C + Python + OpenGL, custom GLFW fork |
| **IME API** | `firstRectForCharacterRange:` in GLFW fork (`glfw/cocoa_window.m`) |
| **Multi-monitor** | Correctly handled via `convertRectToScreen:` |

**Implementation** (reference pattern -- 4-step coordinate pipeline):
1. `get_ime_cursor_position` callback returns pixel-space left/top/width/height
2. Divide by `window->ns.xscale` / `yscale` for Retina scaling
3. Flip Y axis: `frame.size.height - top - cellHeight` (Cocoa origin is bottom-left)
4. `[window->ns.object convertRectToScreen: rectInView]`

**Known issues**:
- [#8850](https://github.com/kovidgoyal/kitty/issues/8850) -- Quick Access Terminal overlaps Chinese IME candidate box
- [#5241](https://github.com/kovidgoyal/kitty/issues/5241) -- Inconsistent IBus cursor location
- [#4849](https://github.com/kovidgoyal/kitty/issues/4849) -- tmux status line causes IBus position jump
- [#1000](https://github.com/kovidgoyal/kitty/issues/1000) -- Bad preedit position after commit on Linux/IBus

**Key source**: `glfw/cocoa_window.m`

### 14. WezTerm

| | |
|---|---|
| **Website** | https://wezfurlong.org/wezterm/ |
| **GitHub** | https://github.com/wez/wezterm |
| **Engine** | Rust + OpenGL/Metal/WebGPU |
| **IME API** | macOS: `firstRectForCharacterRange:` + `convertRectToScreen:`. Windows: **IMM32** (`ImmSetCompositionWindow` / `ImmSetCandidateWindow`) |
| **Multi-monitor** | Fixed via [PR #2022](https://github.com/wez/wezterm/pull/2022) |

**Windows details**: Calls Win32 `ImmSetCompositionWindow` / `ImmSetCandidateWindow` directly through an `ImmContext` RAII wrapper. Uses `get_effective_dpi()` with per-monitor overrides and `AdjustWindowRectExForDpi` for coordinate scaling. Handles `WM_IME_STARTCOMPOSITION` / `WM_IME_COMPOSITION` messages.

**Known issues**:
- [#2569](https://github.com/wez/wezterm/issues/2569) -- IME preedit rendered on ALL panes simultaneously (fixed in nightly)
- [#7157](https://github.com/wez/wezterm/issues/7157) -- Crash with Japanese IME CorvusSKK on Windows

### 15. Wave Terminal

| | |
|---|---|
| **Website** | https://www.waveterm.dev/ |
| **GitHub** | https://github.com/wavetermdev/waveterm |
| **Engine** | Go + Electron + xterm.js |
| **IME API** | xterm.js `CompositionHelper` |
| **Multi-monitor** | Chromium platform limitation |

**Known issues**:
- [#2629](https://github.com/wavetermdev/waveterm/issues/2629) -- IME candidate window at window edge (not cursor) with nested Zellij (OPEN)
- [#3164](https://github.com/wavetermdev/waveterm/issues/3164) -- Korean IME chars garbled during fast typing (OPEN)
- [#2915](https://github.com/wavetermdev/waveterm/issues/2915) -- Korean IME composition never committed (CLOSED)

**Takeaway**: Wave's extra Go backend layer between Electron and xterm.js introduces additional event-handling hops that cause race conditions with IME composition events.

---

## Other Terminals

### 19. ConEmu

(Covered above under Cmder/ConEmu, #7)

### 20. Shell360

| | |
|---|---|
| **GitHub** | https://github.com/nashaofu/shell36 |
| **Engine** | Likely Electron + xterm.js (based on author's other projects) |
| **IME** | Presumably xterm.js `CompositionHelper` |
| **Status** | Repo may be renamed/archived, not readily accessible |

### 21. IShell

| | |
|---|---|
| **Website** | https://ishell.cc/zh-CN |
| **Engine** | Commercial, no public source |
| **IME** | Unknown |

### 22. Git Bash (mintty)

| | |
|---|---|
| **Website** | https://gitforwindows.org/ |
| **Engine** | Native Win32 (GDI) via **mintty** |
| **IME API** | **IMM32** (`ImmSetCompositionWindow` with `CFS_POINT`) |
| **Multi-monitor** | DPI jump issues ([mintty #696](https://github.com/mintty/mintty/issues/696)) |

**Implementation**: Classic IMM32 pattern -- on `WM_IME_STARTCOMPOSITION`, get caret pixel position from `cell_col * cell_width + window_client_origin`, call `ImmSetCompositionWindow`. CJK width handled via `@cjkwide`/`@cjknarrow` locale modifiers.

### 23. Zellij

| | |
|---|---|
| **Website** | https://zellij.dev/ |
| **GitHub** | https://github.com/zellij-org/zellij |
| **Engine** | Rust TUI (crossterm) |
| **IME API** | Delegated to host terminal (no own IME handling) |
| **Multi-monitor** | N/A -- depends on host terminal |

**Known issues** (web/WASM mode only):
- [#4974](https://github.com/zellij-org/zellij/issues/4974) -- Web client repeats IME text N times for N-char composition (OPEN)
- [#4494](https://github.com/zellij-org/zellij/issues/4494) -- Same duplication bug for Chinese in web mode (OPEN)

In native mode, Zellij delegates IME entirely to the host terminal. Crossterm treats composed characters as regular key events after the OS commits them.

---

## IME Technical Architecture Comparison

### Three IME Approaches

| Approach | How it works | Multi-Monitor | DPI Scaling | Used By |
|----------|-------------|---------------|-------------|---------|
| **macOS `NSTextInputClient`** | `firstRectForCharacterRange:` returns cursor screen rect; `convertRectToScreen:` handles coordinate space | Automatic | Automatic (scale by `xscale`/`yscale`) | iTerm2, Kitty, Ghostty, Alacritty (via winit), WezTerm |
| **Windows IMM32** | `ImmSetCompositionWindow(CFS_POINT)` on `WM_IME_STARTCOMPOSITION`; pass screen-coordinate pixel position | Manual: must convert client-to-screen coords | Manual: `AdjustWindowRectExForDpi` | ConEmu, mintty, WezTerm, MobaXterm, XShell |
| **Windows TSF** | `CoreTextEditContext` + `LayoutBounds` in screen coords | Manual: re-query on window move | Manual: use actual scale factor (not `LogicalDPI`) | Windows Terminal |
| **Web (xterm.js)** | Hidden `<textarea>` positioned at cursor; browser reports `getBoundingClientRect()` to OS IME | **Broken** -- Chromium coordinate conversion bug ([Chromium#378945](https://bugs.chromium.org/p/chromium/issues/detail?id=378945)) | Delegated to browser/WebView | Tabby, Hyper, Wave, Fluent Terminal, **Coffee-CLI** |

### Canonical macOS IME Pipeline (Kitty reference)

```
cursor grid (col, row)
  --> pixel coords (col * cellWidth, row * cellHeight)
    --> divide by Retina scale (xscale, yscale)
      --> flip Y axis (Cocoa bottom-left origin)
        --> convertRectToScreen: (handles multi-monitor automatically)
```

### Canonical Windows IME Pipeline (mintty/WezTerm reference)

```
cursor grid (col, row)
  --> pixel coords (col * cellWidth, row * cellHeight)
    --> client-to-screen conversion (add window position)
      --> DPI adjustment (AdjustWindowRectExForDpi or manual scale)
        --> ImmSetCompositionWindow(CFS_POINT, screenPoint)
```

### xterm.js Pipeline (all web terminals)

```
cursor grid (col, row)
  --> pixel coords (col * cellWidth, row * cellHeight)
    --> set textarea style.left / style.top
      --> browser getBoundingClientRect() --> screen coords
        --> OS IME reads position
        ^^^^^ This step has known Chromium multi-monitor bugs
```

---

## xterm.js Upstream IME Issues

| Issue | Status | Description |
|-------|--------|-------------|
| [#5734](https://github.com/xtermjs/xterm.js/issues/5734) | Closed | IME candidate window mispositioned with placeholder text |
| [#5747](https://github.com/xtermjs/xterm.js/issues/5747) | Merged (7.0.0) | IME composition text overflows terminal boundaries |
| [#5762](https://github.com/xtermjs/xterm.js/issues/5762) | Merged (7.0.0) | `direction: rtl` broke IME composition rendering |
| [#5616](https://github.com/xtermjs/xterm.js/issues/5616) | Closed | IME composition overflow at right edge (superseded by #5747) |
| [#3251](https://github.com/xtermjs/xterm.js/pull/3251) | Merged | CSS `padding: 0` broke some IMEs; fix: `min-width: 1px` |

**Upgrade note**: xterm.js 7.0.0 includes two IME-related fixes (#5747, #5762). Monitor for release.

---

## Coffee-CLI Position & Recommendations

### Current Status

Coffee-CLI uses **xterm.js in Tauri (WebView2)** -- same architecture as Fluent Terminal, sharing the web-based IME approach and its inherent limitations.

### What We've Fixed

1. Removed `overflow: hidden` from `.xterm-helpers` (was clipping textarea position in 0x0 container)
2. Override `left: -9999em` to `left: 0` (prevents scroll-to-focus without blocking cursor tracking)
3. Added `min-width: 1px; min-height: 1px` (compatibility with QQ Pinyin, Rime, etc.)

### Multi-Monitor Limitation

The multi-monitor IME positioning bug is a **Chromium/WebView2 platform issue** shared by ALL web-based terminals (Tabby, Hyper, Wave, Fluent Terminal). Native terminals solve this via direct OS API calls (`convertRectToScreen:` on macOS, `ImmSetCompositionWindow` on Windows) that we cannot access from a WebView context.

### What We've Attempted (ime_bridge.rs)

Added a Tauri Rust plugin (`ime_bridge.rs`) that calls Win32 `ImmSetCompositionWindow` / `ImmSetCandidateWindow` directly, bypassing WebView2. However, **WebView2 internally also calls IMM32**, and the two conflict — WebView2's own IME handling overrides our positioning.

### Future Options

| Option | Effort | Impact |
|--------|--------|--------|
| Upgrade to xterm.js 7.0.0 when released | Low | Fixes composition overflow and RTL issues |
| Monitor Tauri/wry upstream for WebView2 coordinate fixes | None | May fix multi-monitor automatically |
| Replace xterm.js with native terminal engine (libghostty) | Very High | Perfect IME, but requires native rendering surface |
| Embed system terminal HWND as child window in Tauri | High | Perfect IME, native perf, but loses custom overlay UI |

### Architectural Conclusion

Web-based terminal rendering (xterm.js in WebView) has an inherent ceiling for IME quality. All competitors that achieve perfect IME use **native rendering**: GhosttyKit (Supaterm, cmux), Metal (Superconductor), native PTY (Windows Terminal, WezTerm). The only web-based terminals are Tabby/Hyper/Wave/Orca, and they ALL share the same IME limitations.

---

## Part 2: AI Agent Terminal Competitive Landscape

> Expanded from IME-focused analysis to cover the full competitive landscape of AI coding terminals.
>
> Added: 2026-04-16

### Market Segmentation

```
┌─────────────────────────────────────────────────────────────────┐
│                  AI Agent Terminal Market Map                     │
├──────────────┬──────────────────┬──────────────────────────────────┤
│  Native Desktop (Premium)      │  Web-Based Desktop              │
│  ┌────────────────────┐        │  ┌────────────────────┐         │
│  │ Conductor (YC $22M)│        │  │ Superset (9.6k ★)  │         │
│  │ cmux (14.3k ★)     │        │  │ Orca (1.1k ★)      │         │
│  │ Supaterm (73 ★)    │        │  │ Coffee-CLI          │         │
│  │ Superconductor     │        │  │ Tabby / Hyper / Wave│         │
│  └────────────────────┘        │  └────────────────────┘         │
│  Metal/GPU, perfect IME        │  xterm.js, IME limitations      │
├──────────────┬─────────────────┼──────────────────────────────────┤
│  Lightweight TUI               │  Cloud / Mobile                  │
│  ┌────────────────────┐        │  ┌────────────────────┐         │
│  │ claude-squad (7k ★)│        │  │ Superconductor.com │         │
│  │ Ralph TUI (2.2k ★) │        │  │ (Web + iOS)        │         │
│  │ Grove              │        │  └────────────────────┘         │
│  └────────────────────┘        │  Cloud execution, mobile-first  │
│  Zero deps, host terminal IME  │                                  │
└──────────────┴─────────────────┴──────────────────────────────────┘
```

---

### Native Desktop — AI Agent Terminals

#### Conductor

| | |
|---|---|
| **Company** | Melty Labs (YC S24, $22M Series A) |
| **Platform** | macOS only (Apple Silicon) |
| **Tech** | Native macOS app (closed source) |
| **Terminal** | Native PTY rendering |
| **IME** | Native macOS — perfect |
| **Stars** | N/A (closed source) |
| **License** | Proprietary (free during beta) |

**Key features**: Parallel agent orchestrator, Linear integration, diff commenting, GitHub sync. Agents run in isolated git worktrees.

**USP**: YC-backed with $22M funding, enterprise-grade Linear/GitHub integration.

#### cmux

| | |
|---|---|
| **Website** | https://github.com/manaflow-ai/cmux |
| **Platform** | macOS only (macOS 13+) |
| **Tech** | Swift/AppKit + **forked libghostty** (Metal GPU rendering) |
| **Terminal** | GhosttyKit xcframework (Zig-compiled, Metal) |
| **IME** | Native `NSTextInputClient` via Ghostty — perfect |
| **Stars** | 14,327 |
| **License** | GPL-3.0 + commercial |

**Architecture**: Maintains own Ghostty fork with 8 active patches (OSC 99 notifications, theme preview hooks, transparent compositing, kitty graphics APC). Uses `bonsplit` for split-pane/tab management. Reads native `~/.config/ghostty/config`.

**Performance claims**: Zero Electron overhead, Metal GPU rendering, careful typing-latency optimization (no allocations in `forceRefresh`, `Equatable` conformance to skip SwiftUI re-evaluation).

**"Zen of cmux"**: "A primitive, not a solution" — composable terminal + browser + notifications + socket API, no prescribed workflow.

**Key features**: Sidebar with vertical tabs, notification rings, in-app scriptable browser, SSH workspace routing, Claude Code Teams mode, socket/CLI API (`cmux notify`).

**vs Supaterm**: cmux has 14k stars vs Supaterm's 73. cmux maintains a Ghostty fork with patches; Supaterm uses stock GhosttyKit. cmux adds browser, SSH routing, CLI API.

#### Supaterm (Supacode)

| | |
|---|---|
| **Website** | https://github.com/supabitapp/supaterm |
| **Platform** | macOS only (macOS 26) |
| **Tech** | Swift/SwiftUI + TCA + stock GhosttyKit |
| **Terminal** | GhosttyKit xcframework (Metal GPU) |
| **IME** | Native `NSTextInputClient` via Ghostty — perfect |
| **Stars** | 73 |
| **License** | Elastic License 2.0 |

**Key features**: Claude Code hooks integration, agent status indicators per tab, `sp` CLI for programmatic terminal control, GitHub PR sidebar.

#### Superconductor (super.engineering)

| | |
|---|---|
| **Website** | https://super.engineering |
| **Platform** | macOS only |
| **Tech** | 100% Rust + Metal GPU rendering (closed source) |
| **Terminal** | Custom GPU-accelerated terminal — no xterm.js, no Electron |
| **IME** | Native macOS — perfect |
| **Stars** | N/A (closed source) |

**USP**: <50ms startup, pure Rust terminal, performance purist option.

---

### Web-Based Desktop — AI Agent Terminals

#### Superset

| | |
|---|---|
| **Website** | https://github.com/superset-sh/superset |
| **Platform** | macOS (Electron) |
| **Tech** | Electron + React + Vite + Bun + Turborepo monorepo |
| **Terminal** | **xterm.js** v6.1.0-beta.195 (WebGL + all addons) + node-pty |
| **IME** | Web-based (Chromium) — same multi-monitor limitation |
| **Stars** | 9,663 |
| **License** | Elastic License 2.0 |

**Architecture**: Turborepo monorepo with apps: desktop (Electron), admin (Next.js), API, marketing, docs. Uses **Mastra** AI agent framework for agent lifecycle/wrappers. CodeMirror 6 built-in editor. Headless xterm.js in main process for server-side terminal emulation.

**Key features**: Parallel multi-agent orchestration with git worktree isolation, agent-agnostic (Claude Code, Codex, Gemini CLI, Copilot), diff viewer + editor + terminal in one shell, workspace presets with setup/teardown scripts.

**USP**: The "IDE for agents" — not just a terminal but a full workspace manager with parallel agent monitoring.

#### Orca

| | |
|---|---|
| **Website** | https://github.com/stablyai/orca |
| **Platform** | macOS / Windows / Linux (Electron) |
| **Tech** | Electron + TypeScript (97.5%) |
| **Terminal** | xterm.js |
| **IME** | Web-based (Chromium) — same limitation |
| **Stars** | ~1,100 |
| **License** | — |

**USP**: Built-in browser with "Design Mode" — click any UI element to send it as AI context for frontend development.

#### Coffee-CLI (this project)

| | |
|---|---|
| **Website** | https://github.com/edison7009/Coffee-CLI |
| **Platform** | Windows / macOS / Linux (Tauri v2) |
| **Tech** | Rust + Tauri v2 + React + xterm.js |
| **Terminal** | xterm.js in WebView2 (Windows) / WebKit (macOS/Linux) |
| **IME** | Web-based + native bridge attempt (ime_bridge.rs) |
| **Stars** | — |
| **License** | MIT |

**Key differentiators vs competitors**:
- **Only cross-platform entry** in the AI terminal space (most competitors are macOS-only)
- Tauri (lightweight, ~10MB) vs Electron (~150MB)
- Hook-driven agent status indicator (3-state dot grid animation)
- Built-in file explorer, task board, session history, game arcade
- Per-instance translation engine for multi-tab independent dictionaries

---

### Lightweight TUI Tools

#### claude-squad

| | |
|---|---|
| **GitHub** | https://github.com/smtg-ai/claude-squad |
| **Tech** | Go (89%) + tmux + git worktrees |
| **Terminal** | TUI over tmux sessions |
| **IME** | Delegated to host terminal — perfect |
| **Stars** | ~7,000 |
| **License** | Open source |

**USP**: "tmux on steroids" — zero dependencies beyond tmux and git, yolo auto-accept mode.

#### Ralph TUI

| | |
|---|---|
| **GitHub** | https://github.com/subsy/ralph-tui |
| **Tech** | TypeScript (93%) + Bun + OpenTUI (React-to-terminal renderer) |
| **Terminal** | OpenTUI — React rendered to terminal |
| **IME** | Delegated to host terminal — perfect |
| **Stars** | ~2,200 |
| **License** | Open source |

**USP**: Autonomous task-loop orchestrator — feeds tasks from a backlog to agents one-by-one until done.

---

### Cloud / Mobile

#### Superconductor (superconductor.com)

| | |
|---|---|
| **Website** | https://superconductor.com |
| **Platform** | Web + iOS |
| **Tech** | Cloud-hosted agent execution |
| **IME** | Web/iOS native |

**USP**: Run agents from your phone — cloud execution with live preview, push notifications, mobile-first.

---

### Competitive Matrix

| Product | Stars | Platform | Terminal Engine | IME Quality | Cross-Platform | Key Differentiator |
|---------|-------|----------|----------------|-------------|----------------|-------------------|
| **cmux** | 14.3k | macOS | GhosttyKit (Metal) | Perfect | No | Ghostty fork, CLI API, browser |
| **Superset** | 9.6k | macOS | xterm.js (Electron) | Limited | No | Multi-agent orchestrator, built-in editor |
| **claude-squad** | 7k | All | tmux (TUI) | Perfect* | Yes | Zero deps, tmux multiplexer |
| **Ralph TUI** | 2.2k | All | OpenTUI (TUI) | Perfect* | Yes | Auto-loop task execution |
| **Orca** | 1.1k | All | xterm.js (Electron) | Limited | Yes | Browser Design Mode |
| **Conductor** | N/A | macOS | Native PTY | Perfect | No | YC $22M, Linear/GitHub integration |
| **Superconductor** | N/A | macOS | Rust Metal | Perfect | No | <50ms startup, pure Rust |
| **Supaterm** | 73 | macOS | GhosttyKit (Metal) | Perfect | No | Claude hooks, `sp` CLI |
| **Coffee-CLI** | — | **All** | xterm.js (Tauri) | **Limited** | **Yes** | **Only Tauri cross-platform entry** |

*TUI tools delegate IME to the host terminal, so IME quality depends on the user's terminal emulator.

### Key Takeaways

1. **The market is heavily macOS-biased**: Conductor, cmux, Supaterm, Superconductor, Superset are all macOS-only. Coffee-CLI's cross-platform support via Tauri is a genuine differentiator.

2. **Native rendering dominates the premium tier**: cmux (14k stars) and Conductor ($22M) both use native rendering. GhosttyKit is the emerging standard for embedded terminal engines.

3. **xterm.js-based tools share IME limitations**: Superset (9.6k stars), Orca, Coffee-CLI, Tabby, Hyper, Wave all have the same multi-monitor IME bug. None have solved it.

4. **TUI tools sidestep IME entirely**: claude-squad and Ralph TUI delegate to the host terminal. Simple, effective, but no custom UI.

5. **Coffee-CLI's unique position**: The only Tauri-based, cross-platform AI terminal with integrated UI (file explorer, task board, agent status). The IME limitation is shared with every other xterm.js-based competitor. The competitive threat is from native macOS tools — but they don't serve Windows/Linux users at all.
