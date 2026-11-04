/**
 * hero-features.js — the feature showcase on the right of the hero.
 *
 * Plays seven short screen recordings of the real app, one after another,
 * with a one-line caption under the clip that follows it.
 * Only the active clip is loaded. zh / zh-TW visitors get the Chinese
 * recordings, everyone else the English ones; phones get the 960px encodes.
 *
 * Loaded right after main.js: it merges its captions into I18N_DICT before
 * main.js renders on DOMContentLoaded, and main.js's renderI18N() keeps the
 * captions in sync on language change via data-i18n.
 */
(function () {
  "use strict";

  const SCENE_MS = 6400;

  const CAPTIONS = {
    en: {
      split: ["Split view, up to four sessions", "Drag a chat from the sidebar to the middle to see two or four at once."],
      agents: ["One lead, many helpers", "Claude splits a big job and helpers work on the parts at the same time."],
      usage: ["Usage and balance at a glance", "See how much quota or balance is left right next to the message box."],
      themes: ["Your colors, your style", "12 color themes, light or night. One click in Settings and it changes."],
      modes: ["Desktop mode or terminal mode", "One switch on the launch card: a chat window or the classic terminal."],
      changes: ["See every change", "Every file the AI changed, line by line: green added, red removed."],
      tasks: ["Task list, one click to send", "Write your to-dos on the right and send one to the AI with a click."]
    },
    zh: {
      split: ["分屏，最多四个会话", "把侧栏的会话拖到中间，两个、四个一起看。"],
      agents: ["一个主管，带一群帮手", "Claude 把大活拆开，几个帮手同时开工，做完自动打勾。"],
      usage: ["额度和余额，随时看得到", "输入框旁边就能看到还剩多少额度、多少余额。"],
      themes: ["换个配色，换个样子", "12 种配色，白天夜晚都好看，点一下立刻换。"],
      modes: ["桌面模式，或者终端模式", "启动卡片上一键切换：聊天窗口，或者原生终端。"],
      changes: ["改了什么，一目了然", "AI 改过的每个文件逐行列出：绿色是新增，红色是删除。"],
      tasks: ["任务列表，一键发给 AI", "在右边写好待办，点一下就发给 AI。"]
    },
    "zh-TW": {
      split: ["分割畫面，最多四個會話", "把側欄的會話拖到中間，兩個、四個一起看。"],
      agents: ["一個主管，帶一群幫手", "Claude 把大工作拆開，幾個幫手同時開工，完成自動打勾。"],
      usage: ["額度和餘額，隨時看得到", "輸入框旁邊就能看到還剩多少額度、多少餘額。"],
      themes: ["換個配色，換個樣子", "12 種配色，白天夜晚都好看，點一下立刻換。"],
      modes: ["桌面模式，或是終端機模式", "啟動卡片上一鍵切換：聊天視窗，或原生終端機。"],
      changes: ["改了什麼，一目了然", "AI 改過的每個檔案逐行列出：綠色是新增，紅色是刪除。"],
      tasks: ["任務清單，一鍵送給 AI", "在右邊寫好待辦，點一下就送給 AI。"]
    },
    ja: {
      split: ["画面分割、最大4セッション", "サイドバーの会話を中央へドラッグ。2つでも4つでも同時に見られます。"],
      agents: ["ひとりのリーダーと、たくさんのヘルパー", "Claude が大きな作業を分け、ヘルパーが同時に進めます。"],
      usage: ["利用枠と残高がひと目でわかる", "入力欄のすぐ横に、残りの利用枠と残高を表示します。"],
      themes: ["好きな色、好きなスタイル", "12 色のテーマ、ライトもナイトも。クリックですぐ切り替え。"],
      modes: ["デスクトップモードとターミナルモード", "起動カードでワンクリック切り替え：チャット画面かターミナルか。"],
      changes: ["変更内容がひと目でわかる", "AI が変更したファイルを1行ずつ表示。緑は追加、赤は削除。"],
      tasks: ["タスクリストからワンクリック送信", "右側に ToDo を書いておき、クリックで AI に送信。"]
    },
    ko: {
      split: ["화면 분할, 최대 4개 세션", "사이드바의 대화를 가운데로 끌어 두 개, 네 개를 함께 보세요."],
      agents: ["리더 하나, 도우미 여럿", "Claude가 큰 일을 나누고 도우미들이 동시에 처리합니다."],
      usage: ["사용량과 잔액을 한눈에", "입력창 바로 옆에서 남은 한도와 잔액을 확인하세요."],
      themes: ["원하는 색, 원하는 스타일", "12가지 색상 테마, 라이트와 나이트. 클릭 한 번이면 바뀝니다."],
      modes: ["데스크톱 모드 또는 터미널 모드", "실행 카드에서 한 번에 전환: 채팅 창 또는 기본 터미널."],
      changes: ["무엇이 바뀌었는지 한눈에", "AI가 바꾼 파일을 한 줄씩: 초록은 추가, 빨강은 삭제."],
      tasks: ["작업 목록, 클릭 한 번으로 전송", "오른쪽에 할 일을 적어 두고 클릭 한 번으로 AI에 보내세요."]
    },
    es: {
      split: ["Pantalla dividida, hasta cuatro sesiones", "Arrastra un chat de la barra lateral al centro y mira dos o cuatro a la vez."],
      agents: ["Un líder, muchos ayudantes", "Claude divide un trabajo grande y los ayudantes lo hacen a la vez."],
      usage: ["Uso y saldo de un vistazo", "Mira la cuota o el saldo restante junto al cuadro de mensaje."],
      themes: ["Tus colores, tu estilo", "12 temas de color, claro u oscuro. Un clic en Ajustes y listo."],
      modes: ["Modo escritorio o modo terminal", "Un interruptor en la tarjeta: ventana de chat o terminal clásica."],
      changes: ["Mira cada cambio", "Cada archivo que cambió la IA, línea a línea: verde añadido, rojo quitado."],
      tasks: ["Lista de tareas, enviar con un clic", "Anota tus tareas a la derecha y envía una a la IA con un clic."]
    },
    fr: {
      split: ["Écran partagé, jusqu'à quatre sessions", "Glissez une discussion au centre pour en voir deux ou quatre à la fois."],
      agents: ["Un chef, plusieurs assistants", "Claude découpe un gros travail, les assistants s'y mettent en même temps."],
      usage: ["Quotas et solde d'un coup d'œil", "Le quota ou le solde restant s'affiche à côté de la zone de message."],
      themes: ["Vos couleurs, votre style", "12 thèmes de couleur, clair ou sombre. Un clic et c'est appliqué."],
      modes: ["Mode bureau ou mode terminal", "Un interrupteur sur la carte : fenêtre de discussion ou terminal classique."],
      changes: ["Voyez chaque modification", "Chaque fichier modifié par l'IA, ligne par ligne : vert ajouté, rouge supprimé."],
      tasks: ["Liste de tâches, envoi en un clic", "Notez vos tâches à droite et envoyez-en une à l'IA d'un clic."]
    },
    de: {
      split: ["Geteilte Ansicht, bis zu vier Sitzungen", "Ziehe einen Chat aus der Seitenleiste in die Mitte und sieh zwei oder vier zugleich."],
      agents: ["Eine Leitung, viele Helfer", "Claude teilt eine große Aufgabe auf, Helfer arbeiten gleichzeitig daran."],
      usage: ["Kontingent und Guthaben auf einen Blick", "Restkontingent und Guthaben direkt neben dem Eingabefeld."],
      themes: ["Ihre Farben, Ihr Stil", "12 Farbthemen, hell oder dunkel. Ein Klick, und es wechselt."],
      modes: ["Desktop-Modus oder Terminal-Modus", "Ein Schalter auf der Startkarte: Chatfenster oder klassisches Terminal."],
      changes: ["Jede Änderung im Blick", "Jede von der KI geänderte Datei Zeile für Zeile: grün neu, rot entfernt."],
      tasks: ["Aufgabenliste, mit einem Klick senden", "Aufgaben rechts notieren und mit einem Klick an die KI senden."]
    },
    pt: {
      split: ["Tela dividida, até quatro sessões", "Arraste um chat da barra lateral para o centro e veja dois ou quatro de uma vez."],
      agents: ["Um líder, vários ajudantes", "O Claude divide um trabalho grande e os ajudantes fazem as partes ao mesmo tempo."],
      usage: ["Uso e saldo num relance", "Veja a cota ou o saldo restante ao lado da caixa de mensagem."],
      themes: ["Suas cores, seu estilo", "12 temas de cor, claro ou escuro. Um clique e muda na hora."],
      modes: ["Modo desktop ou modo terminal", "Um botão no cartão: janela de chat ou o terminal clássico."],
      changes: ["Veja cada alteração", "Cada arquivo que a IA alterou, linha a linha: verde adicionado, vermelho removido."],
      tasks: ["Lista de tarefas, envio com um clique", "Anote suas tarefas à direita e envie uma para a IA com um clique."]
    },
    ru: {
      split: ["Разделённый экран, до четырёх сессий", "Перетащите чат из боковой панели в центр — два или четыре сразу."],
      agents: ["Один руководитель, много помощников", "Claude делит большую задачу, помощники работают одновременно."],
      usage: ["Лимиты и баланс с первого взгляда", "Остаток лимита и баланс видны прямо рядом с полем ввода."],
      themes: ["Ваши цвета, ваш стиль", "12 цветовых тем, светлые и тёмные. Один клик — и готово."],
      modes: ["Режим рабочего стола или терминала", "Один переключатель на карточке: окно чата или классический терминал."],
      changes: ["Все изменения на виду", "Каждый файл, изменённый ИИ, построчно: зелёное добавлено, красное удалено."],
      tasks: ["Список задач — отправка в один клик", "Запишите задачи справа и отправьте одну ИИ одним кликом."]
    }
  };

  const ORDER = ["split", "agents", "usage", "themes", "modes", "changes", "tasks"];
  const CLIPS = {
    split: "split-drag",
    agents: "multi-agent",
    usage: "usage-meter",
    themes: "themes-shapes",
    modes: "desktop-terminal",
    changes: "git-diff-pr",
    tasks: "task-list-send"
  };
  // Fallback hop if a clip cannot play (autoplay refused, decode error).
  const FALLBACK_MS = 9000;

  // Merge captions into main.js's dictionary before it renders.
  if (typeof I18N_DICT === "object") {
    Object.keys(CAPTIONS).forEach(function (lang) {
      const dict = I18N_DICT[lang] || (I18N_DICT[lang] = {});
      ORDER.forEach(function (id) {
        dict["fx-" + id + "-title"] = CAPTIONS[lang][id][0];
        dict["fx-" + id + "-body"] = CAPTIONS[lang][id][1];
      });
    });
  }

  /* ---------- carousel ---------- */

  const clipLang = () => (currentLang === "zh" || currentLang === "zh-TW" ? "zh" : "en");
  const narrow = window.matchMedia ? window.matchMedia("(max-width: 768px)") : null;

  function init() {
    const root = document.getElementById("hero-features");
    if (!root) return;
    const screen = root.querySelector(".fx-screen");
    const dots = root.querySelector(".fx-dots");
    const titleEl = root.querySelector(".fx-caption-title");
    if (!screen || !dots || !titleEl) return;

    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)");
    const reduced = () => !!(reduce && reduce.matches);

    const slides = ORDER.map(function (id, i) {
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
      video.setAttribute("aria-hidden", "true");
      screen.appendChild(video);

      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = "fx-dot";
      dot.setAttribute("aria-label", String(i + 1) + " / " + ORDER.length);
      dot.innerHTML = '<span class="fx-dot-fill"></span>';
      dot.addEventListener("click", function () { show(i, true); });
      dots.appendChild(dot);

      return { id: id, video: video, dot: dot, fill: dot.firstChild, lang: "" };
    });

    let current = -1;
    let visible = true;
    let fallback = 0;

    function base(slide) {
      return "demo/features/" + clipLang() + "/" + CLIPS[slide.id];
    }

    // Point a slide at the clip for the current language; posters are cheap,
    // so every slide gets one, but only the active clip downloads video.
    function prime(slide, withVideo) {
      const lang = clipLang();
      if (slide.lang !== lang) {
        slide.lang = lang;
        slide.video.poster = base(slide) + "-poster.webp";
        if (slide.video.getAttribute("src")) {
          slide.video.removeAttribute("src");
          slide.video.load();
        }
      }
      if (withVideo && !slide.video.getAttribute("src")) {
        slide.video.src = base(slide) + (narrow && narrow.matches ? "-960.mp4" : ".mp4");
      }
    }

    function caption(slide) {
      const dict = (typeof I18N_DICT === "object" && (I18N_DICT[currentLang] || I18N_DICT.en)) || {};
      titleEl.setAttribute("data-i18n", "fx-" + slide.id + "-title");
      titleEl.innerHTML = dict["fx-" + slide.id + "-title"] || CAPTIONS.en[slide.id][0];
    }

    function play() {
      clearTimeout(fallback);
      if (current < 0) return;
      const slide = slides[current];
      if (reduced() || !visible || document.hidden) {
        slide.video.pause();
        return;
      }
      prime(slide, true);
      const p = slide.video.play();
      if (p && p.catch) {
        p.catch(function () {
          fallback = setTimeout(next, FALLBACK_MS);
        });
      }
    }

    function next() {
      show((current + 1) % slides.length, false);
    }

    function show(i, fromUser) {
      clearTimeout(fallback);
      if (current >= 0 && current !== i) {
        const old = slides[current];
        old.video.pause();
        old.video.classList.remove("is-on");
        old.dot.classList.remove("is-on");
        old.dot.removeAttribute("aria-current");
        old.fill.style.transform = "";
      }
      current = i;
      const slide = slides[i];
      prime(slide, !reduced() || fromUser);
      try { slide.video.currentTime = 0; } catch (e) { /* not loaded yet */ }
      slide.video.classList.add("is-on");
      slide.dot.classList.add("is-on");
      slide.dot.setAttribute("aria-current", "true");
      caption(slide);
      // Warm the next poster so the hand-off never flashes empty.
      prime(slides[(i + 1) % slides.length], false);
      if (fromUser && reduced()) {
        // Reduced motion: an explicit click still plays the clip once.
        const p = slide.video.play();
        if (p && p.catch) p.catch(function () {});
      } else {
        play();
      }
    }

    slides.forEach(function (slide, i) {
      slide.video.addEventListener("ended", function () {
        if (i === current && !reduced()) next();
      });
      slide.video.addEventListener("error", function () {
        if (i === current && !reduced()) {
          clearTimeout(fallback);
          fallback = setTimeout(next, 1500);
        }
      });
      slide.video.addEventListener("timeupdate", function () {
        if (i !== current || !slide.video.duration) return;
        slide.fill.style.transform = "scaleX(" + (slide.video.currentTime / slide.video.duration).toFixed(3) + ")";
      });
    });

    // Clicking the frame toggles play / pause.
    screen.addEventListener("click", function () {
      const v = slides[current].video;
      if (v.paused) {
        prime(slides[current], true);
        const p = v.play();
        if (p && p.catch) p.catch(function () {});
      } else {
        v.pause();
      }
    });

    show(Math.floor(Math.random() * slides.length), false);

    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (entries) {
        visible = entries[0].isIntersecting;
        play();
      }, { threshold: 0.25 }).observe(root);
    }
    document.addEventListener("visibilitychange", play);
    if (reduce && reduce.addEventListener) reduce.addEventListener("change", play);

    // Follow language changes: main.js's dropdown calls the global renderI18N().
    if (typeof window.renderI18N === "function") {
      const render = window.renderI18N;
      window.renderI18N = function () {
        render.apply(this, arguments);
        if (current >= 0 && slides[current].lang !== clipLang()) {
          slides.forEach(function (s) { s.lang = s.lang && "stale"; });
          show(current, false);
        }
      };
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
