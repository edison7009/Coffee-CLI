# 04. Launch Stage — Distinguish PMF from Early Hype

> **Exit criteria**: Core metrics (retention / referral / conversion) stable 4+ weeks without dropping, and you can explain *why*.

Launch is where founders most easily fool themselves. Twitter praise, Product Hunt #1, press mentions — none of these are PMF. They're **fireworks**. Distinguishing fireworks from real fire is the core skill of this stage.

## Stage Goals

1. **Find a meaningful retention signal** (not vanity metrics)
2. **Build agentic marketing/ops workflows** to free the founder from repetition
3. **Decide if it's real PMF or early hype** — Scale or back to MVP
4. **Shift from "I push the product" to "the product grows itself"**

## PMF Measurement

### The one question

Sean Ellis's classic question still holds:

> "How would you feel if you could no longer use this product tomorrow?"

Four answer choices:

- Very disappointed
- Somewhat disappointed
- Not disappointed
- I don't use it anymore

**40%+ choosing "Very disappointed"** = you've touched PMF. Below that, keep polishing.

### Three metrics that don't lie

Fireworks: DAU, signups, retweet count.
**Real fire**:

1. **D7 / D30 retention**: still using after 7 days? 30 days?
2. **Free → paid conversion**: stable ≥ 5% for 4 weeks
3. **Organic referral rate**: % of new users from "friend/colleague told me"

**4 weeks stable** > "one peak moment" by 10x.

### Stop counting vanity metrics

| Fireworks | Real fire |
|-----------|-----------|
| Product Hunt rank | DAU 30 days after launch |
| Twitter follower count | Email → signup conversion |
| Press coverage | Organic search growth |
| Day-1 signups | D30 retention |

## Agentic Operations

After launch, founder attention gets eaten by:

- Customer email / Discord replies
- Marketing content (tweets, blogs, case studies)
- Data analysis
- Customer feedback triage

**Hand all of these to agents**, freeing 80% of your time for what only the founder can do (product direction, key hires, key customers).

### A typical agentic marketing stack

| Work | Tools | Who |
|------|-------|-----|
| Feedback triage | Claude + Linear/Notion API | Agent fully auto |
| Weekly data digest | Claude Code + dbt | Agent auto, founder reviews |
| Content drafts (tweets, blogs) | Cowork | Agent writes, founder edits |
| Customer email replies | Claude.ai templates + manual send | Agent drafts, founder sends |
| Key customer follow-ups | **Founder personally** | Don't let agents touch this |

Last line is non-negotiable: **key customers must be the founder**. Agents cannot replace this.

## Common Failure Modes

| Failure | Why | Fix |
|---------|-----|-----|
| **Mistaking fireworks for fire** | Launch-week metrics explode | Wait 4 full weeks before judging |
| **Premature paid ads** | "Double the budget, double the traffic" | Get to 5%/wk organic first |
| **Founder still manually replying everything** | "Customer experience" | Cap at 2h/day manual, rest goes to agents |
| **Hiring before PMF** | "3 more engineers and we'll win" | Hiring without PMF = scaling errors |
| **Treating PMF as a point** | "We found PMF!" | PMF is a state, can be lost, must be defended |

## Exit Checklist

- [ ] D30 retention ≥ 30% (B2B SaaS) or ≥ 40% (high-frequency consumer)
- [ ] Paid conversion ≥ 5% for 4 consecutive weeks
- [ ] ≥ 20% of new users from organic referrals
- [ ] Founder spends ≤ 2h/day on repetitive work
- [ ] You can explain in one sentence "why users stay"

If "why users stay" has no answer, that's not real PMF — that's luck. Keep observing.

## Sources

- Based on Anthropic *The Founder's Playbook*, Launch chapter
- Sean Ellis PMF Survey template: search "Sean Ellis PMF Survey"
- Original PDF: [official download](https://cdn.prod.website-files.com/6889473510b50328dbb70ae6/69fe2a55b93bb0732b1fe33c_The-Founders-Playbook-05062026_v3%20%281%29.pdf)
