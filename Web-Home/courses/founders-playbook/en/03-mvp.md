# 03. MVP Stage — Build the "Just Enough" Version

> **Exit criteria**: First customers can complete the core flow end-to-end without you bailing them out.

The biggest change in the MVP stage: **writing code is no longer the bottleneck**. One founder + Claude Code ships in a week what a three-person team used to take three months on. But the productivity explosion creates a new trap — **architecture and security debt grow faster than the code itself**.

## Stage Goals

1. **Ship an end-to-end working version**, not a polished partial demo
2. **Choose an architecture that survives "still here in 3 months"**, not "just get it running"
3. **Get security right from day one** — AI-generated code is insecure by default
4. **Build the customer-feedback channel** ready for Launch

## Architecture & Scope

### Three scope red lines

Fast code generation doesn't mean you should build everything. In MVP, hold:

1. **No payments/billing**: use Stripe Payment Links or manual invoices, saves 1 month
2. **No admin UI**: use Retool / Airtable + direct DB, saves 2 weeks
3. **No role/permission system**: everyone is admin, add after Launch

> These three save you 2 months. Spend it on customer iteration.

### The "3-month rule" for tech choices

Ask every tech decision:

> "In 3 months I want to change this. What does it cost?"

- Postgres over NoSQL: complex queries won't block you in 3 months
- Monolith over microservices: easy to split later; hard to merge
- One frontend framework, not a mix: easier to hire

**AI won't make these calls for you** — it doesn't know your 3-month vision. That's founder work.

## Security Practices

AI-generated code defaults to these problems:

| Problem | Symptom | Fix |
|---------|---------|-----|
| **SQL injection** | String-concat SQL | Force parameterized queries / ORM |
| **Hardcoded secrets** | API keys in code | `.env` + check .gitignore |
| **Arbitrary file read** | Path traversal | Whitelist + path.resolve check |
| **CORS misconfig** | `Access-Control-Allow-Origin: *` | Explicit domain list |
| **No rate limit** | One user can DoS the service | Cloudflare / framework middleware |

**Install these guardrails during MVP** — 10x cheaper than fixing after launch.

## Preventing Tech-Debt Explosion

### Set rules for Claude Code

Put `CLAUDE.md` (or `AGENTS.md`) at project root:

```
- All DB queries use prepared statements
- No hardcoded secrets
- Every new feature needs >= 1 integration test
- PRs over 50 lines require a design note first
```

This is the "project constitution" the AI reads. Claude Code, Cursor, Aider all honor it.

### Weekly debt sweep

Block 2 hours weekly, run with Claude:

> "Scan the project. Find: 1) code duplicated 3+ times; 2) critical paths with no test coverage; 3) places that violate CLAUDE.md."

Fix the top 3 that week. The rest can wait.

## Common Failure Modes

| Failure | Why | Fix |
|---------|-----|-----|
| **"Demo MVP"** | Happy path only, breaks under real use | Force 3 customers to run it solo |
| **Premature performance work** | "What about 100K users?" | 100K users is a Scale problem |
| **Commit-without-reading** | Trust AI output blindly | Read every PR diff |
| **Build-everything mindset** | "Don't depend on third parties" | In MVP, no such thing as over-dependence |
| **No feedback channel** | Remembering after launch | Set up customer group / feedback button day one |

## Exit Checklist

- [ ] 3 customers can run the core flow without you
- [ ] All key security items pass (SQL/secrets/CORS/rate limit)
- [ ] `CLAUDE.md` exists and is actually followed
- [ ] You can ship a new feature in a week (no tech-debt drag)
- [ ] Customer feedback channel responds within 24h

If "customers can run it solo" fails, **don't go to Launch**. Keep polishing.

## Sources

- Based on Anthropic *The Founder's Playbook*, MVP chapter
- Coffee CLI users: run Claude Code as a tab in the Coffee CLI desktop app, and put `CLAUDE.md` at your project root
- Original PDF: [official download](https://cdn.prod.website-files.com/6889473510b50328dbb70ae6/69fe2a55b93bb0732b1fe33c_The-Founders-Playbook-05062026_v3%20%281%29.pdf)
