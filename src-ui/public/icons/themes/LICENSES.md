# Icon Theme Attributions

Coffee CLI ships **8** distinct file-icon themes. Six are fetched verbatim
from upstream VS Code icon projects; two are self-authored Coffee CLI art.

## Fetched upstream (MIT licence)

| Theme          | Source                                                                       |
| -------------- | ---------------------------------------------------------------------------- |
| `material`     | material-extensions/vscode-material-icon-theme                               |
| `vscode-icons` | vscode-icons/vscode-icons                                                    |
| `catppuccin-mocha` | catppuccin/vscode-icons (Mocha palette) — line-stroke 16×16 icons       |
| `devicon`      | devicons/devicon (language glyphs) + jesseweed/seti-ui (folder, re-tinted)   |
| `fluent`       | microsoft/fluentui-system-icons (folder) + Material (language glyph pairing) |
| `symbols`      | miguelsolorio/vscode-symbols                                                 |

Two post-process tints apply:
- `devicon` folder: borrowed from Seti-UI (`#ABABAB` → Material blue-grey `#546E7A` for dark-UI contrast)
- `fluent` folder: Fluent's `#212121` → Fluent blue `#0078D4` for dark-UI contrast

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
