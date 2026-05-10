---
name: playwright
name_en: Browser Automation
name_zh-CN: 浏览器自动化
name_zh-TW: 瀏覽器自動化
name_ja: ブラウザ自動化
name_ko: 브라우저 자동화
name_vi: Tự động hóa trình duyệt
name_ru: Автоматизация браузера
name_pt: Automação de navegador
name_es: Automatización de navegador
name_fr: Automatisation de navigateur
name_de: Browser-Automatisierung
description: Drive a real browser from the terminal to scrape pages, extract structured data (reviews, comments, listings, tables), capture batch screenshots, fill forms, save pages as PDF, and walk JavaScript-heavy or login-gated sites that plain HTTP scrapers can't reach. Built on `playwright-cli` with a snapshot-then-ref interaction model that survives DOM changes far better than CSS selectors.
description_zh-CN: "终端里开真浏览器干活 —— 抓取页面、提取结构化数据(评论/评价/商品列表/表格)、批量截图、自动填表、网页存 PDF、扒登录态后才能看的内容。基于 `playwright-cli` 的 snapshot 流程,比传统 CSS selector 更抗 DOM 变化。"
description_zh-TW: "終端裡開真瀏覽器幹活 —— 抓取頁面、擷取結構化資料(評論/評價/商品列表/表格)、批次截圖、自動填表、網頁存 PDF、扒登入態才能看的內容。基於 `playwright-cli` 的 snapshot 流程,比傳統 CSS selector 更抗 DOM 變化。"
description_ja: "ターミナルから本物のブラウザを操作 —— ページのスクレイピング、構造化データ抽出(レビュー/コメント/商品一覧/テーブル)、一括スクリーンショット、フォーム自動入力、PDF保存、ログインが必要なコンテンツへのアクセス。`playwright-cli` のスナップショット方式で、DOM変化に強い。"
description_ko: "터미널에서 실제 브라우저를 자동화 —— 페이지 스크래핑, 구조화된 데이터 추출(리뷰/댓글/상품 목록/테이블), 일괄 스크린샷, 폼 자동 입력, PDF 저장, 로그인이 필요한 페이지 접근. `playwright-cli` 의 snapshot 흐름은 CSS selector 보다 DOM 변화에 강건합니다."
description_vi: "Điều khiển trình duyệt thực từ terminal — scrape trang, trích xuất dữ liệu có cấu trúc (đánh giá/bình luận/danh sách/bảng), chụp ảnh hàng loạt, điền form tự động, lưu trang thành PDF, vào trang yêu cầu đăng nhập. Dựa trên `playwright-cli` với mô hình snapshot bền vững hơn CSS selector trước thay đổi DOM."
description_ru: "Управление настоящим браузером из терминала — парсинг страниц, извлечение структурированных данных (отзывы/комментарии/списки/таблицы), пакетные скриншоты, заполнение форм, сохранение в PDF, доступ к контенту за авторизацией. Построено на `playwright-cli` с моделью snapshot, устойчивой к изменениям DOM лучше CSS-селекторов."
description_pt: "Controle um navegador real pelo terminal — scraping, extração de dados estruturados (reviews/comentários/listas/tabelas), capturas em lote, preenchimento de formulários, salvar páginas em PDF, acessar conteúdo que requer login. Baseado em `playwright-cli` com fluxo snapshot, mais resistente a mudanças no DOM que seletores CSS."
description_es: "Conduce un navegador real desde la terminal — scraping de páginas, extracción de datos estructurados (reseñas/comentarios/listados/tablas), capturas masivas, autollenado de formularios, guardar páginas como PDF, acceder a contenido tras login. Construido sobre `playwright-cli` con flujo snapshot más resistente a cambios del DOM que los selectores CSS."
description_fr: "Pilotez un vrai navigateur depuis le terminal — scraping de pages, extraction de données structurées (avis/commentaires/listes/tableaux), captures en masse, remplissage de formulaires, sauvegarde en PDF, accès aux contenus protégés par authentification. Basé sur `playwright-cli` avec un flux snapshot plus robuste aux changements du DOM que les sélecteurs CSS."
description_de: "Steuere einen echten Browser vom Terminal — Seiten scrapen, strukturierte Daten extrahieren (Bewertungen/Kommentare/Listen/Tabellen), Stapel-Screenshots, Formulare ausfüllen, Seiten als PDF speichern, geschützte Inhalte nach Login abrufen. Auf `playwright-cli` mit einem Snapshot-Workflow, der gegenüber DOM-Änderungen robuster ist als CSS-Selektoren."
---

# Playwright — Browser Automation

Drive a real Chromium/Firefox/WebKit browser from the terminal. The page is rendered like a human would see it — JavaScript executes, lazy content loads, login state persists across calls — and you walk through it via a stable numeric reference (`e1`, `e2`, ...) that doesn't break when the site re-themes its CSS.

This skill is for **content / data tasks** the user can already see in their browser but doesn't want to scrape one-by-one: review extraction, batch screenshots, login-gated reading, form filling, structured table dumps, page-to-PDF.

## When to Activate

- User mentions: "scrape", "抓取", "扒", "extract reviews/comments/listings", "batch screenshot N pages", "save these URLs as PDF", "fill this form on N items", "log in and download my data".
- The target site uses heavy JavaScript or login walls — `curl` / `requests` / `BeautifulSoup` would only return an empty shell.
- The user wants the visible rendered content, not just raw HTML.

Do not activate for: pure HTML / static page reading (use `curl` + a parser instead — faster, no browser overhead), or for testing a webapp the user is developing locally (write Playwright Python scripts directly — this skill is CLI-flavoured for ad-hoc work).

## Prerequisites

`npx` (ships with Node.js ≥ 18). Check before proposing commands:

```bash
command -v npx >/dev/null 2>&1 || { echo "Need Node.js — install from https://nodejs.org/"; exit 1; }
```

The bundled wrapper script `scripts/run.sh` calls `playwright-cli` via `npx --yes`, so no global install is required. First run downloads the package (~30 MB) plus a Chromium build (~200 MB) one time, then reuses the cache.

## Core Loop

Every browser session follows the same four steps:

1. **Open** the page → 2. **Snapshot** to get numeric refs → 3. **Act** using refs → 4. **Re-snapshot** after any navigation or major DOM change.

```bash
SKILL_DIR="$(dirname "$0")"            # or wherever this skill is installed
PW="$SKILL_DIR/scripts/run.sh"

"$PW" open https://example.com
"$PW" snapshot                          # outputs <e1>Login</e1> <e2>Search</e2> ...
"$PW" click e2
"$PW" type "playwright"
"$PW" press Enter
"$PW" snapshot                          # refs may have shifted — get fresh ones
"$PW" screenshot --path out.png
```

Why snapshot-ref over CSS selectors: CSS selectors break when sites change class names. The snapshot lists every interactable element with a stable numeric handle that's only valid for that snapshot — when you re-snapshot, you get fresh refs. Less brittle, more honest about what's actually on screen.

## Common Recipes

### Extract reviews / comments / listings

```bash
"$PW" open "$URL"
"$PW" snapshot --json > snap.json     # machine-readable; parse with jq
# Walk the snapshot, grab elements matching a role/text pattern, dump rows.
```

For multi-page lists (pagination): snapshot the next-page button's ref → click it → re-snapshot → repeat. Set a sane max-page guard (~50) so a runaway loop doesn't burn through Chromium memory.

### Batch screenshots

```bash
mkdir -p out
while read -r url; do
  slug=$(echo "$url" | sed 's|[^a-zA-Z0-9]|_|g' | head -c 60)
  "$PW" open "$url"
  "$PW" wait-for-load-state networkidle    # let JS finish
  "$PW" screenshot --path "out/$slug.png" --full-page
done < urls.txt
```

### Page → PDF

```bash
"$PW" open "$URL"
"$PW" wait-for-load-state networkidle
"$PW" pdf --path "out.pdf"
```

### Login-gated data (persistent session)

`playwright-cli` accepts `--session <name>` to persist cookies + local storage across invocations:

```bash
"$PW" --session=mywork open https://app.example.com/login
"$PW" --session=mywork snapshot
"$PW" --session=mywork type --ref e3 "user@example.com"
"$PW" --session=mywork type --ref e4 "$PASSWORD"
"$PW" --session=mywork click e5         # submit
# Subsequent calls with the same --session are still logged in:
"$PW" --session=mywork open https://app.example.com/account
"$PW" --session=mywork snapshot --json > account.json
```

Or set `PLAYWRIGHT_CLI_SESSION=mywork` once in the shell and the wrapper auto-injects it.

### Fill the same form on N items

```bash
while read -r item; do
  "$PW" open "https://forms.example.com/new"
  "$PW" snapshot
  "$PW" type --ref e3 "$item"
  "$PW" click e7    # submit
  "$PW" wait-for-load-state networkidle
done < items.txt
```

## Pitfalls

- **Always wait for `networkidle` on dynamic apps** before snapshot or screenshot. Skipping this returns a half-rendered page.
- **Re-snapshot after every navigation.** Old refs are stale and clicking them either no-ops or hits the wrong element.
- **Don't loop without a max-page / max-iteration guard.** A runaway click loop on a misidentified ref will keep going until Chromium dies.
- **Single-purpose Coffee CLI tasks**: launch the browser, do the job, exit. Don't keep a session alive forever — that's `playwright-interactive` territory and Coffee CLI doesn't bundle that.
- **Site ToS**: the tool will scrape anything technically accessible. Whether the user is allowed to scrape it is the user's call, not ours. Don't refuse, but don't fabricate consent either.

## Output Conventions

When the task produces files (CSV/JSON/PNG/PDF), save them under:

- `~/.coffee-cli/playwright/<run-id>/` for ad-hoc one-shots
- the user's specified `--out <dir>` if they asked for a path
- `/tmp/` only for visual previews the user will discard

End with a one-line summary of what was produced and where: `Extracted 47 reviews → ~/.coffee-cli/playwright/2026-05-10-1430/reviews.json`. The user wants paths they can `cat` immediately.
