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

  // Seven feature clips over the hero image. A clip with no file yet keeps its
  // dot dimmed and skipped; drop demo/<file>.webm + demo/<file>-poster.webp in
  // and set `file` to light it up.
  const FEATURES = [
    { id: "split", file: "split-view" },
    { id: "agents", file: null },
    { id: "usage", file: null },
    { id: "themes", file: null },
    { id: "modes", file: null },
    { id: "changes", file: null },
    { id: "tasks", file: null }
  ];

  // One short label per clip, shown inside the active (expanded) dot.
  const LABELS = {
    en: { split: "Drag to split", agents: "Multi-agent", usage: "Usage meter", themes: "Themes & styles", modes: "Desktop / terminal", changes: "Changes & PRs", tasks: "To-do prompts" },
    zh: { split: "拖拽分屏", agents: "多智能体编排", usage: "额度显示", themes: "配色与形态", modes: "桌面 / 终端", changes: "改动 / 对比 / PR", tasks: "ToDo 预输入" },
    "zh-TW": { split: "拖曳分割", agents: "多智能體編排", usage: "額度顯示", themes: "配色與形態", modes: "桌面 / 終端機", changes: "改動 / 對比 / PR", tasks: "ToDo 預輸入" },
    ja: { split: "ドラッグで分割", agents: "マルチエージェント", usage: "利用枠表示", themes: "配色とスタイル", modes: "デスクトップ / ターミナル", changes: "変更 / 差分 / PR", tasks: "ToDo 事前入力" },
    ko: { split: "드래그 분할", agents: "멀티 에이전트", usage: "사용량 표시", themes: "색상과 스타일", modes: "데스크톱 / 터미널", changes: "변경 / 비교 / PR", tasks: "ToDo 미리 입력" },
    es: { split: "Dividir arrastrando", agents: "Multiagente", usage: "Uso y saldo", themes: "Temas y estilos", modes: "Escritorio / terminal", changes: "Cambios y PR", tasks: "Prompts en lista" },
    fr: { split: "Glisser pour partager", agents: "Multi-agents", usage: "Quotas", themes: "Thèmes et styles", modes: "Bureau / terminal", changes: "Modifications et PR", tasks: "Prompts en liste" },
    de: { split: "Split per Drag", agents: "Multi-Agent", usage: "Kontingent", themes: "Farben & Stile", modes: "Desktop / Terminal", changes: "Änderungen & PRs", tasks: "To-do-Prompts" },
    pt: { split: "Dividir arrastando", agents: "Multiagente", usage: "Uso e saldo", themes: "Temas e estilos", modes: "Desktop / terminal", changes: "Alterações e PRs", tasks: "Prompts em lista" },
    ru: { split: "Разделение экрана", agents: "Мультиагенты", usage: "Лимиты", themes: "Темы и стили", modes: "Стол / терминал", changes: "Изменения и PR", tasks: "Список задач" }
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

  function init() {
    const root = document.getElementById("hero-features");
    const screen = root && root.querySelector(".fx-screen");
    const dots = root && root.querySelector(".fx-dots");
    if (!screen || !dots) return;

    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)");
    const reduced = () => !!(reduce && reduce.matches);
    const dict = () => (typeof I18N_DICT === "object" && (I18N_DICT[currentLang] || I18N_DICT.en)) || {};

    const slides = FEATURES.map(function (f, i) {
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = "fx-dot";
      dot.innerHTML = '<span class="fx-dot-fill"></span><span class="fx-dot-label" data-i18n="fxl-' + f.id + '"></span>';
      const label = dot.querySelector(".fx-dot-label");
      label.innerHTML = dict()["fxl-" + f.id] || LABELS.en[f.id];
      dot.setAttribute("aria-label", label.textContent);
      dots.appendChild(dot);

      const slide = { f: f, dot: dot, fill: dot.firstChild, video: null };
      if (!f.file) {
        dot.disabled = true;
        dot.classList.add("is-soon");
        return slide;
      }
      dot.addEventListener("click", function () { show(i, true); });

      const video = document.createElement("video");
      video.className = "fx-video";
      video.muted = true;
      video.defaultMuted = true;
      video.playsInline = true;
      video.setAttribute("muted", "");
      video.setAttribute("playsinline", "");
      video.preload = "none";
      video.width = 1920;
      video.height = 1080;
      video.poster = "demo/" + f.file + "-poster.webp";
      video.setAttribute("aria-hidden", "true");
      screen.appendChild(video);
      slide.video = video;

      video.addEventListener("ended", function () {
        if (i === current) next();
      });
      video.addEventListener("timeupdate", function () {
        if (i !== current || !video.duration) return;
        slide.fill.style.transform = "scaleX(" + (video.currentTime / video.duration).toFixed(3) + ")";
      });
      return slide;
    });

    const playable = slides.filter(function (s) { return s.video; });
    if (!playable.length) return;
    // A single clip simply loops; with several, each plays once then hands over.
    if (playable.length === 1) playable[0].video.loop = true;

    let current = -1;
    let visible = true;

    function load(slide) {
      // Attach the file on first play so unseen clips never download.
      if (!slide.video.getAttribute("src")) slide.video.src = "demo/" + slide.f.file + ".webm";
    }

    function sync() {
      if (current < 0) return;
      const v = slides[current].video;
      if (reduced() || !visible || document.hidden) {
        v.pause();
        return;
      }
      load(slides[current]);
      const p = v.play();
      if (p && p.catch) p.catch(function () {});
    }

    function next() {
      let i = current;
      do { i = (i + 1) % slides.length; } while (!slides[i].video);
      show(i, false);
    }

    function show(i, fromUser) {
      if (current >= 0 && current !== i) {
        const old = slides[current];
        old.video.pause();
        old.video.classList.remove("is-on");
        old.dot.classList.remove("is-on");
        old.dot.removeAttribute("aria-current");
        old.fill.style.transform = "";
      }
      current = i;
      const s = slides[i];
      try { s.video.currentTime = 0; } catch (e) { /* not loaded yet */ }
      s.video.classList.add("is-on");
      s.dot.classList.add("is-on");
      s.dot.setAttribute("aria-current", "true");
      if (fromUser && reduced()) {
        // Reduced motion: an explicit click still plays the clip.
        load(s);
        const p = s.video.play();
        if (p && p.catch) p.catch(function () {});
      } else {
        sync();
      }
    }

    // Clicking the picture plays / pauses it.
    screen.addEventListener("click", function () {
      const s = slides[current];
      load(s);
      if (s.video.paused) {
        const p = s.video.play();
        if (p && p.catch) p.catch(function () {});
      } else {
        s.video.pause();
      }
    });

    show(slides.indexOf(playable[0]), false);
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (entries) {
        visible = entries[0].isIntersecting;
        sync();
      }, { threshold: 0.25 }).observe(root);
    }
    document.addEventListener("visibilitychange", sync);
    if (reduce && reduce.addEventListener) reduce.addEventListener("change", sync);

    // Keep the dots' accessible names in step with language changes.
    if (typeof window.renderI18N === "function") {
      const render = window.renderI18N;
      window.renderI18N = function () {
        render.apply(this, arguments);
        slides.forEach(function (s) {
          s.dot.setAttribute("aria-label", s.dot.querySelector(".fx-dot-label").textContent);
        });
      };
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
