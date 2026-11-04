/**
 * hero-features.js — hero copy (all languages) and the split-view clip on
 * the right of the hero.
 *
 * Loaded right after main.js: it merges the hero copy into I18N_DICT before
 * main.js renders on DOMContentLoaded, and main.js's renderI18N() keeps it in
 * sync on language change via data-i18n. The clip is a real recording of the
 * app (960x540 window, Glacier theme), looped and muted.
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

  // Seven feature names over the hero image, as plain text tabs. Clicking one
  // highlights it and shows its clip (looped). A feature whose recording is not
  // ready yet (`file: null`) shows the first clip until
  // demo/<file>.webm + demo/<file>-poster.webp are dropped in and `file` is set.
  const FEATURES = [
    { id: "split", file: "split-view" },
    { id: "agents", file: null },
    { id: "usage", file: null },
    { id: "themes", file: null },
    { id: "modes", file: null },
    { id: "changes", file: null },
    { id: "tasks", file: null }
  ];

  // One short label per clip.
  const LABELS = {
    en: { split: "Split view", agents: "Multi-agent", usage: "Usage", themes: "Themes", modes: "Desktop mode", changes: "Diffs & PRs", tasks: "To-dos" },
    zh: { split: "拖拽分屏", agents: "多智能体编排", usage: "额度显示", themes: "配色与形态", modes: "桌面或终端", changes: "改动对比", tasks: "ToDo 预输入" },
    "zh-TW": { split: "拖曳分割", agents: "多智能體編排", usage: "額度顯示", themes: "配色與形態", modes: "桌面或終端機", changes: "改動對比", tasks: "ToDo 預輸入" },
    ja: { split: "画面分割", agents: "マルチエージェント", usage: "利用枠", themes: "テーマ", modes: "デスクトップ", changes: "差分と PR", tasks: "ToDo" },
    ko: { split: "화면 분할", agents: "멀티 에이전트", usage: "사용량", themes: "테마", modes: "데스크톱 모드", changes: "변경 비교", tasks: "할 일" },
    es: { split: "Pantalla dividida", agents: "Multiagente", usage: "Uso", themes: "Temas", modes: "Modo escritorio", changes: "Cambios y PR", tasks: "Tareas" },
    fr: { split: "Écran partagé", agents: "Multi-agents", usage: "Quotas", themes: "Thèmes", modes: "Mode bureau", changes: "Diffs et PR", tasks: "Tâches" },
    de: { split: "Split-View", agents: "Multi-Agent", usage: "Kontingent", themes: "Themes", modes: "Desktop-Modus", changes: "Diffs & PRs", tasks: "To-dos" },
    pt: { split: "Tela dividida", agents: "Multiagente", usage: "Uso", themes: "Temas", modes: "Modo desktop", changes: "Diffs e PRs", tasks: "Tarefas" },
    ru: { split: "Сплит-экран", agents: "Мультиагенты", usage: "Лимиты", themes: "Темы", modes: "Режим стола", changes: "Диффы и PR", tasks: "Задачи" }
  };

  if (typeof I18N_DICT === "object") {
    Object.keys(HERO_COPY).forEach(function (lang) {
      const dict = I18N_DICT[lang] || (I18N_DICT[lang] = {});
      Object.assign(dict, HERO_COPY[lang]);
      Object.keys(LABELS[lang] || {}).forEach(function (id) {
        dict["fxl-" + id] = LABELS[lang][id];
      });
    });
  }

  // Keep each headline row on one line: shrink the title until its widest
  // row fits the column (long languages get a smaller size instead of a
  // third line). Below the floor size, rows are allowed to wrap again.
  const TITLE_MIN_PX = 24;
  function fitTitle() {
    const title = document.querySelector(".hx-title");
    if (!title) return;
    title.style.fontSize = "";
    title.classList.add("is-fit");
    const lines = title.querySelectorAll(".hx-line");
    const avail = title.clientWidth;
    let widest = 0;
    lines.forEach(function (l) { widest = Math.max(widest, l.scrollWidth); });
    if (!avail || widest <= avail) return;
    const base = parseFloat(getComputedStyle(title).fontSize);
    const size = Math.floor(base * (avail / widest) * 0.98);
    if (size >= TITLE_MIN_PX) {
      title.style.fontSize = size + "px";
    } else {
      title.style.fontSize = TITLE_MIN_PX + "px";
      title.classList.remove("is-fit");
    }
  }

  function initTitleFit() {
    let raf = 0;
    const run = function () { cancelAnimationFrame(raf); raf = requestAnimationFrame(fitTitle); };
    run();
    window.addEventListener("resize", run);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(run);
    return run;
  }

  function init() {
    const refitTitle = initTitleFit();
    const root = document.getElementById("hero-features");
    const screen = root && root.querySelector(".fx-screen");
    const tabs = root && root.querySelector(".fx-tabs");
    if (!screen || !tabs) return;

    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)");
    const reduced = () => !!(reduce && reduce.matches);
    const dict = () => (typeof I18N_DICT === "object" && (I18N_DICT[currentLang] || I18N_DICT.en)) || {};

    function makeVideo(file) {
      const v = document.createElement("video");
      v.className = "fx-video";
      v.muted = true;
      v.defaultMuted = true;
      v.loop = true;
      v.playsInline = true;
      v.setAttribute("muted", "");
      v.setAttribute("playsinline", "");
      v.preload = "none";
      v.width = 1920;
      v.height = 1080;
      v.poster = "demo/" + file + "-poster.webp";
      v.dataset.file = file;
      v.setAttribute("aria-hidden", "true");
      screen.appendChild(v);
      return v;
    }

    // Features share a video element per recording file.
    const fallbackFile = FEATURES.filter(function (f) { return f.file; })[0].file;
    const videos = {};
    const slides = FEATURES.map(function (f, i) {
      const file = f.file || fallbackFile;
      if (!videos[file]) videos[file] = makeVideo(file);

      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "fx-tab";
      tab.setAttribute("data-i18n", "fxl-" + f.id);
      tab.innerHTML = dict()["fxl-" + f.id] || LABELS.en[f.id];
      tab.addEventListener("click", function () { show(i); });
      tabs.appendChild(tab);
      return { video: videos[file], tab: tab };
    });

    let current = -1;
    let visible = true;

    // The tab row stays on one line; when it is wider than the column it
    // scrolls sideways, fades at the cut edge, and keeps the selected tab in view.
    function updateFade() {
      const over = tabs.scrollWidth > tabs.clientWidth + 1;
      tabs.classList.toggle("is-overflow", over);
      tabs.classList.toggle("at-end", !over || tabs.scrollLeft + tabs.clientWidth >= tabs.scrollWidth - 1);
      tabs.classList.toggle("at-start", tabs.scrollLeft <= 1);
    }
    function revealTab(tab) {
      if (tabs.scrollWidth <= tabs.clientWidth + 1) return updateFade();
      const left = tab.offsetLeft - tabs.offsetLeft;
      const target = Math.max(0, Math.min(left - 24, tabs.scrollWidth - tabs.clientWidth));
      tabs.scrollTo({ left: target, behavior: "auto" });
      updateFade();
    }
    tabs.addEventListener("scroll", updateFade, { passive: true });
    window.addEventListener("resize", updateFade);

    function sync() {
      if (current < 0) return;
      const v = slides[current].video;
      if (reduced() || !visible || document.hidden) {
        v.pause();
        return;
      }
      // Attach the file on first play so unseen clips never download.
      if (!v.getAttribute("src")) v.src = "demo/" + v.dataset.file + ".webm";
      const p = v.play();
      if (p && p.catch) p.catch(function () {});
    }

    function show(i) {
      const prev = current >= 0 ? slides[current] : null;
      if (prev) {
        prev.tab.classList.remove("is-on");
        prev.tab.removeAttribute("aria-pressed");
      }
      current = i;
      const s = slides[i];
      s.tab.classList.add("is-on");
      s.tab.setAttribute("aria-pressed", "true");
      revealTab(s.tab);
      if (!prev || prev.video !== s.video) {
        if (prev) {
          prev.video.pause();
          prev.video.classList.remove("is-on");
        }
        s.video.classList.add("is-on");
        try { s.video.currentTime = 0; } catch (e) { /* not loaded yet */ }
      }
      sync();
    }

    // Clicking the picture plays / pauses it (the only way to play it when
    // the visitor asked for reduced motion).
    screen.addEventListener("click", function () {
      const v = slides[current].video;
      if (!v.getAttribute("src")) v.src = "demo/" + v.dataset.file + ".webm";
      if (v.paused) {
        const p = v.play();
        if (p && p.catch) p.catch(function () {});
      } else {
        v.pause();
      }
    });

    show(0);
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (entries) {
        visible = entries[0].isIntersecting;
        sync();
      }, { threshold: 0.25 }).observe(root);
    }
    document.addEventListener("visibilitychange", sync);
    if (reduce && reduce.addEventListener) reduce.addEventListener("change", sync);

    // Language changes swap the copy: refit the title and recheck the tab row.
    if (typeof window.renderI18N === "function") {
      const render = window.renderI18N;
      window.renderI18N = function () {
        render.apply(this, arguments);
        refitTitle();
        if (current >= 0) revealTab(slides[current].tab);
      };
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
