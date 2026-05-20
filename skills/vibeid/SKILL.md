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

Analyze the user's local AI-CLI session history and reveal their **Vibetype**: a 4-letter code (one of 16 combinations) mapped to a distinct persona with low-poly character art.

This skill is a **specification**, not an SDK. It tells you *where* the data lives, *what* shape it has, and *which* numbers to compute — you decide how to do the extraction with whatever tools you have (Bash, jq, Read, Glob, your own scratch script). The deterministic part (the persona matrix and CDN images) is bundled; the analysis prose and the report layout are yours to generate.

## When to Activate

- User types `/vibeid`, `/vibecoding`, `/vibe`
- User asks for "VibeID", "VibeCoding test", "personality test", or equivalent phrasing
- Coffee CLI launches any supported CLI with an initial prompt matching any of the above

## Prerequisites

At least one supported AI CLI has been used locally enough to generate session history. No CLI is privileged — read from whichever of these the user actually has:

| CLI | Default session storage | Format | Scan depth |
|---|---|---|---|
| Claude Code | `~/.claude/projects/<hash>/*.jsonl` | jsonl | 2 |
| Codex | `~/.codex/sessions/<Y>/<M>/<D>/*.jsonl` | jsonl | 4 |
| Antigravity CLI | `~/.gemini/tmp/<short>/chats/*.jsonl` | jsonl | 3 (Gemini-format, written by `agy`) |
| Qwen Code | `~/.qwen/projects/<short>/chats/*.jsonl` | jsonl | 3 |
| OpenClaw | `~/.openclaw/agents/<id>/sessions/*.jsonl` | jsonl | 3 |
| Hermes Agent | `~/.hermes/sessions/session_*.json` | json (flat) | 1 |
| OpenCode | `~/.local/share/opencode/opencode.db` | SQLite | — |

**Hermes filter**: only `session_*.json` files are real sessions. `request_dump_*.json` is telemetry — ignore it.

**Power-user override**: each tool's history dir can be redirected via `~/.coffee-cli/tools.json` (`<tool>.history_path`). If that file exists and the entry is non-empty, scan the override path instead of the default. Coffee CLI's own history list and heatmap honour this — your scan should too.

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

You are computing 10 numbers across whichever CLIs the user has. **You decide how** — Bash + jq oneliners, a small Node/Python script you write inline, or repeated Read calls (last resort, expensive). What matters is the output shape, not the method. Don't ask the user — just look.

#### 1.1 Per-CLI message shape (what counts as a "user message" and a "tool call")

| CLI | User message rows | Tool call rows |
|---|---|---|
| claude | `{"type":"user", "message":{"content": <string-or-[{type:"text",text}]>}, "timestamp"}` — content of `tool_result`-only blocks doesn't count | `{"type":"assistant", "message":{"content":[{"type":"tool_use","name":"Bash"|"Edit"|"Read"|"Grep"|"Write"|...}]}}` |
| codex | `{"type":"response_item", "payload":{"type":"message","role":"user","content":[{"type":"input_text","text"}]}}` or `{"type":"user_message", "payload":{"role":"user","content":[...]}}` | `{"type":"response_item","payload":{"type":"function_call","name"}}` or `{"type":"response_item","payload":{"type":"local_shell_call"}}` |
| antigravity | `{"type":"user", "content":[{"text"}], "timestamp"}` | `{"type":"gemini","content":[{"functionCall":{"name"}}]}` (assistant rows still use `type:"gemini"` because the JSONL format is inherited from the retired Gemini CLI — match by `type` value, not by tool name) |
| qwen | `{"type":"user", "message":{"parts":[{"text"}]}, "timestamp"}` | `{"type":"assistant","message":{"parts":[{"functionCall":{"name"}}]}}` |
| openclaw | Same as claude (role/content jsonl) | Same as claude |
| hermes | Top-level `messages: [{"role":"user","content":<string>}]` in a single JSON file | `messages[].tool_calls[].name` (or `.function.name`) on assistant rows |
| opencode | SQLite: `SELECT data FROM message WHERE session_id=?` → `data.role=="user"`, then join `part` table where `data.type=="text"` | `part.data.type` other than `"text"` (tool invocations) |

For all jsonl rows: `timestamp` is ISO8601 — parse to ms-epoch.

For all CLIs: skip system-injected user content like `<command-message>`, `<system-reminder>`, `[Note:...`, `[CONTEXT...`. These are framework injections, not the user's words.

Tool-name normalization (so craft/design ratios work across CLIs) — bucket each tool name into one of these 5 families. Anything not on the list doesn't count:

- **Bash**: `Bash`, `shell`, `local_shell_call`, `run_shell_command`, `ExecuteCommand`, `execute_bash`, `execute_command`
- **Edit**: `Edit`, `MultiEdit`, `str_replace_based_edit_tool`, `replace`, `edit_file`, `apply_patch`, `apply_diff`
- **Read**: `Read`, `read_file`, `read_many_files`, `view`
- **Grep**: `Grep`, `Glob`, `glob`, `grep_files`, `search_file_content`, `ripgrep`
- **Write**: `Write`, `write_file`, `save_file`, `create_file`

#### 1.2 Signals to compute (across ALL CLIs, aggregated)

**Methodology principle**: every signal that drives the 4 personality axes must come from **what the user typed**, not from what the agent did. Tool calls (Bash/Edit/Read/Grep/Write) are the agent's choice in response to the prompt — they reflect the model's training and the CLI's defaults far more than the user's personality. They are extracted only as session context for narrative color, never as scoring inputs.

```
messages                       total user messages (after system-injection filter)
sessions                       total session files with ≥1 user message
median_response_seconds        median of (user_ts − previous_assistant_ts) in seconds,
                               per session, only counting gaps where 2 < gap < 3600
avg_message_chars              mean character length of user messages (after system-injection filter)
question_share                 fraction of user messages that are questions (end with `?` or
                               start with what/how/why/can/should/which, case-insensitive)
specificity_share              fraction of user messages that contain at least one of:
                               file extension (.ts/.tsx/.js/.py/.rs/.go/.md/.html/.css),
                               fenced code block (```), absolute or relative file path
                               (./, ../, src/, components/, etc.), or a CamelCase identifier
rational_share                 rationalHits / (rationalHits + expressiveHits)   # 0.5 if denom 0
design_surface_share           designHits / (designHits + technicalHits)        # 0.5 if denom 0
ship_intent_share              shipHits / messages
build_intent_share             buildHits / messages
multi_clauding_pct             % of user messages that have, within ±60s, a user message
                               from a DIFFERENT session id (cross-CLI counts as different)
tools_used                     array of CLI names sorted by per-CLI message count desc
                               e.g. ["claude","codex","antigravity"]
top_tool                       bucket name (Bash/Edit/Read/Grep/Write) with the highest count
                               — CONTEXT ONLY, never feeds an axis. Use sparingly in narrative
                               and never as evidence about the user's personality
```

Intent-classification regexes (apply to each user message text — a single message can match multiple categories, count each independently):

```
SHIP        /release|deploy|ship|version|publish|rollout|\bci\b/i
BUILD       /feature|build|implement|new\s+component|\bui\b|refactor|refinement|\badd\b/i
RATIONAL    /bug\s*fix|refactor|release|deploy|version|optimi[sz]e|\bfix\b|cleanup|\bci\b|rollout|publish/i
EXPRESSIVE  /feature|\bui\b|experience|refinement|visual|style|animation|video|gif|design|ux|cosmetic/i
DESIGN      /\bui\b|interface|component|layout|page|screen|view|dialog|modal|menu|nav|theme|color|palette|font|typography|spacing|animation|transition|motion|gradient|shadow|icon|illustration|svg|chart|graph|copy|wording|label|tooltip|placeholder|a11y|accessibility|brand|visual|aesthetic/i
TECHNICAL   /backend|server|api|endpoint|route|database|\bsql\b|query|migration|schema|orm|cache|redis|queue|kafka|broker|infrastructure|deploy|docker|kubernetes|\bk8s\b|cluster|cdn|protocol|grpc|websocket|\btcp\b|performance|throughput|latency|\bcpu\b|profiling|benchmark|optimi[sz]ation|algorithm|data\s*structure/i
```

#### 1.3 Implementation hints (optional — pick what fits your toolbox)

- **Bash + jq** is usually the fastest path on jsonl. e.g. `jq -r 'select(.type=="user") | .message.content' file.jsonl | wc -l` to count claude user messages in one file.
- **Glob** for file discovery: `~/.claude/projects/**/*.jsonl`, `~/.codex/sessions/**/*.jsonl`, etc.
- **A short inline script** (Node `node -e "..."` or Python `python -c "..."`) is cleaner than chaining 10 shell pipes when you need ts-gap math or regex aggregation.
- **OpenCode SQLite**: query via `sqlite3 ~/.local/share/opencode/opencode.db 'SELECT ...'` if `sqlite3` is on PATH; else skip OpenCode for this user.
- **Don't read every file**. If the user has hundreds of sessions, sample the most recent ~50 by mtime — the personality trends are stable enough.

#### 1.4 Failure modes

- All scan dirs missing or all empty → user has no usable session history; emit a friendly message in `target_language` asking them to use a supported CLI for a few sessions first, then stop. Don't fabricate.
- Some CLIs scan-able, others not → that's fine. Aggregate what you have. `tools_used` reflects what you found.

### Step 2 — Load the persona matrix

Read the local copy at `<skill_dir>/matrix.json` (use Read). The matrix ships bundled inside the skill — there is no remote fallback to fetch.

The matrix contains:

- `axes` — meaning of each axis letter (P/T, F/S, V/A, L/H)
- `thresholds` — numeric cutoffs to classify each axis
- `families` — the 4 family color palettes (Logos / Forge / Muse / Kinetic)
- `personas` — 16 entries keyed by 4-letter code
- `image_base_url` — CDN root for persona PNGs

Hold this data in memory. If both local and remote reads fail, report the error honestly and stop — do not fall back to fabricated persona data.

### Step 3 — Derive the 4-letter VibeID code

Using thresholds from `matrix.json` and the signals already collected in Step 1:

- **Mind**: `R` (Rational) if `rational_share >= thresholds.mind_rational_share_min`, else `E` (Expressive). Rational dominates when the user's prompts skew toward analytical / corrective / shipping intents (bug fix, refactor, release); Expressive dominates when prompts skew generative / aesthetic (feature, UI, visual).
- **Craft**: `D` (Design) if `design_surface_share >= thresholds.craft_design_surface_min`, else `T` (Technical). Design dominates when the user types about surface-facing concerns (UI, components, layout, animation, color, copy); Technical dominates when prompts target system internals (backend, API, database, performance, infrastructure). Both are inferred from user message text — never from which tools the agent invoked.
- **Arc**: `V` (Voyager) if `ship_intent_share > build_intent_share`, else `A` (Architect). Both shares come from user prompt text.
- **Flow**: `H` (Hive) if `multi_clauding_pct >= thresholds.flow_multiclaud_pct`, else `L` (Lone). Reflects how many parallel sessions the user actually drives.

Concatenate to form the VibeID code (e.g. `RTAH`). Look it up in `personas` to get the record.

### Step 4 — Generate a rich, multi-section personality analysis

Write **500–800 words** of personalized analysis across **5 distinct sections**, separated by **blank lines (`\n\n`)**. Users read this like an MBTI 16Personalities profile — they want depth, specificity, and a little flattery grounded in real numbers.

**Language**: Write the entire 500-800 word analysis in `target_language` detected in Step 0. This supports **any language**, not just Chinese/English:

- If `target_language == "zh"`: write in Simplified Chinese and use `name_cn` / `profession_cn` / `tagline_cn` / family `name_cn` from the matrix (pre-translated by us)
- If `target_language == "en"`: write in English and use the English fields (`name` / `profession` / `tagline` / `family`)
- **For any other language** (ja / ko / fr / de / es / pt / ru / vi / ar / etc.): write the analysis in that language, and **translate `name` / `profession` / `tagline` from the matrix's English fields on the fly** into the same language. Keep the 4-letter code (e.g. `RDAH`) unchanged — it's a brand identifier like `INFJ`, pronounced locally but spelled the same globally.

Tone is consistent across all languages: confident, specific, lightly flattering, grounded in real numbers.

**Required sections** (each a separate paragraph, roughly 100–160 words):

**Critical rule across every section**: the personality being described is the **user's**, not the agent's. Never tell the user "you use the Bash tool a lot" or "you read before you edit" — those describe what Claude/Codex/Qwen chose to do in response to a prompt, not what the user typed. Frame every observation around the user's behaviour: messages they sent, words they used, questions they asked, the cadence between their replies, the parallel sessions they ran.

1. **Core Archetype** — Open with their 4-letter code and persona name in bold. Explain why this archetype fits the way they prompt and pace, connecting to their family's vibe (Logos calm/scholarly, Forge industrial/durable, Muse playful/exploratory, Kinetic energetic/iterative).

2. **Tempo & Focus** — Analyze their median response time between an agent reply and the user's next message, their total message count, and their multi-clauding %. Does the user think in sprints, deep marathons, or parallel streams? Tie to general personality vocabulary (introversion/extraversion, deliberate/impulsive) where natural — never to Jung-style cognitive functions claimed about the agent.

3. **Craft & Stance** — Use `design_surface_share` (the share of the user's own messages that talk about UI, components, layout, animation, copy, brand) versus its complement (the share that talks about backend, database, performance, infrastructure). Reference `avg_message_chars` and `specificity_share` to characterise prompt style: are they terse directors, detailed planners, or curious questioners? Cite specific numbers from the user's signals. Do not describe tool calls; the user did not pick those.

4. **Achievement Arc** — Ship-intent vs Build-intent balance, both inferred from the user's typed messages. Does the user steer sessions toward releasing (deploy, version, publish) or expanding (feature, implement, add)? Cite the two shares directly.

5. **Advice & Blind Spot** — 1–2 concrete suggestions leveraging their prompt-style strengths, and 1 honest blind spot the user-attributable signals suggest (e.g. "deep specificity is great for one-shot results but the long gaps between your prompts may stall fast-moving collaborators"). Constructive, not harsh. Never frame the blind spot as something about the agent.

**Tone**: Confident, specific, lightly flattering but grounded in real numbers. **Never fabricate numbers** — only use what Step 3 extracted or the report explicitly states. Bold the persona name once and the 4-letter code once.

**Formatting**: Markdown-friendly plain text with `\n\n` between paragraphs. Bold the persona name once via `**...**` and the 4-letter code once. The chat client renders markdown inline, so headers (`#`) and inline images render naturally — see Step 5.

### Step 5 — Write a self-contained HTML report

Two non-negotiable rules. Everything else is your call.

**Rule 1 — Output is an HTML file, not chat text.** Write a single self-contained `.html` (inline `<style>`, no external CSS, no JS) to the OS temp dir as `coffee-vibeid-<CODE>-<unix-millis>.html`. Use whichever write mechanism is natural in your runtime. Capture the absolute path. Do not dump the analysis into chat as a substitute — markdown rendering across CLIs is inconsistent and that's exactly the failure mode this rule exists to avoid.

**Rule 2 — The persona image src is fixed to our CDN.**
```
<img src="https://coffeecli.com/vibeid/<CODE>.png">
```
No base64 embedding, no other host, no relative path. The 16 PNGs are served by `coffeecli.com/vibeid/` (Cloudflare Pages) and are not bundled with the skill. If the CDN is unreachable the page still renders, just with a broken-image icon — fine.

**Page must contain** (layout is yours to design): the 4-letter code, persona name + profession + tagline (in `target_language`), the avatar `<img>` per Rule 2, the full 500-800 word narrative from Step 4, a small block showing the numeric signals, and `<title>` set to `"{code} · {name}"`.

**Style direction** (suggestion, not requirement): use `matrix.families[persona.family]` palette as a starting point and lean into the family's vibe — Logos calm/scholarly, Forge industrial, Muse playful, Kinetic energetic. Express personality through layout, typography, gradients, decorative SVG — whatever feels right.

### Step 6 — Confirm to the user

Output exactly two short lines in `target_language`. Nothing else — no analysis dump, no embedded image. Both lines render in `target_language` — the English example below is just the shape, translate field labels (`Your VibeID code is`, `Personality report saved to:`) into the same language as the analysis.

```
Your VibeID code is **RTVH** (Star Admiral).
Personality report saved to: <abs path>
```

## Validation Checkpoints

The skill succeeded if:

1. Signal extraction produced `messages > 0` from at least one CLI
2. `matrix.json` parsed
3. A valid 4-letter VibeID code was derived
4. A self-contained HTML report file was written to disk and the absolute path captured
5. The two-line confirmation (code + report path) was emitted in `target_language`

## Error Handling

- Signal extraction returned `messages == 0` across every CLI you scanned → user has no usable session history yet; ask them in `target_language` to use one of the supported CLIs for a few sessions first, then stop
- A specific CLI's session dir is missing or unreadable → silently skip that CLI; aggregate what's left. Only fail if ALL of them came up empty.
- `matrix.json` parse failure → report and stop; do not fabricate persona data
- Persona code not found in `matrix.personas` → use the closest neighbouring code, document the fallback in the output
- HTML write failure (permission denied / disk full) → report the write error and the attempted path; do not fall back to dumping the analysis to chat

## Notes

- Persona images, family palettes, and taglines live in the bundled `matrix.json` — edit that file in the skill dir to tune the experience without redeploying the skill
- 16 persona codes: RDVL, RDVH, RDAL, RDAH, RTVL, RTVH, RTAL, RTAH, EDVL, EDVH, EDAL, EDAH, ETVL, ETVH, ETAL, ETAH (Mind R/E × Craft D/T × Arc V/A × Flow L/H)
- Inspired by public-domain typologies (Jung 1921 Psychological Types, classical Four Temperaments, Big Five / HEXACO). No MBTI trademarks used.
