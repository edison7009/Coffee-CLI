# Coffee CLI Development Progress

## Project Vision
Coffee CLI is a terminal-first AI coding platform. Like kilo.ai wraps OpenCode, we wrap OpenCode as CoffeeCode — with our own branded terminal experience as the core differentiator.

## Business Model
Same as kilo.ai:
- Fork OpenCode, rebrand as CoffeeCode
- BYOK (Bring Your Own Key) for all major LLM providers
- Optional hosted gateway for zero-config experience
- Premium features on top of the open-source CLI

## Our Advantage
- Built-in terminal (Tauri + xterm.js) — better CLI experience than any web wrapper
- Sentence-level translation overlay — global user reach
- Dynamic Island for agent status — native-feel UX
- Coffee Overlay cursor system — CJK-aware

## Current Status (2026-04-06)

### Completed
- [x] OpenCode source forked to https://cnb.cool/Coffee-2026/Coffee-Code
- [x] Brand rename executed (opencode → coffee-code)
- [x] Upstream sync guide written (SYNC_GUIDE.md in repo)
- [x] Coffee CLI Tauri app — terminal, translation, Dynamic Island all working
- [x] CNB CI pipeline for Linux builds
- [x] CoffeeCode card + Coffee CLI brand icon in center panel
- [x] coffeecode translation dictionary (zh-CN)
- [x] CoffeeCode binary compiled via `bun build --compile`
- [x] Sidecar integration: binary auto-copied to output dir via build.rs
- [x] CoffeeCode launches successfully from Coffee CLI Launchpad
- [x] Multi-fallback launch: sidecar → PATH → bun dev → error message
- [x] i18n: Coffee Code display name (EN: "Coffee Code", ZH: "咖啡办公助手")
- [x] Theme-aware UI polish (brand name, guide cards use CSS variables)

### CNB CI Pipeline (cnb.cool/Coffee-2026/Coffee-Code)
- [x] Fork OpenCode to CNB
- [x] Configure .cnb.yml CI pipeline
- [x] Fix CI permissions (Fork auto-trigger)
- [x] Fix build deps (python3, make, g++, git)
- [x] Set OPENCODE_CHANNEL env to skip git branch detection
- [x] First successful CI build ✅
- [ ] Cross-compile for 3 platforms (Linux/macOS/Windows)
- [ ] Publish releases with version tags
- [ ] Execute brand-patch.sh in CI pipeline

### Next Steps (Priority Order)
1. [ ] CI: cross-platform builds (add --target for darwin/windows)
2. [ ] CI: auto-publish releases on tag push
3. [ ] Coffee CLI: build.rs auto-download binary from CNB releases
4. [ ] Clean up .opencode-upstream from main repo
5. [ ] API key configuration flow (GUI → coffee-code config)
6. [ ] Landing page / docs site

## Naming Convention

| Context           | Value                              |
|-------------------|------------------------------------|
| Repository        | cnb.cool/Coffee-2026/coffee-code   |
| Binary name       | coffee-code                        |
| Display (EN)      | Coffee Code                        |
| Display (ZH)      | 咖啡办公助手                         |
| Internal ToolType | coffeecode                         |
| Config directory  | .coffee-code                       |

## Architecture

```
Coffee CLI (Tauri Desktop App) — THE UI SHELL
  ├── Terminal (xterm.js + PTY)
  │   └── coffee-code TUI runs inside xterm.js (same as Kilo strategy)
  ├── Translation Overlay (CoffeeOverlay, covers TUI text)
  ├── Theme (xterm.js background color, no file IPC)
  ├── Dynamic Island (PTY regex status detection)
  └── Right Panel (remote control menus)

Coffee Code (OpenCode Fork) — THE AI BRAIN
  ├── TUI mode (default) — interactive coding sessions
  ├── CLI mode (run command) — scripting/CI automation
  ├── 30+ LLM Providers (Anthropic, OpenAI, Gemini, OpenRouter...)
  ├── MCP Support
  └── Tools (bash, file edit, search, LSP, git...)
```

## Kilo Fork OpenCode Workflow

Reference: Kilo-Org/kilocode (https://github.com/Kilo-Org/kilocode)

### Fork Setup (One-Time)
1. Fork anomalyco/opencode on CNB
2. `git remote add upstream https://github.com/anomalyco/opencode.git`
3. `bash script/brand-patch.sh`

### Upstream Sync (Periodic)
```
git fetch upstream
git merge upstream/main --no-edit
bash script/brand-patch.sh
# Resolve conflicts, commit, push
```

### Brand Patch (script/brand-patch.sh)
1. package.json name → coffee-code
2. CLI binary entry → coffee-code
3. Config directory → .coffee-code
4. ASCII logo → Coffee Code branded art
5. Telemetry → disabled

### CI/CD Build Targets
- coffee-code-windows-x64.zip
- coffee-code-darwin-arm64.zip
- coffee-code-darwin-x64.zip
- coffee-code-linux-x64.tar.gz
- coffee-code-linux-arm64.tar.gz

### Integration with Coffee CLI
- Release: sidecar binary bundled next to Tauri executable
- Debug: developer installs coffee-code globally via PATH
- Theme: xterm.js handles background (no file IPC needed)
- Translation: CoffeeOverlay covers CLI text (same as Claude Code)
- Status: PTY regex detects agent states (same as Claude Code)

## Key Repos
| Repo | Purpose |
|---|---|
| https://cnb.cool/Coffee-2026/Coffee-Code | Coffee Code (OpenCode fork) |
| d:\Coffee CLI (local) | Coffee CLI Tauri app |

