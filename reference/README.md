# Reference

Read-only reference repos. **Not bundled into the binary, not committed to git.**

Used to inspect upstream code when porting skills, debugging behavior, or
designing features that mirror another project's mechanism. The `.gitignore`
keeps everything in this directory out of git except this README.

## Suggested layout

```
reference/
├── openai-skills/      # github.com/openai/skills — source for skills we
│                       # vendored into ../skills/ (currently: screenshot).
│                       # Coffee CLI's `screenshot` skill is now ours; this
│                       # clone exists only as a reference for upstream
│                       # changes / future ports.
├── warp/               # github.com/warpdotdev/warp — Rust source of the
│                       # Warp terminal. Keep around for renderer / TUI
│                       # comparisons (e.g. how Warp handles transparent
│                       # cell backgrounds, see commit 51989f9 on the
│                       # Glass-mode patch).
```

## Cloning

```sh
git clone https://github.com/openai/skills.git reference/openai-skills
git clone https://github.com/warpdotdev/warp.git    reference/warp
```

Pull updates:

```sh
git -C reference/openai-skills pull
git -C reference/warp          pull
```

## Why not submodules / committed?

- We don't ship them, so adding them to the binary as `vendor/` did wastes
  download size and CI time.
- Submodules add lifecycle ceremony (`git submodule update --init`) and
  pin a specific commit; reference repos are meant to be browsed at HEAD
  whenever curiosity strikes, not pinned.
- Keeping them out of git keeps `git log` / `git status` / blame focused
  on Coffee CLI's own code.

If you need to *port* a piece (like the screenshot skill move on
2026-05-10), copy the relevant subtree into the appropriate Coffee CLI
location (`skills/`, `src/`, etc.) and treat it as Coffee CLI code from
that point on. Don't symlink or include from `reference/` — the build
must be self-contained.
