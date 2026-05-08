#!/usr/bin/env node
/**
 * VibeID data collector — read Claude Code session jsonl files directly,
 * compute the 10 behavioral signals that analyze.js used to extract from
 * /insights' rendered report.html.
 *
 * Self-contained — no dependency on /insights running first, no
 * dependency on the report.html being present, no API calls. Just
 * deterministic parsing of:
 *
 *   ~/.claude/projects/<project-slug>/<session-uuid>.jsonl
 *
 * Usage:
 *   node collect.js [--projects-dir <path>] > signals.json
 *
 * Output (matches analyze.js shape, drop-in replacement):
 *   {
 *     "signals": {
 *       "messages": <int>,
 *       "sessions": <int>,
 *       "median_response_seconds": <float>,
 *       "top_tool": "<name>",
 *       "craft_ratio": <float>,
 *       "design_share": <float 0-1>,
 *       "rational_share": <float 0-1>,
 *       "ship_intent_share": <float 0-1>,
 *       "build_intent_share": <float 0-1>,
 *       "multi_clauding_pct": <int 0-100>
 *     }
 *   }
 *
 * Mirrors Claude Code's `commands/insights.ts` aggregation logic for the
 * deterministic stats. The two facet-based signals (ship/build intent)
 * fall back to keyword-regex classification on user message text — same
 * SHIP_RE / BUILD_RE patterns that analyze.js uses, just applied to raw
 * text instead of LLM-generated facet labels.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Intent classification regexes ──────────────────────────────────────
// Ported from analyze.js. Applied to user message text in lieu of the
// LLM-generated facet categories that /insights uses for its "What You
// Wanted" chart.

const SHIP_RE = /release|deploy|ship|version|publish|rollout|\bci\b/i;
const BUILD_RE = /feature|build|implement|new\s+component|\bui\b|refactor|refinement|\badd\b/i;
const RATIONAL_RE = /bug\s*fix|refactor|release|deploy|version|optimi[sz]e|\bfix\b|cleanup|\bci\b|rollout|publish/i;
const EXPRESSIVE_RE = /feature|\bui\b|experience|refinement|visual|style|animation|video|gif|design|ux|cosmetic/i;

// ─── CLI args ───────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { projectsDir: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--projects-dir' && i + 1 < argv.length) {
      out.projectsDir = argv[++i];
    }
  }
  return out;
}

function defaultProjectsDir() {
  return path.join(os.homedir(), '.claude', 'projects');
}

// ─── Filesystem walking ─────────────────────────────────────────────────

function findJsonlFiles(rootDir) {
  const out = [];
  if (!fs.existsSync(rootDir)) return out;
  let projects;
  try {
    projects = fs.readdirSync(rootDir);
  } catch {
    return out;
  }
  for (const proj of projects) {
    const projDir = path.join(rootDir, proj);
    let stat;
    try {
      stat = fs.statSync(projDir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    let entries;
    try {
      entries = fs.readdirSync(projDir);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (f.endsWith('.jsonl')) {
        out.push(path.join(projDir, f));
      }
    }
  }
  return out;
}

// ─── Per-message classification ─────────────────────────────────────────

/**
 * A "human message" in /insights' definition: a `type:"user"` event whose
 * content is a non-empty string OR has at least one text block. Messages
 * that contain only `tool_result` blocks are tool plumbing — the user
 * didn't type those. Match Claude Code's session_storage.ts:
 *   if (typeof content === 'string' && content.trim()) isHumanMessage = true
 *   else if (Array.isArray(content)) for block of content if (block.type === 'text') ...
 */
function classifyUserContent(content) {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    return { isHuman: trimmed.length > 0, text: trimmed };
  }
  if (Array.isArray(content)) {
    let text = '';
    let isHuman = false;
    for (const block of content) {
      if (block && block.type === 'text' && typeof block.text === 'string') {
        isHuman = true;
        text += (text ? '\n' : '') + block.text;
      }
    }
    return { isHuman, text };
  }
  return { isHuman: false, text: '' };
}

// ─── Per-session aggregation ────────────────────────────────────────────

function processFile(filePath) {
  const session = {
    user_message_count: 0,
    user_message_texts: [],
    user_message_timestamps: [],
    response_times: [],
    tool_counts: {},
  };

  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  const lines = raw.split(/\r?\n/);
  let lastAssistantTimestamp = null;

  for (const line of lines) {
    if (!line) continue;
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      continue;
    }
    if (!evt || typeof evt !== 'object') continue;

    // ── Assistant: track tool_use, remember timestamp for response-time gap
    if (evt.type === 'assistant' && evt.message) {
      if (evt.timestamp) lastAssistantTimestamp = evt.timestamp;
      const content = evt.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && block.type === 'tool_use' && typeof block.name === 'string') {
            session.tool_counts[block.name] = (session.tool_counts[block.name] || 0) + 1;
          }
        }
      }
      continue;
    }

    // ── User: count human messages, regex on text, response-time gap
    if (evt.type === 'user' && evt.message) {
      const { isHuman, text } = classifyUserContent(evt.message.content);
      if (!isHuman) continue;
      session.user_message_count++;
      if (text) session.user_message_texts.push(text);

      const ts = evt.timestamp;
      if (typeof ts === 'string') {
        session.user_message_timestamps.push(ts);
        // Response-time gap = (this user msg) - (previous assistant msg).
        // Match insights.ts: only count 2s < gap < 3600s (real think time,
        // not tool-result chatter or overnight-paused windows).
        if (lastAssistantTimestamp) {
          const aMs = Date.parse(lastAssistantTimestamp);
          const uMs = Date.parse(ts);
          if (!Number.isNaN(aMs) && !Number.isNaN(uMs)) {
            const gap = (uMs - aMs) / 1000;
            if (gap > 2 && gap < 3600) {
              session.response_times.push(gap);
            }
          }
        }
      }
      continue;
    }
  }

  return session;
}

// ─── Statistics helpers ─────────────────────────────────────────────────

function median(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

/**
 * Multi-clauding = a user message that has, in the same ±60s window, a
 * user message from a *different* session id. Approximates insights.ts'
 * `detectMultiClauding` (which uses interval overlap + finer-grained
 * categorization, but the headline metric — "% of messages overlapping
 * with another session" — is what shows up in the report and what
 * analyze.js reads).
 */
function multiCladingPct(timestampedMessages) {
  if (timestampedMessages.length < 2) return 0;
  const WINDOW_MS = 60_000;
  const sorted = [...timestampedMessages].sort((a, b) => a.ts - b.ts);
  let overlapCount = 0;
  for (let i = 0; i < sorted.length; i++) {
    const me = sorted[i];
    let overlapping = false;
    // Backward sweep
    for (let j = i - 1; j >= 0; j--) {
      if (me.ts - sorted[j].ts > WINDOW_MS) break;
      if (sorted[j].sessionId !== me.sessionId) {
        overlapping = true;
        break;
      }
    }
    // Forward sweep (only if backward didn't find one)
    if (!overlapping) {
      for (let j = i + 1; j < sorted.length; j++) {
        if (sorted[j].ts - me.ts > WINDOW_MS) break;
        if (sorted[j].sessionId !== me.sessionId) {
          overlapping = true;
          break;
        }
      }
    }
    if (overlapping) overlapCount++;
  }
  return Math.round((overlapCount / sorted.length) * 100);
}

// ─── Main ───────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectsDir = args.projectsDir || defaultProjectsDir();

  const files = findJsonlFiles(projectsDir);

  let totalMessages = 0;
  let totalSessions = 0;
  const totalToolCounts = {};
  const allResponseTimes = [];
  const allTimestampedMessages = [];

  // Intent regex hits, counted per message (a single message can hit
  // multiple regex categories — we count overlapping flags as analyze.js
  // does, then divide by total user messages for the share).
  let shipHits = 0;
  let buildHits = 0;
  let rationalHits = 0;
  let expressiveHits = 0;

  for (const file of files) {
    const session = processFile(file);
    if (!session) continue;
    // Skip warmup-only sessions (no human messages) — they distort the
    // session count. Matches insights.ts `substantiveSessions` filter.
    if (session.user_message_count === 0) continue;

    totalSessions++;
    totalMessages += session.user_message_count;

    for (const [tool, count] of Object.entries(session.tool_counts)) {
      totalToolCounts[tool] = (totalToolCounts[tool] || 0) + count;
    }

    for (const t of session.response_times) allResponseTimes.push(t);

    const sessionId = path.basename(file, '.jsonl');
    for (const tsStr of session.user_message_timestamps) {
      const ms = Date.parse(tsStr);
      if (!Number.isNaN(ms)) {
        allTimestampedMessages.push({ ts: ms, sessionId });
      }
    }

    for (const text of session.user_message_texts) {
      if (SHIP_RE.test(text)) shipHits++;
      if (BUILD_RE.test(text)) buildHits++;
      if (RATIONAL_RE.test(text)) rationalHits++;
      if (EXPRESSIVE_RE.test(text)) expressiveHits++;
    }
  }

  // ── Tool-derived ratios ──
  let topTool = '';
  let topToolCount = 0;
  for (const [tool, count] of Object.entries(totalToolCounts)) {
    if (count > topToolCount) {
      topTool = tool;
      topToolCount = count;
    }
  }
  const tc = name => totalToolCounts[name] || 0;
  const craftNum = tc('Bash') + tc('Edit');
  const craftDen = tc('Read') + tc('Grep');
  const craftRatio = craftDen > 0 ? craftNum / craftDen : craftNum > 0 ? 999 : 1;

  const designSum = tc('Read') + tc('Grep') + tc('Write');
  const techSum = tc('Bash') + tc('Edit');
  const dtDen = designSum + techSum;
  const designShare = dtDen > 0 ? designSum / dtDen : 0.5;

  // ── Intent shares ──
  // analyze.js divides by sum of intent values from the LLM's "What You
  // Wanted" chart. We don't have that — divide by total messages instead.
  // Yields the same axis polarity (ship-leaning vs build-leaning) at a
  // slightly different absolute scale; the matrix's pace/craft/arc/flow
  // thresholds compare to mid-range cutoffs that adapt fine.
  const shipIntentShare = totalMessages > 0 ? shipHits / totalMessages : 0;
  const buildIntentShare = totalMessages > 0 ? buildHits / totalMessages : 0;
  const reDen = rationalHits + expressiveHits;
  const rationalShare = reDen > 0 ? rationalHits / reDen : 0.5;

  const result = {
    signals: {
      messages: totalMessages,
      sessions: totalSessions,
      median_response_seconds: Math.round(median(allResponseTimes) * 10) / 10,
      top_tool: topTool,
      craft_ratio: Math.round(craftRatio * 100) / 100,
      design_share: Math.round(designShare * 1000) / 1000,
      rational_share: Math.round(rationalShare * 1000) / 1000,
      ship_intent_share: Math.round(shipIntentShare * 1000) / 1000,
      build_intent_share: Math.round(buildIntentShare * 1000) / 1000,
      multi_clauding_pct: multiCladingPct(allTimestampedMessages),
    },
  };

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

main();
