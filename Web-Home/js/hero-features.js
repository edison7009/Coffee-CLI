/**
 * hero-features.js — hero copy (all languages) and the split-view clip on
 * the right of the hero.
 *
 * Loaded right after main.js: it merges the hero copy into I18N_DICT before
 * main.js renders on DOMContentLoaded, and main.js's renderI18N() keeps it in
 * sync on language change via data-i18n. The clip is a real recording of the
 * app; zh / zh-TW visitors get the Chinese recording, everyone else the
 * English one, and phones get the 960px encode.
 */
(function () {
  "use strict";

  // Hero copy (left column): eyebrow, two-line title, one lead paragraph.
  const L = (a, b) => '<span class="hx-line">' + a + '</span><span class="hx-line">' + b + "</span>";
  const HERO_COPY = {
    en: {
      "hx-eyebrow": "Free &amp; open source · Windows / macOS / Linux",
      "hx-title": L("Give your terminal AI agents", "a desktop, <em>beautifully</em>."),
      "hx-lead": "Claude Code, Codex, OpenCode, Pi and other agents get more than a terminal in Coffee CLI — a polished desktop too: drag-to-split, multi-agent orchestration, usage meters, hundreds of looks from themes and styles, changes / diffs / PRs for developers, to-do style queued prompts…"
    },
    zh: {
      "hx-eyebrow": "免费开源 · Windows / macOS / Linux",
      "hx-title": L("让终端里的 AI Agent", "丝滑又<em>美得不可方物</em>"),
      "hx-lead": "Claude Code、Codex、OpenCode、Pi 等这些 Agent，在 Coffee CLI 不仅是终端体验，也可以是完美的桌面端：界面全中文、拖拽分屏、多智能体编排、额度显示、多种配色和形态组合上百种个性界面、开发者改动 / 对比 / PR、ToDo 式预输入…"
    },
    "zh-TW": {
      "hx-eyebrow": "免費開源 · Windows / macOS / Linux",
      "hx-title": L("讓終端機裡的 AI Agent", "絲滑又<em>美得不可方物</em>"),
      "hx-lead": "Claude Code、Codex、OpenCode、Pi 等這些 Agent，在 Coffee CLI 不只是終端機體驗，也可以是完美的桌面端：介面全中文、拖曳分割、多智能體編排、額度顯示、多種配色和形態組合上百種個性介面、開發者改動 / 對比 / PR、ToDo 式預輸入…"
    },
    ja: {
      "hx-eyebrow": "無料・オープンソース · Windows / macOS / Linux",
      "hx-title": L("ターミナルの AI エージェントに", "<em>美しい</em>デスクトップを。"),
      "hx-lead": "Claude Code、Codex、OpenCode、Pi などのエージェントは、Coffee CLI ならターミナルだけでなく完璧なデスクトップにも：ドラッグで画面分割、マルチエージェント、利用枠表示、配色とスタイルで何百通りもの見た目、開発者向けの変更 / 差分 / PR、ToDo 式の事前入力…"
    },
    ko: {
      "hx-eyebrow": "무료 오픈 소스 · Windows / macOS / Linux",
      "hx-title": L("터미널 속 AI 에이전트에", "<em>아름다운</em> 데스크톱을."),
      "hx-lead": "Claude Code, Codex, OpenCode, Pi 같은 에이전트가 Coffee CLI에서는 터미널을 넘어 완벽한 데스크톱이 됩니다: 드래그 화면 분할, 멀티 에이전트, 사용량 표시, 색상과 스타일로 수백 가지 화면, 개발자용 변경 / 비교 / PR, ToDo 식 미리 입력…"
    },
    es: {
      "hx-eyebrow": "Gratis y de código abierto · Windows / macOS / Linux",
      "hx-title": L("Dale a tus agentes de IA", "un escritorio <em>precioso</em>."),
      "hx-lead": "Claude Code, Codex, OpenCode, Pi y otros agentes son en Coffee CLI algo más que una terminal: un escritorio perfecto, con pantalla dividida arrastrando, multiagente, uso y saldo, cientos de estilos combinando temas y formas, cambios / diferencias / PR y prompts en lista de tareas…"
    },
    fr: {
      "hx-eyebrow": "Gratuit et open source · Windows / macOS / Linux",
      "hx-title": L("Offrez à vos agents IA", "un bureau <em>magnifique</em>."),
      "hx-lead": "Avec Coffee CLI, Claude Code, Codex, OpenCode, Pi et les autres agents ne sont plus seulement un terminal, mais un bureau parfait : écran partagé par glisser, multi-agents, quotas visibles, des centaines de styles entre thèmes et formes, modifications / diffs / PR, prompts façon liste de tâches…"
    },
    de: {
      "hx-eyebrow": "Kostenlos &amp; Open Source · Windows / macOS / Linux",
      "hx-title": L("Gib deinen Terminal-KI-Agenten", "einen <em>wunderschönen</em> Desktop."),
      "hx-lead": "Claude Code, Codex, OpenCode, Pi und andere Agenten sind in Coffee CLI nicht nur Terminal, sondern ein perfekter Desktop: Split per Drag, Multi-Agent, Kontingentanzeige, hunderte Looks aus Farben und Stilen, Änderungen / Diffs / PRs, Prompts als To-do-Liste…"
    },
    pt: {
      "hx-eyebrow": "Grátis e de código aberto · Windows / macOS / Linux",
      "hx-title": L("Dê aos seus agentes de IA", "um desktop <em>lindo</em>."),
      "hx-lead": "Claude Code, Codex, OpenCode, Pi e outros agentes são, no Coffee CLI, mais que um terminal: um desktop perfeito, com tela dividida arrastando, multiagente, uso e saldo, centenas de visuais combinando temas e formas, alterações / diffs / PR e prompts em lista de tarefas…"
    },
    ru: {
      "hx-eyebrow": "Бесплатно и с открытым кодом · Windows / macOS / Linux",
      "hx-title": L("Дайте ИИ-агентам из терминала", "<em>красивый</em> рабочий стол."),
      "hx-lead": "Claude Code, Codex, OpenCode, Pi и другие агенты в Coffee CLI — не только терминал, но и идеальный рабочий стол: разделение экрана перетаскиванием, мультиагенты, лимиты, сотни вариантов оформления, изменения / диффы / PR, задачи в виде списка дел…"
    }
  };

  if (typeof I18N_DICT === "object") {
    Object.keys(HERO_COPY).forEach(function (lang) {
      Object.assign(I18N_DICT[lang] || (I18N_DICT[lang] = {}), HERO_COPY[lang]);
    });
  }

  const CLIP = "split-drag";
  const clipLang = () => (currentLang === "zh" || currentLang === "zh-TW" ? "zh" : "en");
  const narrow = window.matchMedia ? window.matchMedia("(max-width: 768px)") : null;

  function init() {
    const root = document.getElementById("hero-features");
    const screen = root && root.querySelector(".fx-screen");
    if (!screen) return;

    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)");
    const reduced = () => !!(reduce && reduce.matches);

    const video = document.createElement("video");
    video.className = "fx-video is-on";
    video.muted = true;
    video.defaultMuted = true;
    video.loop = true;
    video.playsInline = true;
    video.setAttribute("muted", "");
    video.setAttribute("playsinline", "");
    video.preload = "none";
    video.width = 1920;
    video.height = 1080;
    video.setAttribute("aria-hidden", "true");
    screen.appendChild(video);

    let lang = "";
    let visible = true;

    function source() {
      const l = clipLang();
      if (l === lang) return;
      lang = l;
      const base = "demo/features/" + l + "/" + CLIP;
      video.poster = base + "-poster.webp";
      video.src = base + (narrow && narrow.matches ? "-960.mp4" : ".mp4");
    }

    function sync() {
      source();
      if (reduced() || !visible || document.hidden) {
        video.pause();
        return;
      }
      const p = video.play();
      if (p && p.catch) p.catch(function () {});
    }

    // Reduced motion: the clip waits on its poster; a click plays / pauses it.
    screen.addEventListener("click", function () {
      if (video.paused) {
        const p = video.play();
        if (p && p.catch) p.catch(function () {});
      } else {
        video.pause();
      }
    });

    sync();
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (entries) {
        visible = entries[0].isIntersecting;
        sync();
      }, { threshold: 0.25 }).observe(root);
    }
    document.addEventListener("visibilitychange", sync);
    if (reduce && reduce.addEventListener) reduce.addEventListener("change", sync);

    // Follow language changes: main.js's dropdown calls the global renderI18N().
    if (typeof window.renderI18N === "function") {
      const render = window.renderI18N;
      window.renderI18N = function () {
        render.apply(this, arguments);
        if (clipLang() !== lang) sync();
      };
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
