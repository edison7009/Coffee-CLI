# Changelog

All notable changes to Coffee CLI are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
For releases prior to v1.5.5, see the
[GitHub Releases page](https://github.com/edison7009/Coffee-CLI/releases)
and `git tag --list "v*"`.

## [1.6.0] — 2026-04-27

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
