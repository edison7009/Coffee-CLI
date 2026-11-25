# Icon Theme Attributions

Coffee CLI ships **8** distinct file-icon themes. Six are fetched verbatim
from upstream VS Code icon projects; two are self-authored Coffee CLI art.

## Fetched upstream (MIT licence)

| Theme          | Source                                                                       |
| -------------- | ---------------------------------------------------------------------------- |
| `material`     | material-extensions/vscode-material-icon-theme                               |
| `vscode-icons` | vscode-icons/vscode-icons                                                    |
| `catppuccin-mocha` | catppuccin/vscode-icons (Mocha palette) — line-stroke 16×16 icons       |
| `devicon`      | phosphor-icons/core — Phosphor `light` variant (pure line, `currentColor`)   |
| `fluent`       | microsoft/fluentui-system-icons (folder) + Material (language glyph pairing) |
| `symbols`      | miguelsolorio/vscode-symbols                                                 |

Notes:
- `devicon` slot retains the theme id for localStorage compatibility but now
  ships Phosphor Icons light variants. All SVGs use `fill="currentColor"` and
  are rendered via CSS `mask-image`, so the silhouette tracks the active
  color theme's `--accent` variable. See `MASK_TINT_THEMES` in `Explorer.tsx`.
- `fluent` folder post-process: Fluent's `#212121` → Fluent blue `#0078D4` for
  dark-UI contrast.

See `scripts/fetch-icon-themes.mjs` for the complete URL map.

## Self-authored (no third-party assets)

| Theme     | Style                                                      |
| --------- | ---------------------------------------------------------- |
| `outline` | Minimalist line-frame with coloured letter stamps          |
| `coffee`  | Coffee CLI brand — coffee-cup folder silhouette with steam lines; espresso-tile file stamps in each language's canonical brand hue |

See `scripts/generate-icon-themes.mjs` for the coffee renderer.

## Attribution basis

All upstream projects above are MIT-licensed, which permits re-distribution
with attribution. This file is that attribution.
