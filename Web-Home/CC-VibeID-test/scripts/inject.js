#!/usr/bin/env node
/**
 * VibeID injector — inserts a persona card at the top of the Claude Code
 * /insights report.html, just after <h1>Claude Code Insights</h1>.
 *
 * Idempotent: if a vibeid:v1 block already exists, replaces it.
 * Backup: writes report.html.bak before first modification.
 *
 * Usage: node inject.js <report.html> <persona.json>
 * Persona JSON shape:
 *   { code, name, family, profession, tagline, copy, image_url,
 *     palette: { bg, costume, accent } }
 */

'use strict';

const fs = require('fs');

function die(msg, code = 1) {
  process.stderr.write(`inject.js: ${msg}\n`);
  process.exit(code);
}

const htmlPath = process.argv[2];
const personaJsonPathOrInline = process.argv[3];

if (!htmlPath) {
  die('usage: inject.js <report.html> [<persona.json>]   (persona JSON also accepted on stdin)', 2);
}
if (!fs.existsSync(htmlPath)) die(`html not found: ${htmlPath}`, 2);

const html = fs.readFileSync(htmlPath, 'utf8');

function readStdinSync() {
  try {
    // fd 0 is stdin; readFileSync blocks until EOF
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

// Persona JSON source (priority order):
//   1. argv[3] as an existing file path        — legacy / explicit mode
//   2. stdin (if piped)                         — preferred: avoids temp files
//      Triggered when argv[3] is absent AND stdin is not a TTY.
//   3. argv[3] parsed as inline JSON string    — last-resort fallback
let personaRaw = '';
if (personaJsonPathOrInline && fs.existsSync(personaJsonPathOrInline)) {
  personaRaw = fs.readFileSync(personaJsonPathOrInline, 'utf8');
} else if (!process.stdin.isTTY) {
  personaRaw = readStdinSync();
} else if (personaJsonPathOrInline) {
  personaRaw = personaJsonPathOrInline;
}

if (!personaRaw.trim()) {
  die('no persona JSON provided (pass a file path, pipe via stdin, or provide inline JSON)', 2);
}

let persona;
try {
  persona = JSON.parse(personaRaw);
} catch (e) {
  die(`invalid persona JSON: ${e.message}`, 2);
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Render a multi-paragraph narrative. Split on blank lines into <p>s;
// within each paragraph convert **bold** to <strong>.
function renderCopy(raw) {
  const paragraphs = String(raw || '')
    .split(/\n\s*\n/)
    .map(s => s.trim())
    .filter(Boolean);
  return paragraphs
    .map(p => {
      // Escape first, then un-escape the bold markers we convert.
      const escaped = esc(p);
      const withBold = escaped.replace(
        /\*\*([^*]+)\*\*/g,
        '<strong style="color:#0f172a;font-weight:700;">$1</strong>'
      );
      return `<p style="font-size:14px;color:#334155;line-height:1.75;margin:0 0 12px 0;">${withBold}</p>`;
    })
    .join('\n    ');
}

const code = persona.code || '????';
const name = persona.name || 'Unknown';
const family = persona.family || '';
const profession = persona.profession || '';
const tagline = persona.tagline || '';
const copy = persona.copy || '';
const image_url = persona.image_url || '';

const pal = persona.palette || {};
const bg = pal.bg || '#f1f5f9';
const costume = pal.costume || '#334155';
const accent = pal.accent || '#94a3b8';

const card = `<!-- vibeid:v1 -->
<section class="vibeid-card" style="background:${esc(bg)};border-left:6px solid ${esc(costume)};border-radius:12px;padding:24px 28px;margin:24px 0;display:flex;gap:24px;align-items:flex-start;font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 1px 2px rgba(15,23,42,0.06);">
  <img src="${esc(image_url)}" alt="${esc(name)}" style="width:160px;height:160px;flex-shrink:0;border-radius:12px;object-fit:cover;background:${esc(accent)};" />
  <div style="flex:1;min-width:0;">
    <div style="display:flex;align-items:baseline;gap:12px;margin-bottom:8px;flex-wrap:wrap;">
      <span style="font-size:11px;font-weight:600;color:${esc(costume)};text-transform:uppercase;letter-spacing:1.5px;">VibeID</span>
      <span style="font-size:28px;font-weight:700;color:${esc(costume)};letter-spacing:3px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${esc(code)}</span>
      <span style="font-size:18px;font-weight:600;color:#0f172a;">${esc(name)}</span>
      <span style="font-size:12px;color:#64748b;">· ${esc(family)}</span>
    </div>
    <div style="font-size:13px;color:#475569;margin-bottom:14px;font-style:italic;">${esc(profession)}${profession && tagline ? ' — ' : ''}${esc(tagline)}</div>
    ${renderCopy(copy)}
  </div>
</section>
<!-- /vibeid:v1 -->`;

const bakPath = htmlPath + '.bak';
if (!fs.existsSync(bakPath)) {
  fs.writeFileSync(bakPath, html, 'utf8');
}

const markerStart = '<!-- vibeid:v1 -->';
const markerEnd = '<!-- /vibeid:v1 -->';

let newHtml;
if (html.includes(markerStart) && html.includes(markerEnd)) {
  const startIdx = html.indexOf(markerStart);
  const endIdx = html.indexOf(markerEnd) + markerEnd.length;
  newHtml = html.slice(0, startIdx) + card + html.slice(endIdx);
} else {
  const h1Match = html.match(/<h1[^>]*>\s*Claude Code Insights\s*<\/h1>/i);
  if (!h1Match) die('could not find <h1>Claude Code Insights</h1> anchor', 3);
  const anchorEnd = h1Match.index + h1Match[0].length;
  newHtml =
    html.slice(0, anchorEnd) + '\n    ' + card + '\n' + html.slice(anchorEnd);
}

fs.writeFileSync(htmlPath, newHtml, 'utf8');
process.stdout.write(`VibeID card injected: ${code} (${name}) into ${htmlPath}\n`);
