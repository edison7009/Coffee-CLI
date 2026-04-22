// Self-authored icon themes. Everything upstream-sourced lives in
// fetch-icon-themes.mjs. This script renders:
//   - coffee  : Coffee CLI brand theme. Coffee-cup silhouette folder with
//               steam lines; file tiles are dark espresso tile + brand
//               letter stamp in each language's canonical hue.
//
// outline was previously generated from a larger legacy script; its 19 SVGs
// are checked into src-ui/public/icons/themes/outline/ and not regenerated
// here. If you ever need to rebuild outline, check the project history.

import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = join(__dirname, '..', 'src-ui', 'public', 'icons', 'themes');

// ─── Language metadata ──────────────────────────────────────────────────────
// Each extension → { text: letter stamp, brand: canonical hue }
const FILE_META = {
  js:   { text: 'JS',   brand: '#F7DF1E' },
  ts:   { text: 'TS',   brand: '#3178C6' },
  tsx:  { text: 'TSX',  brand: '#3178C6' },
  jsx:  { text: 'JSX',  brand: '#61DAFB' },
  py:   { text: 'PY',   brand: '#FFD43B' },
  rs:   { text: 'RS',   brand: '#CE422B' },
  go:   { text: 'GO',   brand: '#00ADD8' },
  java: { text: 'JV',   brand: '#F89820' },
  c:    { text: 'C',    brand: '#5C8DBC' },
  cpp:  { text: 'C++',  brand: '#00599C' },
  html: { text: 'H',    brand: '#E34F26' },
  css:  { text: 'CSS',  brand: '#264DE4' },
  json: { text: '{}',   brand: '#CFA84E' },
  md:   { text: 'MD',   brand: '#E5B88A' },
  sh:   { text: 'SH',   brand: '#4EAA25' },
  toml: { text: 'TML',  brand: '#E0A458' },
};

// ─── Coffee brand palette ───────────────────────────────────────────────────
// Flat design: no gradients, no highlights, no inner shadows. Each element
// is a single solid fill so every tile reads cleanly at 34px thumbnail size.
const COFFEE = {
  bean:     '#C4956A', // brand gold — folder body, steam strokes
  espresso: '#3A2618', // deep brown — liquid surface accent (only in open cup)
  tileBg:   '#1C1612', // file tile background (near-black espresso)
};

// ─── Renderers ──────────────────────────────────────────────────────────────

// Coffee cup viewed from the side, 3 wavy steam lines above. All solid fills.
const coffeeFolderClosed = () => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <g fill="none" stroke="${COFFEE.bean}" stroke-width="1.6" stroke-linecap="round">
    <path d="M9 3c1 1 -1 1.8 0 3"/>
    <path d="M14 3c1 1 -1 1.8 0 3"/>
    <path d="M19 3c1 1 -1 1.8 0 3"/>
  </g>
  <rect x="3" y="9" width="19" height="18" rx="3" fill="${COFFEE.bean}"/>
  <path d="M22 13h3.5a3 3 0 0 1 0 6H22z" fill="${COFFEE.bean}"/>
</svg>
`;

// Open cup: same silhouette but a single dark ellipse marks the liquid surface.
const coffeeFolderOpen = () => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <g fill="none" stroke="${COFFEE.bean}" stroke-width="1.6" stroke-linecap="round">
    <path d="M9 2c1.4 1.2 -1.4 2.2 0 3.4"/>
    <path d="M14 2c1.4 1.2 -1.4 2.2 0 3.4"/>
    <path d="M19 2c1.4 1.2 -1.4 2.2 0 3.4"/>
  </g>
  <rect x="3" y="8" width="19" height="19" rx="3" fill="${COFFEE.bean}"/>
  <path d="M22 12h3.5a3 3 0 0 1 0 6H22z" fill="${COFFEE.bean}"/>
  <ellipse cx="12.5" cy="11" rx="8" ry="1.8" fill="${COFFEE.espresso}"/>
</svg>
`;

// Default file: solid espresso-bean silhouette with a single hairline crease.
const coffeeFile = () => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect fill="${COFFEE.tileBg}" width="32" height="32" rx="5"/>
  <ellipse cx="16" cy="16" rx="7" ry="10" fill="${COFFEE.bean}" transform="rotate(-20 16 16)"/>
  <path d="M13 9c-2 2 -3 5 -1 14" stroke="${COFFEE.espresso}" stroke-width="1.4" fill="none" stroke-linecap="round"/>
</svg>
`;

// Language tile: pure dark background + large bold letters in the brand hue.
// No accent bars, no highlights — letters must stay legible at 34px chip size.
const coffeeLangTile = (letters, brand) => {
  const n = letters.length;
  const fs = n >= 3 ? 13 : n === 2 ? 16 : 20;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect fill="${COFFEE.tileBg}" width="32" height="32" rx="5"/>
  <text x="16" y="16" text-anchor="middle" dominant-baseline="central"
        font-family="system-ui,-apple-system,sans-serif" font-size="${fs}" font-weight="900"
        fill="${brand}">${letters}</text>
</svg>
`;
};

// ─── Emit ───────────────────────────────────────────────────────────────────

function writeCoffee() {
  const dir = join(OUT_ROOT, 'coffee');
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  writeFileSync(join(dir, 'folder-closed.svg'), coffeeFolderClosed());
  writeFileSync(join(dir, 'folder-open.svg'),   coffeeFolderOpen());
  writeFileSync(join(dir, 'file.svg'),          coffeeFile());

  for (const [ext, meta] of Object.entries(FILE_META)) {
    writeFileSync(join(dir, `${ext}.svg`), coffeeLangTile(meta.text, meta.brand));
  }

  console.log(`[coffee] 19 slots rendered → ${dir}`);
}

writeCoffee();
console.log('\nDone. outline/ is managed by project history (not regenerated).');
