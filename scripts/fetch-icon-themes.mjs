// Downloads authentic SVGs from 6 upstream VS Code icon themes and writes
// them into src-ui/public/icons/themes/<theme>/.
//
// Each theme's folder shape + file icons come from the SAME upstream — no
// cross-theme shape borrowing, no palette-swap tricks. The two exceptions
// (devicon has no folders upstream → borrows Seti shape tinted dark; fluent
// has no language icons → borrows Material language glyphs) are documented
// inline so it's obvious where visual overlap might occur.
//
// Covered themes: material, vscode-icons, catppuccin-mocha, devicon, fluent, symbols.
// outline + coffee live in generate-icon-themes.mjs (self-authored art).
// SETI_BASE is kept as an upstream URL constant because devicon borrows the
// Seti folder shape — seti is not a standalone theme here.

import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = join(__dirname, '..', 'src-ui', 'public', 'icons', 'themes');

// ─── Source definitions ─────────────────────────────────────────────────────
// Each theme lists its 19 slots → upstream URL.
// `postProcess[slot]` is an optional (svg: string) => string transformer,
// used to re-tint folders whose upstream fill clashes with our dark chrome.

const MATERIAL_BASE = 'https://raw.githubusercontent.com/material-extensions/vscode-material-icon-theme/main/icons/';
const VSCODE_ICONS_BASE = 'https://raw.githubusercontent.com/vscode-icons/vscode-icons/master/icons/';
const SETI_BASE = 'https://raw.githubusercontent.com/jesseweed/seti-ui/master/icons/';
const DEVICON_BASE = 'https://raw.githubusercontent.com/devicons/devicon/master/icons/';
const FLUENT_BASE = 'https://raw.githubusercontent.com/microsoft/fluentui-system-icons/main/assets/';
const SYMBOLS_BASE = 'https://raw.githubusercontent.com/miguelsolorio/vscode-symbols/main/src/icons/';
const CATPPUCCIN_MOCHA_BASE = 'https://raw.githubusercontent.com/catppuccin/vscode-icons/main/icons/mocha/';

const replaceFill = (from, to) => (svg) => svg.replaceAll(from, to);

const SOURCES = {
  // 1. Material Icon Theme — signature: brown trapezoid folder with fold-tab.
  material: {
    map: {
      'folder-closed.svg': 'folder-base.svg',
      'folder-open.svg':   'folder-base-open.svg',
      'file.svg':          'document.svg',
      'js.svg':            'javascript.svg',
      'ts.svg':            'typescript.svg',
      'jsx.svg':           'react.svg',
      'tsx.svg':           'react_ts.svg',
      'py.svg':            'python.svg',
      'rs.svg':            'rust.svg',
      'go.svg':            'go.svg',
      'java.svg':          'java.svg',
      'c.svg':             'c.svg',
      'cpp.svg':           'cpp.svg',
      'html.svg':          'html.svg',
      'css.svg':           'css.svg',
      'json.svg':          'json.svg',
      'md.svg':            'markdown.svg',
      'sh.svg':            'console.svg',
      'toml.svg':          'toml.svg',
    },
    base: MATERIAL_BASE,
  },

  // 2. vscode-icons — signature: golden-brown sandwich folder, 3D language chips.
  'vscode-icons': {
    map: {
      'folder-closed.svg': 'default_folder.svg',
      'folder-open.svg':   'default_folder_opened.svg',
      'file.svg':          'default_file.svg',
      'js.svg':            'file_type_js.svg',
      'ts.svg':            'file_type_typescript.svg',
      'jsx.svg':           'file_type_reactjs.svg',
      'tsx.svg':           'file_type_reactts.svg',
      'py.svg':            'file_type_python.svg',
      'rs.svg':            'file_type_rust.svg',
      'go.svg':            'file_type_go.svg',
      'java.svg':          'file_type_java.svg',
      'c.svg':             'file_type_c.svg',
      'cpp.svg':           'file_type_cpp.svg',
      'html.svg':          'file_type_html.svg',
      'css.svg':           'file_type_css.svg',
      'json.svg':          'file_type_json.svg',
      'md.svg':            'file_type_markdown.svg',
      'sh.svg':            'file_type_shell.svg',
      'toml.svg':          'file_type_toml.svg',
    },
    base: VSCODE_ICONS_BASE,
  },

  // 3. Catppuccin Mocha — hand-drawn line-stroke icons in Catppuccin palette.
  // viewBox 16×16 with rounded stroke terminals; colour is Catppuccin text /
  // language hues on a transparent background. Renders beautifully on dark UI.
  'catppuccin-mocha': {
    map: {
      'folder-closed.svg': '_folder.svg',
      'folder-open.svg':   '_folder_open.svg',
      'file.svg':          '_file.svg',
      'js.svg':            'javascript.svg',
      'ts.svg':            'typescript.svg',
      'jsx.svg':           'javascript.svg',    // no dedicated jsx — reuse js
      'tsx.svg':           'typescript.svg',    // no dedicated tsx — reuse ts
      'py.svg':            'python.svg',
      'rs.svg':            'rust.svg',
      'go.svg':            'go.svg',
      'java.svg':          'java.svg',
      'c.svg':             'c.svg',
      'cpp.svg':           'cpp.svg',
      'html.svg':          'html.svg',
      'css.svg':           'css.svg',
      'json.svg':          'json.svg',
      'md.svg':            'markdown.svg',
      'sh.svg':            'bash.svg',
      'toml.svg':          'toml.svg',
    },
    base: CATPPUCCIN_MOCHA_BASE,
  },

  // 4. Devicon — no folder upstream; borrow Seti's notched shape tinted dark
  // blue-grey to stand apart from Seti's pale grey. Files = real brand logos.
  devicon: {
    entries: {
      'folder-closed.svg': SETI_BASE + 'folder.svg',
      'folder-open.svg':   SETI_BASE + 'folder.svg',
      'file.svg':          MATERIAL_BASE + 'document.svg',
      'js.svg':   DEVICON_BASE + 'javascript/javascript-original.svg',
      'ts.svg':   DEVICON_BASE + 'typescript/typescript-original.svg',
      'jsx.svg':  DEVICON_BASE + 'react/react-original.svg',
      'tsx.svg':  DEVICON_BASE + 'react/react-original.svg',
      'py.svg':   DEVICON_BASE + 'python/python-original.svg',
      'rs.svg':   DEVICON_BASE + 'rust/rust-original.svg',
      'go.svg':   DEVICON_BASE + 'go/go-original.svg',
      'java.svg': DEVICON_BASE + 'java/java-original.svg',
      'c.svg':    DEVICON_BASE + 'c/c-original.svg',
      'cpp.svg':  DEVICON_BASE + 'cplusplus/cplusplus-original.svg',
      'html.svg': DEVICON_BASE + 'html5/html5-original.svg',
      'css.svg':  DEVICON_BASE + 'css3/css3-original.svg',
      'json.svg': DEVICON_BASE + 'json/json-original.svg',
      'md.svg':   DEVICON_BASE + 'markdown/markdown-original.svg',
      'sh.svg':   DEVICON_BASE + 'bash/bash-original.svg',
      'toml.svg': MATERIAL_BASE + 'toml.svg',
    },
    postProcess: {
      // Re-tint Seti's pale #ABABAB to Material-style blue-grey for dark UI.
      'folder-closed.svg': replaceFill('#ABABAB', '#546E7A'),
      'folder-open.svg':   replaceFill('#ABABAB', '#546E7A'),
    },
  },

  // 5. Fluent — Microsoft Fluent rounded folder + Material language pairing
  // (Fluent ships no language glyphs upstream). Folder re-tinted from the
  // near-black #212121 to Fluent blue #0078D4 so it's visible on dark chrome.
  fluent: {
    entries: {
      'folder-closed.svg': FLUENT_BASE + 'Folder/SVG/ic_fluent_folder_24_filled.svg',
      'folder-open.svg':   FLUENT_BASE + 'Folder%20Open/SVG/ic_fluent_folder_open_24_filled.svg',
      'file.svg':          FLUENT_BASE + 'Document/SVG/ic_fluent_document_24_filled.svg',
      'js.svg':   MATERIAL_BASE + 'javascript.svg',
      'ts.svg':   MATERIAL_BASE + 'typescript.svg',
      'jsx.svg':  MATERIAL_BASE + 'react.svg',
      'tsx.svg':  MATERIAL_BASE + 'react_ts.svg',
      'py.svg':   MATERIAL_BASE + 'python.svg',
      'rs.svg':   MATERIAL_BASE + 'rust.svg',
      'go.svg':   MATERIAL_BASE + 'go.svg',
      'java.svg': MATERIAL_BASE + 'java.svg',
      'c.svg':    MATERIAL_BASE + 'c.svg',
      'cpp.svg':  MATERIAL_BASE + 'cpp.svg',
      'html.svg': MATERIAL_BASE + 'html.svg',
      'css.svg':  MATERIAL_BASE + 'css.svg',
      'json.svg': MATERIAL_BASE + 'json.svg',
      'md.svg':   MATERIAL_BASE + 'markdown.svg',
      'sh.svg':   MATERIAL_BASE + 'console.svg',
      'toml.svg': MATERIAL_BASE + 'toml.svg',
    },
    postProcess: {
      'folder-closed.svg': replaceFill('#212121', '#0078D4'),
      'folder-open.svg':   replaceFill('#212121', '#0078D4'),
      'file.svg':          replaceFill('#212121', '#0078D4'),
    },
  },

  // 6. Symbols (miguelsolorio) — minimalist coloured-brackets language icons.
  // Symbols maps many extensions onto generic `code-<colour>` glyphs by design
  // (no per-language brand). We follow the same convention here, picking a
  // colour per ext that matches the language's iconic hue.
  symbols: {
    map: {
      'folder-closed.svg': 'folders/folder.svg',
      'folder-open.svg':   'folders/folder-open.svg',
      'file.svg':          'files/document.svg',
      'js.svg':            'files/code-yellow.svg',
      'ts.svg':            'files/code-blue.svg',
      'jsx.svg':           'files/code-sky.svg',
      'tsx.svg':           'files/code-blue.svg',
      'py.svg':            'files/python.svg',
      'rs.svg':            'files/rust.svg',
      'go.svg':            'files/go.svg',
      'java.svg':          'files/code-orange.svg',
      'c.svg':             'files/c.svg',
      'cpp.svg':           'files/cplus.svg',
      'html.svg':          'files/code-orange.svg',
      'css.svg':           'files/code-sky.svg',
      'json.svg':          'files/code-gray.svg',
      'md.svg':            'files/markdown.svg',
      'sh.svg':            'files/shell.svg',
      'toml.svg':          'files/code-red.svg',
    },
    base: SYMBOLS_BASE,
  },
};

// ─── Fetch + write ──────────────────────────────────────────────────────────

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

async function writeTheme(name, config) {
  const dir = join(OUT_ROOT, name);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const urls = config.entries
    ? config.entries
    : Object.fromEntries(Object.entries(config.map).map(([k, v]) => [k, config.base + v]));

  const post = config.postProcess || {};
  const entries = Object.entries(urls);
  let ok = 0, fail = 0;

  for (const [slot, url] of entries) {
    try {
      let svg = await fetchText(url);
      if (post[slot]) svg = post[slot](svg);
      writeFileSync(join(dir, slot), svg);
      ok++;
    } catch (err) {
      console.warn(`  ✗ ${slot} ← ${url}\n    ${err.message}`);
      fail++;
    }
  }
  console.log(`[${name}] ${ok} ok / ${fail} fail`);
}

(async () => {
  for (const [name, config] of Object.entries(SOURCES)) {
    await writeTheme(name, config);
  }
  console.log('\nDone. Run generate-icon-themes.mjs next for self-authored themes (coffee).');
})();
