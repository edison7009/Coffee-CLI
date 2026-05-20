# Changelog

All notable changes to Coffee CLI are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
For releases prior to v1.5.5, see the
[GitHub Releases page](https://github.com/edison7009/Coffee-CLI/releases)
and `git tag --list "v*"`.

## [Unreleased]

### Changed
- **Gemini CLI → Antigravity CLI**: Google retired Gemini CLI for
  consumers on 2026-05-19 (consumer access ends 2026-06-18) and asked
  users to move to Antigravity CLI. The Launchpad tile, history-board
  icon, tool-config defaults, multi-agent grid options, and Web-Home
  landing page now all surface Antigravity (binary `agy`). Resume uses
  `--conversation <uuid>` instead of Gemini's `--resume`.
- **Skills** are junctioned into `~/.gemini/antigravity/skills/` — the
  same global dir the Antigravity IDE and 3rd-party `antigravity-
  awesome-skills` installer use. Existing Coffee CLI skill junctions
  at `~/.gemini/skills/` (the old Gemini CLI location) are left in
  place but no longer toggled by Coffee CLI; remove manually if you
  also uninstalled Gemini CLI.
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
