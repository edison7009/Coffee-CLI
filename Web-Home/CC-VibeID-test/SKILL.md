---
name: vibeid
description: VibeID — VibeCoding personality test based on Claude Code usage behavior. Use when the user says /vibeid, /vibecoding, "run VibeID test", "personality test", or similar. Analyzes the user's Claude Code /insights report across 4 axes (pace, craft, arc, flow) and reveals their 16-character archetype from the Claw family, then injects a persona card into the report.
---

# VibeID — VibeCoding Personality Test

Analyze the user's Claude Code `/insights` report and reveal their VibeID archetype: a 4-letter code (one of 16 combinations) mapped to a distinct "Claw family" persona with low-poly character art.

The skill keeps deterministic logic (HTML parsing, axis thresholds, HTML injection) in Node.js scripts, and reserves Claude for the one thing it is uniquely good at: generating personalized copy from the user's actual behavioral data.

## When to Activate

- User types `/vibeid`, `/vibecoding`, `/vibe`
- User asks for "VibeID", "VibeCoding test", "personality test", or equivalent phrasing
- Coffee CLI launches Claude Code with an initial prompt matching any of the above

## Prerequisites

1. Claude Code installed; user has run `/insights` at least once (produces `~/.claude/usage-data/report.html`)
2. Node.js available on PATH (for `analyze.js` / `inject.js`)
3. Network access to `https://coffeecli.com/CC-VibeID-test/matrix.json`

## Execution Steps

Follow in order. Do not skip. Do not fabricate numbers.

### Step 0 — Detect the user's dominant language (any language, worldwide)

**Do this FIRST, before any user-visible output.** The `/vibeid` slash command itself is English, so the invocation tells you nothing about the user. VibeID is a **global** product — Chinese / English / Japanese / Korean / French / German / Spanish / Portuguese / Russian / Vietnamese / Arabic / … are all equally first-class. Do not hard-code two-language assumptions.

**IMPORTANT: do NOT use `report.html` for language detection.** The `/insights` feature generates that report's narrative in English regardless of the user's actual language.

**Correct source**: the user's own chat messages in Claude Code's raw session logs at `~/.claude/projects/*/*.jsonl`.

Detection procedure:

1. List recent session files (most-recent first):
   ```bash
   ls -t ~/.claude/projects/*/*.jsonl 2>/dev/null | head -5
   ```

2. Read the top 3-5 files (last ~200 lines each to stay cheap) and extract lines containing `"role":"user"` — those are the user's own typed messages.

3. Look at those messages and infer the dominant natural language. Use your native language-identification ability (this is exactly the kind of task LLMs do well). Output an **ISO 639-1 code**:
   - `zh` — Chinese (simplified or traditional)
   - `en` — English
   - `ja` — Japanese
   - `ko` — Korean
   - `fr` — French
   - `de` — German
   - `es` — Spanish
   - `pt` — Portuguese
   - `ru` — Russian
   - `vi` — Vietnamese
   - `ar` — Arabic
   - `tr` — Turkish
   - `it` — Italian
   - … or any other ISO 639-1 code matching the evidence

4. If the messages are predominantly code / filenames with no natural-language signal, fall back to project directory names under `~/.claude/projects/` for hints. If still no signal, default to `en`.

5. Set `target_language` to the code. If dominant mix is e.g. 60% Chinese + 40% English, pick the **majority** (`zh` in that case) — do not switch languages mid-response.

**All subsequent user-visible output in Steps 1, 5, 7 uses `target_language` consistently.** The persona analysis, the "generating report" note, and the final summary are all written in the same language — the user's own language.

### Step 1 — Ensure the insights report exists

Check whether `~/.claude/usage-data/report.html` exists (expand `~` to the user's home directory).

- **Present**: Continue to Step 2.
- **Missing**: The user hasn't run `/insights` yet. **Auto-generate it** by running the following Bash command (this is a nested, non-interactive `claude` invocation — `-p` means print-mode, fires `/insights` and exits):

  ```bash
  claude -p "/insights"
  ```

  This may take 60–180 seconds on a large usage history. After the command completes, re-check that `~/.claude/usage-data/report.html` exists and continue to Step 2.

  If the file is still missing after the command, stop and report the underlying error honestly — do not fall back to synthetic data.

Tell the user briefly what you're doing, translated naturally into `target_language` from Step 0. Examples for the same meaning ("Generating your usage report first, this takes ~1-2 minutes..."):

- `zh`: 正在为你生成使用报告（约 1-2 分钟）...
- `en`: Generating your usage report first, this takes ~1-2 minutes...
- `ja`: 使用状況レポートを生成中です（約1〜2分かかります）...
- `ko`: 사용 기록 리포트를 생성 중입니다 (약 1~2분 소요)...
- `fr`: Génération de ton rapport d'utilisation (environ 1-2 minutes)...
- `de`: Erstelle deinen Nutzungsbericht (ca. 1-2 Minuten)...
- `es`: Generando tu informe de uso (alrededor de 1-2 minutos)...
- other ISO-639-1 codes: translate appropriately into that language

Do NOT hard-code English here. Use whatever `target_language` was detected.

### Step 2 — Load the persona matrix

Prefer the **local** copy at `<skill_dir>/matrix.json` (use Read). If the local file is missing, fall back to WebFetch `https://coffeecli.com/CC-VibeID-test/matrix.json`.

The matrix contains:

- `axes` — meaning of each axis letter (P/T, F/S, V/A, L/H)
- `thresholds` — numeric cutoffs to classify each axis
- `families` — the 4 family color palettes (Ember / Sunward / Tidal / Starlit)
- `personas` — 16 entries keyed by 4-letter code
- `image_base_url` — CDN root for persona PNGs

Hold this data in memory. If both local and remote reads fail, report the error honestly and stop — do not fall back to fabricated persona data.

### Step 3 — Extract behavioral signals from the report

Run:

```
node <skill_dir>/scripts/analyze.js <path_to_report.html>
```

It prints a JSON object on stdout:

```
{
  "signals": {
    "messages": 2850,
    "sessions": 262,
    "median_response_seconds": 56.2,
    "top_tool": "Bash",
    "craft_ratio": 2.13,
    "ship_intent_share": 0.38,
    "build_intent_share": 0.22,
    "multi_clauding_pct": 16
  }
}
```

Parse stdout as JSON. If the script exits non-zero, report the error and stop.

### Step 4 — Derive the 4-letter VibeID code

Using thresholds from `matrix.json` and signals from Step 3:

- **Pace**: `P` if `median_response_seconds < thresholds.pace_median_seconds`, else `T`
- **Craft**: `F` if `craft_ratio > thresholds.craft_ratio`, else `S`
- **Arc**: `V` if `ship_intent_share > build_intent_share`, else `A`
- **Flow**: `L` if `multi_clauding_pct < thresholds.flow_multiclaud_pct`, else `H`

Concatenate to form the VibeID code (e.g. `TFVH`). Look it up in `personas` to get the record.

### Step 5 — Generate a rich, multi-section personality analysis

Write **500–800 words** of personalized analysis across **5 distinct sections**, separated by **blank lines (`\n\n`)**. Users read this like an MBTI 16Personalities profile — they want depth, specificity, and a little flattery grounded in real numbers.

**Language**: Write the entire 500-800 word analysis in `target_language` detected in Step 0. This supports **any language**, not just Chinese/English:

- If `target_language == "zh"`: write in Simplified Chinese and use `name_cn` / `profession_cn` / `tagline_cn` / family `name_cn` from the matrix (pre-translated by us)
- If `target_language == "en"`: write in English and use the English fields (`name` / `profession` / `tagline` / `family`)
- **For any other language** (ja / ko / fr / de / es / pt / ru / vi / ar / etc.): write the analysis in that language, and **translate `name` / `profession` / `tagline` from the matrix's English fields on the fly** into the same language. Keep the 4-letter code (e.g. `TFAH`) unchanged — it's a brand identifier like `INFJ`, pronounced locally but spelled the same globally.

Tone is consistent across all languages: confident, specific, lightly flattering, grounded in real numbers.

**Required sections** (each a separate paragraph, roughly 100–160 words):

1. **核心画像 / Core Archetype** — Open with their 4-letter code and persona name in bold. Explain why this archetype fits them, connecting to their family's vibe (Ember fast+hands-on / Sunward fast+curious / Tidal deep+hands-on / Starlit deep+reflective).

2. **节奏与专注 / Tempo & Focus** — Analyze their median response time, total messages, and multi-clauding %. What does this say about how they think — sprint mode, deep marathons, or parallel-wielding? Tie to Eysenck / Jungian cognitive style where natural.

3. **工艺与姿态 / Craft & Stance** — Compare their tool mix (Bash/Edit vs Read/Grep ratio). Hands-on forger or careful observer? What does the top tool reveal about their instinct? Reference specific numbers.

4. **成就弧线 / Achievement Arc** — Ship-intent vs Build-intent balance. Are they a shipper (release cadence dominant) or a builder (feature expansion dominant)? Mention commits / files / lines changed if present in signals.

5. **建议与盲点 / Advice & Blind Spot** — 1–2 concrete suggestions leveraging their strengths, and 1 honest blind spot the data suggests (e.g. "潮汐族深度优秀，但 Tide 节奏可能让快速迭代的同伴难以同步"). Constructive, not harsh.

**Tone**: Confident, specific, lightly flattering but grounded in real numbers. **Never fabricate numbers** — only use what Step 3 extracted or the report explicitly states. Bold the persona name once and the 4-letter code once.

**Formatting**: Plain text with `\n\n` between paragraphs. No headers / bullets / markdown bold (the injector renders each paragraph as a `<p>` tag; bold comes from surrounding a phrase with `**...**` which the injector will convert).

### Step 6 — Inject the persona card into the report

**Do NOT create any temporary JSON files** (writing to disk triggers user-level fact-forcing hooks and degrades UX). Pipe the persona JSON to `inject.js` via stdin in a single Bash call using a heredoc:

```bash
node "<skill_dir>/scripts/inject.js" "<path_to_report.html>" << 'VEOF'
{
  "code": "TFVH",
  "name": "星海统帅",
  "family": "潮汐族",
  "profession": "星域元帅",
  "tagline": "指挥多支深空舰队同步出击。",
  "copy": "<the 500-800 word narrative from Step 5, with \\n\\n between sections>",
  "image_url": "../skills/vibeid/images/TFVH.png",
  "palette": { "bg": "#C6D8E0", "costume": "#2E7D87", "accent": "#C0C8D0" }
}
VEOF
```

**Populate `name` / `profession` / `tagline` / `family` with the localized values** matching the user's detected language (English → `name` etc; Chinese → `name_cn` / `profession_cn` / `tagline_cn` / family `name_cn`). The `copy` field is the multi-paragraph narrative from Step 5 with `\n\n` between sections.

**Key rules**:
- Use a single-quoted heredoc marker (`'VEOF'`) so shell doesn't expand `$` or backticks inside the JSON
- `inject.js` accepts persona JSON via stdin (preferred), argv[3] file path (legacy), or argv[3] inline string (fallback)
- One Bash call, zero file writes = minimum gateguard friction

```
{
  "code": "TFVH",
  "name": "星海统帅",
  "family": "潮汐族",
  "profession": "星域元帅",
  "tagline": "指挥多支深空舰队同步出击。",
  "copy": "你是 **TFVH · 星海统帅** ...\n\n在节奏上...\n\n工艺姿态方面...\n\n成就弧线...\n\n建议与盲点...",
  "image_url": "<image_base_url>/TFVH.png",
  "palette": {
    "bg": "#C6D8E0",
    "costume": "#2E7D87",
    "accent": "#C0C8D0"
  }
}
```

**Image URL construction**: use `matrix.image_base_url + '/' + code + '.png'`. The default `image_base_url` is relative (`../skills/vibeid/images`) which resolves correctly from `report.html`'s location in `~/.claude/usage-data/`. If that path doesn't exist, fall back to `matrix.image_base_url_remote`.

The injector rewrites `report.html` in place, inserting a VibeID card just after the `<h1>Claude Code Insights</h1>` header. If the report already has a VibeID card (idempotency marker `<!-- vibeid:v1 -->`), the injector replaces it with the new one. A backup is written to `report.html.bak` before modification.

### Step 7 — Confirm to the user

Print a concise summary:

- VibeID code (e.g. `TFVH`)
- Persona name and profession
- Family
- One sentence of personalized insight
- Path to the updated `report.html`
- Suggest they open the report to see the full card

Respond in the language the user is using.

## Validation Checkpoints

The skill succeeded if:

1. `matrix.json` fetched and parsed
2. `analyze.js` exited 0 with valid signals JSON
3. A valid 4-letter VibeID code was derived
4. `inject.js` exited 0 and `report.html` now contains the `<!-- vibeid:v1 -->` marker
5. The user sees a clear summary

## Error Handling

- Missing `report.html` → stop, ask user to run `/insights`
- Missing Node.js → report clearly, suggest install
- `matrix.json` fetch fails → stop, report network issue
- Analyzer parse failure → stop, show script stderr
- Injector failure → do not partially modify the report; restore from `report.html.bak`

## Notes

- Persona images, family palettes, and taglines live in the remote `matrix.json` — edit that file to tune the experience without redeploying the skill
- 16 persona codes: PFVL, PFVH, PFAL, PFAH, PSVL, PSVH, PSAL, PSAH, TFVL, TFVH, TFAL, TFAH, TSVL, TSVH, TSAL, TSAH
- Inspired by public-domain typologies (Jung 1921 Psychological Types, classical Four Temperaments, Big Five / HEXACO). No MBTI trademarks used.
