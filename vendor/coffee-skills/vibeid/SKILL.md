---
name: vibeid
name_en: Personality Test
name_zh-CN: 人格测试
name_zh-TW: 人格測試
name_ja: 性格診断
name_ko: 성격 테스트
name_vi: Trắc nghiệm tính cách
name_ru: Тест личности
name_pt: Teste de personalidade
name_es: Test de personalidad
name_fr: Test de personnalité
name_de: Persönlichkeitstest
description: "A personality test that evaluates you through a standardized analysis of real Vibe Coding data, based on your long-term use of tools like Claude Code, Codex, etc."
description_zh-CN: "一个基于长期使用 Claude Code、Codex 等工具后,通过一系列标准化和真实 Vibe Coding 数据来评估的人格测试。"
description_zh-TW: "基於長期使用 Claude Code、Codex 等工具,通過一系列標準化和真實 Vibe Coding 數據評估的人格測試。"
description_ja: "Claude Code、Codex などのツールを長期間使用した後、一連の標準化された実際の Vibe Coding データに基づいて評価される性格診断。"
description_ko: "Claude Code, Codex 등 도구를 장기간 사용한 후 표준화된 실제 Vibe Coding 데이터를 통해 평가되는 성격 테스트입니다."
description_vi: "Trắc nghiệm tính cách dựa trên phân tích chuẩn hóa của dữ liệu Vibe Coding thực tế, sau quá trình sử dụng lâu dài các công cụ như Claude Code, Codex, v.v."
description_ru: "Тест личности, оценивающий вас на основе стандартизированного анализа реальных данных Vibe Coding после длительного использования инструментов вроде Claude Code, Codex и других."
description_pt: "Um teste de personalidade que avalia você por meio de uma análise padronizada de dados reais de Vibe Coding, com base no uso prolongado de ferramentas como Claude Code, Codex, etc."
description_es: "Un test de personalidad que te evalúa mediante un análisis estandarizado de datos reales de Vibe Coding, basado en el uso prolongado de herramientas como Claude Code, Codex, etc."
description_fr: "Un test de personnalité qui vous évalue via une analyse standardisée de données réelles de Vibe Coding, basé sur votre utilisation à long terme d'outils comme Claude Code, Codex, etc."
description_de: "Ein Persönlichkeitstest, der dich durch eine standardisierte Auswertung echter Vibe-Coding-Daten beurteilt — auf Basis deiner langfristigen Nutzung von Tools wie Claude Code, Codex usw."
---

# VibeID — VibeCoding Personality Test

Analyze the user's Claude Code `/insights` report and reveal their **Vibetype**: a 4-letter code (one of 16 combinations) mapped to a distinct persona with low-poly character art.

The skill keeps deterministic logic (HTML parsing, axis thresholds, HTML injection) in Node.js scripts, and reserves Claude for the one thing it is uniquely good at: generating personalized copy from the user's actual behavioral data.

## When to Activate

- User types `/vibeid`, `/vibecoding`, `/vibe`
- User asks for "VibeID", "VibeCoding test", "personality test", or equivalent phrasing
- Coffee CLI launches Claude Code with an initial prompt matching any of the above

## Prerequisites

1. Claude Code installed; user has run `/insights` at least once (produces `~/.claude/usage-data/report.html`)
2. Node.js available on PATH (for `analyze.js` / `inject.js`)

## Execution Steps

Follow in order. Do not skip. Do not fabricate numbers.

### Step 0 — Detect the user's dominant language (any language, worldwide)

**Do this FIRST, before any user-visible output.** The `/vibeid` slash command itself is English, so the invocation tells you nothing. VibeID is a **global** product — any language must render correctly.

Detection priority (use the FIRST source that works):

#### Priority 1 (preferred): `.user_lang` hint from Coffee CLI

When the user clicks "Personality Test" in Coffee CLI, the app writes the UI locale to `~/.claude/skills/vibeid/.user_lang`. This is the **most reliable** signal — the user explicitly picked their UI language.

Use the **Read tool** (Claude Code built-in, NOT `node -e fs.readFileSync` which double-converts `/c/...` into `C:\c\...` on Windows Git Bash):

```
Read ~/.claude/skills/vibeid/.user_lang
```

The file contains one of: `zh-CN`, `zh-TW`, `en`, `ja`, `ko`, `fr`, `de`, `es`, `pt`, `ru`, `vi`.

Normalize to an ISO 639-1 code: `zh-CN` and `zh-TW` → `zh`; others stay as-is. Set `target_language` and skip to Step 1.

#### Priority 2 (fallback): scan session jsonl

If `.user_lang` doesn't exist (user ran /vibeid from a raw CC shell, not Coffee CLI), scan the user's chat history:

1. List recent session files with the Bash tool:
   ```bash
   ls -t ~/.claude/projects/*/*.jsonl 2>/dev/null | head -5
   ```

2. For each of the top 3-5 files, use the **Read tool** (NOT `node -e`) to read the last ~200 lines. Extract lines containing `"role":"user"` — those are the user's own typed messages.

3. Infer the dominant natural language and set `target_language` to the ISO 639-1 code:
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
   - `ar` — Arabic, `tr` — Turkish, `it` — Italian, or any other ISO 639-1 code matching the evidence

#### Priority 3 (last resort): default to `en`

If neither source gives a signal (empty jsonl, unreadable files), default to `en`.

**All subsequent user-visible output in Steps 1, 5, 7 uses `target_language` consistently.** The persona analysis, the "generating report" note, and the final summary are all written in the same language. **Never switch mid-response.**

### Step 1 — Collect behavioral signals from session logs

Run the bundled signal collector via the Bash tool:

```
node "<skill_dir>/scripts/collect.js"
```

It reads the user's local session jsonl tree at `~/.claude/projects/*/*.jsonl` directly — no `/insights` prerequisite, no `report.html`, no network. Prints a JSON object on stdout:

```
{
  "signals": {
    "messages": 1975,
    "sessions": 133,
    "median_response_seconds": 69.1,
    "top_tool": "Bash",
    "craft_ratio": 1.72,
    "design_share": 0.384,
    "rational_share": 0.378,
    "ship_intent_share": 0.029,
    "build_intent_share": 0.028,
    "multi_clauding_pct": 5
  }
}
```

Parse stdout as JSON. If the script exits non-zero, report stderr and stop. If `signals.messages == 0`, the user has no usable session history yet — emit a friendly message in `target_language` asking them to use Claude Code for a few sessions first, then retry, and stop.

### Step 2 — Load the persona matrix

Read the local copy at `<skill_dir>/matrix.json` (use Read). The matrix ships bundled inside the skill — there is no remote fallback to fetch.

The matrix contains:

- `axes` — meaning of each axis letter (P/T, F/S, V/A, L/H)
- `thresholds` — numeric cutoffs to classify each axis
- `families` — the 4 family color palettes (Ember / Sunward / Tidal / Starlit)
- `personas` — 16 entries keyed by 4-letter code
- `image_base_url` — CDN root for persona PNGs

Hold this data in memory. If both local and remote reads fail, report the error honestly and stop — do not fall back to fabricated persona data.

### Step 3 — Derive the 4-letter VibeID code

Using thresholds from `matrix.json` and the signals already collected in Step 1:

- **Mind**: `R` (Rational) if `rational_share >= thresholds.mind_rational_share_min`, else `E` (Expressive). Rational dominates when analytical / corrective / shipping intents (bug fix, refactor, release) outweigh generative / aesthetic intents (feature, UI, visual).
- **Craft**: `D` (Design) if `design_share >= thresholds.craft_design_share_min`, else `T` (Technical). Design leans on Read + Grep + Write (investigate + create new); Technical leans on Bash + Edit (execute + modify).
- **Arc**: `V` (Voyager) if `ship_intent_share > build_intent_share`, else `A` (Architect).
- **Flow**: `H` (Hive) if `multi_clauding_pct >= thresholds.flow_multiclaud_pct`, else `L` (Lone).

Concatenate to form the VibeID code (e.g. `RTAH`). Look it up in `personas` to get the record.

### Step 4 — Generate a rich, multi-section personality analysis

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

**Formatting**: Markdown-friendly plain text with `\n\n` between paragraphs. Bold the persona name once via `**...**` and the 4-letter code once. The chat client renders markdown inline, so headers (`#`) and inline images render naturally — see Step 5.

### Step 5 — Render the persona card to chat

Compose the image URL:

```
image_url = matrix.image_base_url_remote + '/' + persona.code + '.png'
```

Each PNG filename equals the 4-letter code + `.png` (matrix v3+). The skill does NOT bundle the persona art locally — it lives on a CDN, the chat client fetches it on render. If the CDN is unreachable, the rest of the card still renders correctly (just no avatar).

Output the persona card as markdown directly in chat. Pick `name` / `profession` / `tagline` / `family` from the localised matrix fields per Step 4's language rule. Template:

```markdown
# **{code}** · {name}

*{family}* · {profession}

> {tagline}

![{name}]({image_url})

{500-800 word narrative from Step 4, paragraphs separated by blank lines}
```

No HTML, no file writes, no `inject.js`. The card lives in the chat where the user invoked `/vibeid`. They can scroll back / copy / share it like any other Claude response.

### Step 6 — Confirm to the user

After the markdown card, append one short closing line in `target_language` summarising the result — e.g.:

- `zh`: "你的 VibeID 码是 **TFVH**(星海统帅)。"
- `en`: "Your VibeID code is **TFVH** (Tide Marshal)."

Keep it terse — the card above already carries the full picture. Respond in the language the user is using.

## Validation Checkpoints

The skill succeeded if:

1. `collect.js` exited 0 with valid signals JSON (`messages > 0`)
2. `matrix.json` parsed
3. A valid 4-letter VibeID code was derived
4. The persona card markdown was rendered to chat
5. The closing summary line was emitted

## Error Handling

- `collect.js` exits non-zero → report stderr, stop
- `signals.messages == 0` → user has no Claude Code session history yet; ask them to use Claude Code for a few sessions first
- Missing Node.js → report clearly, suggest install
- `matrix.json` parse failure → report stop, do not fabricate persona data
- Persona code not found in matrix.personas → use the closest neighbouring code, document the fallback in the output

## Notes

- Persona images, family palettes, and taglines live in the bundled `matrix.json` — edit that file in the skill dir to tune the experience without redeploying the skill
- 16 persona codes: PFVL, PFVH, PFAL, PFAH, PSVL, PSVH, PSAL, PSAH, TFVL, TFVH, TFAL, TFAH, TSVL, TSVH, TSAL, TSAH
- Inspired by public-domain typologies (Jung 1921 Psychological Types, classical Four Temperaments, Big Five / HEXACO). No MBTI trademarks used.
