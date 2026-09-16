# Changelog

All notable changes to Coffee CLI are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
For releases prior to v1.5.5, see the
[GitHub Releases page](https://github.com/edison7009/Coffee-CLI/releases)
and `git tag --list "v*"`.

## [Unreleased]

### Fixed
- **会话记录不显示 Antigravity 会话。** 扫描器只认得已退役的 Gemini CLI
  布局 `~/.gemini/tmp/<project>/chats/`，而当前 agy 把会话写在
  `~/.gemini/antigravity-cli/brain/<uuid>/…/transcript_full.jsonl`，历史列表与
  贡献热力图因此漏掉全部 agy 会话。新增 brain 目录第二遍扫描：元数据索引用
  于补全标题/工作目录/时间，索引缺失的会话（print 模式、索引未刷新）回退到
  从首条 USER_INPUT 推导标题、从 last_conversations.json 解析目录；旧布局仍
  保留扫描。

## [3.2.9] — 2026-07-31

### Fixed
- **Duplicate completion chime after Claude Code context compaction.** `PreCompact`
  is now ignored for status mapping, so internal context maintenance no longer
  creates a fake `working → idle` transition and a second done sound.

## [3.2.8] — 2026-07-31

### Fixed
- **Notification sounds never played.** The `prevStatus` Map tracking each
  tab's last status was a function-local, recreated empty on every effect
  re-run (which fires on every `SET_AGENT_STATUS`), so transitions were
  never detected. Hoisted to module scope.
- **Removed the "only when window unfocused" sound toggle** — a footgun for
  single-window users, who would never hear a chime after enabling it.

## [3.2.7] — 2025-01-31

### Added
- **Grok Build promoted to T1.** Grok Build now has full dynamic island support 
  with live status updates. The hook infrastructure added in v3.2.6 is now 
  enabled (`has_hook_surface: true`), making Grok Build the 5th T1 tool 
  alongside Claude Code, OpenCode, mimocode, and Kimi Code.

### Fixed
- **Spurious notification sounds.** Fixed two issues where notification sounds 
  would play incorrectly:
  1. Closing a tab after conversation ended would trigger the "done" chime
  2. Auto-approved permissions would still play the "wait" chime
  
  Root cause: notification sounds used a separate event listener that duplicated 
  the dynamic island's status logic, causing false positives. Refactored to read 
  from the same Redux store the dynamic island uses, ensuring audio notifications 
  match visual status exactly. Single source of truth eliminates all false positives.

## [3.2.6] — 2025-01-30

### Added
- **Audible notifications when agents finish.** New sound settings (Settings ▸ 
  Sound) let you hear when an agent completes a turn or needs permission, so 
  you can work elsewhere without watching the terminal. Two distinct WebAudio-
  synthesized chimes (no assets, no permission prompts): a rising two-note for 
  task completion, and a double-beep for input prompts. Toggle independently; 
  "Current window mute" option (default OFF) silences notifications when you're 
  actively watching that tab. Supports all T1 tools via the agent-status event.
  
- **Grok Build dynamic island support.** Coffee CLI now tracks Grok Build 
  sessions in the status bar and plays completion sounds. Hooks auto-install 
  to `$GROK_HOME/hooks/` on first launch. Full event coverage: SessionStart, 
  UserPromptSubmit, PreToolUse, PostToolUse, Notification, Stop, StopFailure, 
  PreCompact, PostCompact.

### Changed
- **Sound notification defaults favor discoverability.** "Current window mute" 
  now defaults to OFF so single-window users hear the chime immediately and 
  discover the feature. Users who find it distracting can enable the toggle to 
  silence notifications when focused on the active tab.

### Fixed
- **Simplified Chinese/Traditional Chinese UI text.** Sound setting label 
  refined from "Only play when window unfocused or tab inactive" (16 chars) 
  to "Current window mute" (7 chars) for better readability.

## [2.8.6] — 2026-06-24

### Added
- **Codex-compatible plugin marketplaces.** Add any git repo that follows
  the Codex marketplace rule (a `.agents/plugins/marketplace.json` at the
  repo root) from Skills ▸ [Add marketplace]. Coffee CLI clones the repo,
  reads each plugin's name / description / icon, and renders it as a
  toggleable card. Enable a plugin and it appears in the composer's skill
  picker; attaching it hands the agent the plugin's on-disk path — Coffee
  CLI doesn't run or interpret what's behind that path (SKILL.md, MCP
  connector, whatever), it just points the agent at it. Works with the
  official `github.com/openai/plugins` market (~178 plugins) and any
  community mirror. Big markets render with a skeleton + lazy scroll, and
  icons load via the asset protocol so the list stays cheap. [Manage] opens
  the marketplace folder; delete a repo to remove its market.

### Changed
- **Skills attach as composer pills.** Skills and marketplace plugins now
  attach directly in the composer as inline pills instead of being mirrored
  into each CLI's skills dir via junctions/symlinks. The market tab strip is
  a single horizontally-scrolling row (the mouse wheel scrolls it sideways)
  so the header stays one line no matter how many markets you add.

### Security
- **Marketplace git URLs are validated.** Only https / http / git / ssh
  URLs are accepted; a pasted `ext::…` (which `git clone` would otherwise
  execute as a shell command) or a leading-`-` option is rejected, and `--`
  is passed before the URL as a second line of defense.

## [2.8.0] — 2026-06-19

### Fixed
- **macOS: `Cmd+C` now copies the terminal selection.** The default
  macOS app menu bound `Cmd+C` to the native `copy:` action, which fires
  before the terminal's own key handler and copies the DOM selection —
  but xterm paints its selection on a WebGL/canvas layer, so nothing
  reached the clipboard. The terminal now intercepts the `copy` event
  and writes its real selection, matching the copy behaviour Windows and
  Linux already had. Right-click ▸ Copy is unchanged. (#35)

## [2.7.9] — 2026-05-20

### Changed
- **Gemini CLI → Antigravity CLI**: Google retired Gemini CLI for
  consumers on 2026-05-19 (consumer access ends 2026-06-18) and asked
  users to move to Antigravity CLI. The Launchpad tile, history-board
  icon, tool-config defaults, multi-agent grid options, and Web-Home
  landing page now all surface Antigravity (binary `agy`). Resume uses
  `--conversation <uuid>` instead of Gemini's `--resume`. Tile icon is
  the official Lobe Icons Antigravity mark (4-colour ribbon under a
  mountain mask).
- **Skills** are junctioned into `~/.gemini/antigravity/skills/` — the
  same global dir the Antigravity IDE and 3rd-party `antigravity-
  awesome-skills` installer use. Existing Coffee CLI skill junctions
  at `~/.gemini/skills/` (the old Gemini CLI location) are left in
  place but no longer toggled by Coffee CLI; remove manually if you
  also uninstalled Gemini CLI.

### Kept (no data loss)
- **Sessions in `~/.gemini/tmp/*/chats/*.jsonl` all surface as
  Antigravity.** agy writes to the same dir using the same JSONL
  schema as the (retired) Gemini CLI — verified on populated
  sessions, no content-level marker distinguishes the two. Coffee
  CLI labels the whole directory under the Antigravity tile, with
  the Antigravity icon. Older Gemini-CLI sessions (if any) join the
  same list — since Gemini CLI as a separate product is retiring,
  a unified label is the cleaner UX. Heatmap counts include every
  session in that dir.
- The Gemini-specific MCP injection path (per-pane stub under
  `~/.gemini/extensions/coffee-pane-*` + GEMINI.md context file) is
  removed entirely. Antigravity uses a persistent `agy plugin install`
  model that doesn't map to the per-invocation extension trick, so
  Antigravity panes don't participate in Coffee Pane multi-agent
  dispatch yet — single-tab and Independent Split still work.

### Removed
- Gemini session-history scanner (`~/.gemini/tmp/<project>/chats/*.jsonl`
  parser and the projects.json reverse map). Enterprise users still on
  Gemini CLI through Code Assist can re-enable a custom command via
  `~/.coffee-cli/tools.json` if they want it back, but the built-in
  Gemini tile is gone.

## [2.4.0] — 2026-05-07

### Added
- **Explorer file diff badges**: each text file in the workspace tree
  now shows `+N -M` since the folder was opened, swapping in for the
  size badge. Pure snapshot+rehash on the Rust side — no git, no
  `.git/`, works in any folder regardless of whether the user has git
  installed. Multiset line-hash diff so a 5-add 3-delete edit reads as
  `+5 -3`, not the net `+2`. Self-clears when a change is undone.
- **Terminal scrollbar restored** with theme-aware coloring (binds to
  `--accent`). Wheel-only scrolling got tiring once agent transcripts
  reached thousands of lines. Slider auto-shrinks as scrollback grows.
- **Open** action in the Explorer right-click menu — hands the path
  to the OS default opener (`start` / `open` / `xdg-open`) so files
  launch in their configured app and folders launch in the OS file
  manager. We don't track defaults; the system owns the flow.

### Changed
- Linux bundle targets drop AppImage; `.deb` and `.rpm` only.

### Fixed
- **Multi-process IME drift**: launching Coffee CLI a second time used
  to spawn a duplicate WebView2 that fought the first for the OS IME
  context, parking the candidate popup at primary-monitor `(0,0)`.
  `tauri-plugin-single-instance` now forwards a duplicate launch to
  the running process and exits, leaving exactly one WebView2.
- **Selection background follows the active theme**: the highlight
  used to always read coffee regardless of the user's chosen scheme
  or app theme. Now derived from the per-theme accent (sakura → pink,
  cobalt → blue, etc.) and the optional terminal-color-scheme chip.
- **Link hover underline misalignment** when a URL was preceded by
  CJK characters on the same line — `range.x` is in terminal columns
  but we were passing JS string indices, so each wide char shifted
  the underline one column to the left.
- **Always hide xterm bar cursor** across every tool. The blinking
  caret read as cheap and was redundant with each AI agent's TUI
  caret and each shell's prompt + character echo.



Coffee CLI's first formal open-source release. The app's runtime is
unchanged from v1.5.5; this release adopts a full legal package and
formally claims seven brand marks against future rebranded clones.

### Added
- **AGPL-3.0-or-later** as the project's source-code license
  ([LICENSE](LICENSE), canonical FSF text).
- **NOTICE** — copyright, attribution for seven original designs
  (Gambit, Pitch, Coffee-CLI MCP, Sentinel Protocol, Multi-Agent
  Cross-Terminal Collaboration, VibeID, Vibetype), third-party asset
  attribution (line-md icon, Apache-2.0, by Vjacheslav Trushkin), and
  nominative fair-use notices for the AI tool brands Coffee CLI
  integrates with.
- **TRADEMARKS.md** — bilingual common-law trademark policy covering
  *Coffee CLI*, *Gambit*, *Pitch*, *VibeID*, *Vibetype*, *Coffee-CLI MCP*,
  and *Sentinel Protocol* (each with day-precision first-use dates
  verifiable against `git log`).
- **CONTRIBUTING.md** — bilingual contributor guide and CLA reserving
  future relicensing flexibility.
- **README.md** bilingual *License & Trademarks* section.

### Changed
- `Cargo.toml` license field: `MIT` → `AGPL-3.0-or-later`.
- `Web-Home/CC-VibeID-test/SKILL.md`: rename the archetype umbrella
  from "Claw family" (not original to this project) to **Vibetype**, a
  coined portmanteau of *vibe* + *archetype*. Pushed via the existing
  CDN-hosted skill-sync mechanism, so all installed clients pick up
  the new wording on next launch without a binary upgrade.

### Fixed
- `src-ui/src/components/center/CenterPanel.tsx`: the 16 persona codes
  used for first-install image pre-cache were stale v1 axis names
  (`PFVL`/`PSVL`/`TFVL`/`TSVL`); update them to current axes
  (`RDVL`/`RTVL`/`EDVL`/`ETVL` — mind × craft × arc × flow). All 16
  pre-fetches were silently 404'ing on first install; on-demand load
  via `matrix.json` masked the failure, but the pre-cache was
  effectively dead.

## [1.5.5] — 2026-04-27

### Added
- VibeID: unified `(1/2)` / `(2/2)` title and live executing status.

### Changed
- Stop tracking `CLAUDE.md` (AI-agent guardrails, not a contributor guide).
- Stop tracking internal docs and a dev-only batch script.

### Fixed
- Installer: clearer redeploy message and pause-on-exit during the
  release window (improves UX when CI is still building binaries).

[1.6.0]: https://github.com/edison7009/Coffee-CLI/releases/tag/v1.6.0
[1.5.5]: https://github.com/edison7009/Coffee-CLI/releases/tag/v1.5.5
