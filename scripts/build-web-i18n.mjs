#!/usr/bin/env node
// Generates the per-language homepages of coffeecli.com from Web-Home/index.html.
//
// The English page at / is the template. Every element with data-i18n gets
// its text from the dictionaries in js/main.js + js/hero-features.js (the
// same ones the page uses at runtime), and the head gets a per-language
// title, description, canonical URL and hreflang links, so search engines
// see real translated HTML at /zh/, /ja/, … instead of English plus script.
//
//   node scripts/build-web-i18n.mjs          write Web-Home/<lang>/index.html,
//                                            refresh index.html, sitemap.xml
//   node scripts/build-web-i18n.mjs --check  exit 1 if any output is stale
//
// Run it after changing index.html or any homepage copy, and commit the output.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "Web-Home");
const ORIGIN = "https://coffeecli.com";

// code (as in the dictionaries) → URL path, html lang / hreflang, og:locale
const LANGS = [
  { code: "en", path: "/", tag: "en", locale: "en_US" },
  { code: "zh", path: "/zh/", tag: "zh-Hans", locale: "zh_CN" },
  { code: "zh-TW", path: "/zh-hant/", tag: "zh-Hant", locale: "zh_TW" },
  { code: "ja", path: "/ja/", tag: "ja", locale: "ja_JP" },
  { code: "ko", path: "/ko/", tag: "ko", locale: "ko_KR" },
  { code: "es", path: "/es/", tag: "es", locale: "es_ES" },
  { code: "fr", path: "/fr/", tag: "fr", locale: "fr_FR" },
  { code: "de", path: "/de/", tag: "de", locale: "de_DE" },
  { code: "pt", path: "/pt/", tag: "pt", locale: "pt_BR" },
  { code: "ru", path: "/ru/", tag: "ru", locale: "ru_RU" },
];

// <meta name="description"> per language (search-result snippet, ~160 chars).
const DESCRIPTION = {
  en: "Coffee CLI is a free, open-source desktop for Claude Code, Codex, OpenCode, Pi and other terminal AI agents: split view, multi-agent orchestration, usage meters and hundreds of looks. Windows, macOS, Linux.",
  zh: "Coffee CLI：Claude Code、Codex、OpenCode、Pi 等终端 AI Agent 的免费开源桌面端。全中文界面、拖拽分屏、多智能体编排、额度显示、上百种个性界面，支持 Windows / macOS / Linux。",
  "zh-TW": "Coffee CLI：Claude Code、Codex、OpenCode、Pi 等終端機 AI Agent 的免費開源桌面端。全繁體中文介面、拖曳分割、多智能體編排、額度顯示、上百種個性介面，支援 Windows / macOS / Linux。",
  ja: "Coffee CLI は Claude Code、Codex、OpenCode、Pi などターミナル AI エージェントのための無料・オープンソースのデスクトップアプリ。画面分割、マルチエージェント、利用枠表示、数百通りの見た目。Windows / macOS / Linux 対応。",
  ko: "Coffee CLI는 Claude Code, Codex, OpenCode, Pi 등 터미널 AI 에이전트를 위한 무료 오픈 소스 데스크톱 앱입니다. 화면 분할, 멀티 에이전트, 사용량 표시, 수백 가지 화면. Windows / macOS / Linux 지원.",
  es: "Coffee CLI es un escritorio gratuito y de código abierto para Claude Code, Codex, OpenCode, Pi y otros agentes de IA de terminal: pantalla dividida, multiagente, uso y saldo, y cientos de estilos. Windows, macOS y Linux.",
  fr: "Coffee CLI est un bureau gratuit et open source pour Claude Code, Codex, OpenCode, Pi et les autres agents IA du terminal : écran partagé, multi-agents, quotas visibles et des centaines de styles. Windows, macOS et Linux.",
  de: "Coffee CLI ist ein kostenloser Open-Source-Desktop für Claude Code, Codex, OpenCode, Pi und andere Terminal-KI-Agenten: Split-View, Multi-Agent, Kontingentanzeige und hunderte Looks. Für Windows, macOS und Linux.",
  pt: "Coffee CLI é um desktop gratuito e de código aberto para Claude Code, Codex, OpenCode, Pi e outros agentes de IA de terminal: tela dividida, multiagente, uso e saldo e centenas de visuais. Windows, macOS e Linux.",
  ru: "Coffee CLI — бесплатный десктоп с открытым кодом для Claude Code, Codex, OpenCode, Pi и других терминальных ИИ-агентов: сплит-экран, мультиагенты, лимиты и сотни вариантов оформления. Windows, macOS и Linux.",
};

// Other pages listed in the sitemap (single URL each; they switch language in place).
const EXTRA_PAGES = [
  "/courses/claude-code.html",
  "/courses/founders-playbook.html",
  "/courses/codex.html",
  "/courses/opencode.html",
  "/courses/openclaw.html",
];

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const decode = (s) => s.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

// Load the runtime dictionaries by running the page scripts against a stub DOM.
function loadDictionaries() {
  const noop = () => {};
  const el = { addEventListener: noop, getAttribute: () => null, canPlayType: () => "" };
  const document = {
    readyState: "loading",
    documentElement: { getAttribute: () => "en", setAttribute: noop, style: { setProperty: noop } },
    addEventListener: noop,
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => el,
  };
  const ctx = vm.createContext({
    document,
    window: { matchMedia: () => ({ matches: false }), addEventListener: noop },
    navigator: { userAgent: "", language: "en" },
    localStorage: { getItem: () => null, setItem: noop },
    console,
  });
  for (const f of ["js/main.js", "js/hero-features.js"]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), ctx, { filename: f });
  }
  return vm.runInContext("({ I18N_DICT, INSTALL_DATA })", ctx);
}

// "Coffee CLI — <hero title>", joined the same way hero-features.js does it.
function pageTitle(dict) {
  const lines = [...dict["hx-title"].matchAll(/<span class="hx-line">([\s\S]*?)<\/span>/g)]
    .map((m) => decode(m[1].replace(/<[^>]+>/g, "")).trim());
  const text = lines.reduce((acc, part) => (acc ? acc + (/[A-Za-z0-9.,!?]$/.test(acc) ? " " : "") + part : part), "");
  return "Coffee CLI — " + text;
}

function headBlock(lang, dict) {
  const url = ORIGIN + lang.path;
  const title = pageTitle(dict);
  const desc = DESCRIPTION[lang.code];
  const out = [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(desc)}">`,
    `<link rel="canonical" href="${url}">`,
    ...LANGS.map((l) => `<link rel="alternate" hreflang="${l.tag}" href="${ORIGIN + l.path}">`),
    `<link rel="alternate" hreflang="x-default" href="${ORIGIN}/">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="Coffee CLI">`,
    `<meta property="og:url" content="${url}">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(desc)}">`,
    `<meta property="og:locale" content="${lang.locale}">`,
    ...LANGS.filter((l) => l !== lang).map((l) => `<meta property="og:locale:alternate" content="${l.locale}">`),
  ];
  return out.map((l) => "  " + l).join("\n");
}

function render(template, lang, dicts) {
  const { I18N_DICT, INSTALL_DATA } = dicts;
  const dict = I18N_DICT[lang.code];
  const en = I18N_DICT.en;
  let html = template;

  const swap = (re, fn, what) => {
    if (!re.test(html)) throw new Error(`index.html: ${what} not found`);
    html = html.replace(re, fn);
  };

  swap(/<html lang="[^"]*" data-lang="[^"]*">/, () => `<html lang="${lang.tag}" data-lang="${lang.code}">`, "<html lang data-lang>");
  swap(/(<!-- i18n:head[^\n]*-->)[\s\S]*?<!-- \/i18n:head -->/, (_, a) => a + "\n" + headBlock(lang, dict) + "\n  <!-- /i18n:head -->", "i18n:head block");

  // Text of every data-i18n element (no element nests another of its own tag).
  html = html.replace(/(<([a-z0-9]+)\b[^>]*\bdata-i18n="([^"]+)"[^>]*>)([\s\S]*?)(<\/\2>)/g, (m, open, _tag, key, inner, close) => {
    const text = dict[key] ?? en[key];
    return text === undefined ? m : open + text + close;
  });

  // Mainland mirrors row: visible only on the Chinese pages.
  const cn = lang.code === "zh" || lang.code === "zh-TW";
  swap(/<section class="cn-mirrors" id="cn-mirrors"( hidden)?>/, () => `<section class="cn-mirrors" id="cn-mirrors"${cn ? "" : " hidden"}>`, "#cn-mirrors");

  swap(/(<button class="lang-switch" id="lang-toggle">)[^<]*(<\/button>)/, (_, a, b) => a + lang.code.split("-")[0].toUpperCase() + b, "#lang-toggle");
  html = html.replace(/<a class="lang-option( selected)?" data-lang="([^"]+)"/g, (_, _s, code) =>
    `<a class="lang-option${code === lang.code ? " selected" : ""}" data-lang="${code}"`);
  swap(/(<p class="is-hint" id="install-hint">)[^<]*(<\/p>)/, (_, a, b) => a + esc(INSTALL_DATA[lang.code].windows.hint) + b, "#install-hint");
  return html;
}

function sitemap() {
  const alt = LANGS.map((l) => `    <xhtml:link rel="alternate" hreflang="${l.tag}" href="${ORIGIN + l.path}"/>`)
    .concat(`    <xhtml:link rel="alternate" hreflang="x-default" href="${ORIGIN}/"/>`).join("\n");
  const urls = LANGS.map((l) => `  <url>\n    <loc>${ORIGIN + l.path}</loc>\n${alt}\n  </url>`)
    .concat(EXTRA_PAGES.map((p) => `  <url>\n    <loc>${ORIGIN + p}</loc>\n  </url>`));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!-- Generated by scripts/build-web-i18n.mjs -->\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join("\n")}\n</urlset>\n`;
}

const check = process.argv.includes("--check");
const template = fs.readFileSync(path.join(ROOT, "index.html"), "utf8").replace(/^﻿/, "");
const dicts = loadDictionaries();
const outputs = new Map();
for (const lang of LANGS) {
  if (!dicts.I18N_DICT[lang.code] || !DESCRIPTION[lang.code]) throw new Error(`missing copy for ${lang.code}`);
  const file = lang.path === "/" ? "index.html" : path.join(lang.path.slice(1), "index.html");
  outputs.set(file, render(template, lang, dicts));
}
outputs.set("sitemap.xml", sitemap());

let stale = 0;
for (const [file, content] of outputs) {
  const abs = path.join(ROOT, file);
  const current = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
  if (current === content) continue;
  stale++;
  if (check) {
    console.error(`stale: Web-Home/${file}`);
  } else {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    console.log(`wrote Web-Home/${file}`);
  }
}
if (check && stale) {
  console.error("Run: node scripts/build-web-i18n.mjs");
  process.exit(1);
}
if (!stale) console.log("Web-Home homepages are up to date.");
