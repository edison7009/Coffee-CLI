# Coffee CLI Language Packs

Language packs translate AI CLI tools (Claude Code, Codex, etc.) into the
user's native language by **patching the tool's source files at install time**,
not at runtime. This gives perfect cursor accuracy, IME support, and box
drawing — everything the embedded tool computes uses the translated strings
natively.

**The Coffee CLI main program contains zero translation code.** Language packs
are independent installable add-ons distributed via Coffee CLI's one-click
installer, downloaded fresh from this directory on demand.

---

## Layout

```
language-packs/
├── README.md                       ← this file
└── zh-CN/                          ← simplified Chinese (currently the only complete pack)
    ├── install.sh                  ← Linux/macOS installer (one-shot script)
    ├── install.ps1                 ← Windows installer
    ├── uninstall.sh
    ├── uninstall.ps1
    ├── patch-cli.js                ← string-literal patcher (vendored from taekchef)
    ├── cli-translations.json       ← 1463 English→Chinese pairs
    ├── verbs/
    │   └── zh-CN.json              ← 187 spinner verbs
    ├── tips/
    │   ├── en.json                 ← English source for translator reference
    │   └── zh-CN.json              ← 41 input-box tips translated
    └── LICENSE.taekchef            ← MIT license for vendored upstream files
```

---

## How a language pack runs

A user clicks "简体中文" in the Coffee Installer menu. The menu item's command
is one line:

```sh
curl -fsSL https://raw.githubusercontent.com/edison7009/Coffee-CLI/main/language-packs/zh-CN/install.sh | sh
```

The script then:

1. Detects the user's npm-installed Claude Code path
2. Reads its version from `package.json`
3. Backs up the pristine `cli.js` to `~/.coffee-cli/backups/cli-<version>.js`
   (only if no backup exists for that version)
4. Restores from backup (so re-install is idempotent — every install starts
   from pristine English)
5. Downloads `patch-cli.js` and `cli-translations.json` to a temp dir
6. Runs `node patch-cli.js cli.js cli-translations.json`, which scans the
   minified JS for double-quoted string literals and replaces them
7. Writes `~/.coffee-cli/active-language` with the language code so other
   tools know which pack is active

Uninstall is the reverse: copy backup → cli.js, delete the active-language
marker.

---

## Why this directory and not a separate repo

We considered hosting language packs in a separate `Coffee-CLI-language-packs`
repo for "true decoupling," but ultimately keep them here because:

- Single repo = single PR / issue / release flow for a one-person project
- Raw GitHub URLs work immediately, no separate repo creation
- Main program build does **not** consume this directory — it's only ever
  fetched at user install time via curl/iwr
- The directory adds ~200 KB per language; even with 8+ languages it stays
  under 2 MB, negligible for the repo

The main program is still architecturally pure: there is no `import` from
this directory anywhere in `src/` or `src-ui/src/`.

---

## Adding a new language pack

Each language is independent. To add `ja-JP` (Japanese) for example:

1. Create directory: `language-packs/ja-JP/`
2. Generate translation data (1463 cli-translations entries + 150–200 verbs +
   41 tips). See `D:\Translator-Task\README.md` for the translator brief.
3. Vendor `patch-cli.js` from this directory (or from taekchef upstream)
4. Copy `install.sh`, `install.ps1`, `uninstall.sh`, `uninstall.ps1` from
   `zh-CN/` and update `LANG_CODE`, `LANG_LABEL`, `REPO_URL` constants
5. Add menu items to `scripts/agent-tools-installer.ps1` and `.sh`:
   ```
   "Install 日本語"  → install.sh URL
   "Uninstall 日本語" → uninstall.sh URL
   ```
6. Test on a real Claude Code install: install → use → uninstall → use again

The patcher hardcodes `{en, zh}` field names (taekchef's choice). For other
languages you must either:
- Use `zh` as the JSON field name regardless of target language (simplest), or
- Fork `patch-cli.js` and parameterize the field name (more correct)

The `zh-CN` pack uses option (a) by accident of inheriting taekchef's format.
Future packs should match — no behavioral difference, the field name is
internal.

---

## Upgrade strategy: when Claude Code releases a new version

When Anthropic publishes a new `@anthropic-ai/claude-code` to npm:

1. The patcher's `patch-cli.js` may still work without modification, because
   it operates on string literals, not specific code paths. ~90% of patches
   survive minor releases.
2. If a major refactor breaks specific patches, taekchef's upstream repo
   typically updates within 1–2 days; we re-vendor `patch-cli.js` from there.
3. The user's existing backup (`cli-<old-version>.js`) becomes stale. The
   install script detects this: if no backup matches the current `cli.js`
   version, it makes a fresh backup before patching.

There is no automated CI for tracking Claude Code releases yet. Manual check
when users report breakage.

---

## Vendored upstream attribution

The `zh-CN/` pack vendors files from
[taekchef/claude-code-zh-cn](https://github.com/taekchef/claude-code-zh-cn)
(MIT licensed). Specifically:

- `patch-cli.js` — the literal-scanning patcher
- `cli-translations.json` — 1463 string pairs
- `verbs/zh-CN.json`, `tips/zh-CN.json` — spinner verbs and tips

The upstream `LICENSE` is preserved as `LICENSE.taekchef` in the same
directory. Any redistribution must include it.

To pull upstream updates:

```sh
cd language-packs/zh-CN
curl -fsSL -o patch-cli.js          https://raw.githubusercontent.com/taekchef/claude-code-zh-cn/main/patch-cli.js
curl -fsSL -o cli-translations.json https://raw.githubusercontent.com/taekchef/claude-code-zh-cn/main/cli-translations.json
curl -fsSL -o verbs/zh-CN.json      https://raw.githubusercontent.com/taekchef/claude-code-zh-cn/main/verbs/zh-CN.json
curl -fsSL -o tips/en.json          https://raw.githubusercontent.com/taekchef/claude-code-zh-cn/main/tips/en.json
curl -fsSL -o tips/zh-CN.json       https://raw.githubusercontent.com/taekchef/claude-code-zh-cn/main/tips/zh-CN.json
curl -fsSL -o LICENSE.taekchef      https://raw.githubusercontent.com/taekchef/claude-code-zh-cn/main/LICENSE
```
