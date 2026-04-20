#!/usr/bin/env node
/**
 * VibeID analyzer — extract behavioral signals from Claude Code /insights
 * report.html.
 *
 * Usage: node analyze.js <path_to_report.html>
 * Output: JSON on stdout with shape:
 *   { "signals": { messages, sessions, median_response_seconds, top_tool,
 *                  craft_ratio, ship_intent_share, build_intent_share,
 *                  multi_clauding_pct } }
 * Exits non-zero on parse failures; never fabricates values.
 */

'use strict';

const fs = require('fs');

function die(msg, code = 1) {
  process.stderr.write(`analyze.js: ${msg}\n`);
  process.exit(code);
}

const htmlPath = process.argv[2];
if (!htmlPath) die('usage: analyze.js <report.html>', 2);
if (!fs.existsSync(htmlPath)) die(`file not found: ${htmlPath}`, 2);

const html = fs.readFileSync(htmlPath, 'utf8');

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---- Messages + sessions from subtitle ----
// e.g. "2,850 messages across 262 sessions (415 total) | ..."
const subtitle = (html.match(/class="subtitle">([^<]+)</) || [, ''])[1];
const msgMatch = subtitle.match(/([\d,]+)\s+messages\s+across\s+([\d,]+)\s+sessions/);
const messages = msgMatch ? parseInt(msgMatch[1].replace(/,/g, ''), 10) : 0;
const sessions = msgMatch ? parseInt(msgMatch[2].replace(/,/g, ''), 10) : 0;

// ---- Median response time in seconds ----
const medianMatch = html.match(/Median:\s*([\d.]+)\s*s/);
const median_response_seconds = medianMatch ? parseFloat(medianMatch[1]) : 0;

// ---- Parse a bar-chart by its chart-title ----
function parseBarChart(title) {
  const re = new RegExp(
    `<div class="chart-title"[^>]*>\\s*${escapeRegex(title)}`,
    'i'
  );
  const titleIdx = html.search(re);
  if (titleIdx < 0) return [];

  const tail = html.slice(titleIdx);
  const endIdx = tail
    .slice(1)
    .search(/<div class="chart-card|<div class="chart-title/i);
  const body = endIdx < 0 ? tail : tail.slice(0, endIdx + 1);

  const entries = [];
  const barRe =
    /<div class="bar-label">([^<]+)<\/div>[\s\S]*?<div class="bar-value">([\d,]+)<\/div>/g;
  let m;
  while ((m = barRe.exec(body)) !== null) {
    entries.push({
      label: m[1].trim(),
      value: parseInt(m[2].replace(/,/g, ''), 10),
    });
  }
  return entries;
}

// ---- Top tool + craft ratio ----
const tools = parseBarChart('Top Tools Used');
const top_tool = tools[0] ? tools[0].label : '';

function toolCount(name) {
  const t = tools.find(x => x.label.toLowerCase() === name.toLowerCase());
  return t ? t.value : 0;
}

const craftNum = toolCount('Bash') + toolCount('Edit');
const craftDen = toolCount('Read') + toolCount('Grep');
const craft_ratio =
  craftDen > 0 ? craftNum / craftDen : craftNum > 0 ? 999 : 1;

// New Craft axis (Design vs Technical): Design-side tools include Read,
// Grep, AND Write (Write is "create new" which is research/design-leaning);
// Technical-side tools are Bash + Edit (command + modify).
// design_share is the fraction of Design tools out of Design+Technical.
const design_tools = toolCount('Read') + toolCount('Grep') + toolCount('Write');
const tech_tools = toolCount('Bash') + toolCount('Edit');
const dt_denom = design_tools + tech_tools;
const design_share = dt_denom > 0 ? design_tools / dt_denom : 0.5;

// ---- Ship vs Build intent share ----
const intents = parseBarChart('What You Wanted');
const totalIntent = intents.reduce((s, i) => s + i.value, 0) || 1;

const SHIP_RE = /release|deploy|ship|version|publish|rollout|\bci\b/i;
const BUILD_RE =
  /feature|build|implement|new\s+component|\bui\b|refactor|refinement|\badd\b/i;

// Rational vs Expressive (new Mind axis): rational = analytical/corrective/
// shipping work (bug fix, refactor, release, optimization, cleanup);
// expressive = generative/aesthetic work (feature, UI, visual, animation,
// video/gif, experience).
const RATIONAL_RE =
  /bug\s*fix|refactor|release|deploy|version|optimi[sz]e|\bfix\b|cleanup|\bci\b|rollout|publish/i;
const EXPRESSIVE_RE =
  /feature|\bui\b|experience|refinement|visual|style|animation|video|gif|design|ux|cosmetic/i;

let shipSum = 0;
let buildSum = 0;
let rationalSum = 0;
let expressiveSum = 0;
for (const i of intents) {
  if (SHIP_RE.test(i.label)) shipSum += i.value;
  if (BUILD_RE.test(i.label)) buildSum += i.value;
  if (RATIONAL_RE.test(i.label)) rationalSum += i.value;
  if (EXPRESSIVE_RE.test(i.label)) expressiveSum += i.value;
}
const ship_intent_share = shipSum / totalIntent;
const build_intent_share = buildSum / totalIntent;
const re_denom = rationalSum + expressiveSum;
const rational_share = re_denom > 0 ? rationalSum / re_denom : 0.5;

// ---- Multi-clauding percentage ----
let multi_clauding_pct = 0;
const mcMatch = html.match(/>\s*(\d+)\s*%\s*<[\s\S]{0,400}?Of Messages/i);
if (mcMatch) multi_clauding_pct = parseInt(mcMatch[1], 10);

// ---- Output ----
const result = {
  signals: {
    messages,
    sessions,
    median_response_seconds,
    top_tool,
    craft_ratio: Math.round(craft_ratio * 100) / 100,
    design_share: Math.round(design_share * 1000) / 1000,
    rational_share: Math.round(rational_share * 1000) / 1000,
    ship_intent_share: Math.round(ship_intent_share * 1000) / 1000,
    build_intent_share: Math.round(build_intent_share * 1000) / 1000,
    multi_clauding_pct,
  },
};

process.stdout.write(JSON.stringify(result, null, 2) + '\n');
