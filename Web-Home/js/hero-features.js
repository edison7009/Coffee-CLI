/**
 * hero-features.js — the feature showcase on the right of the hero.
 *
 * Seven short scenes drawn in HTML/CSS on one shared mini-app skeleton
 * (title bar, sidebar, chat, composer), so every scene has the same frame,
 * scale and padding and highlights exactly one thing in the brand color.
 * Everything is sized in em off a container-relative font size, so the
 * stage scales as one picture at any width.
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

  /* ---------- shared skeleton pieces ---------- */

  const bar = (w, cls) => `<b class="fx-bar${cls ? " " + cls : ""}" style="width:${w}"></b>`;

  function row(w, opts) {
    opts = opts || {};
    return `<div class="fx-row${opts.cls ? " " + opts.cls : ""}"><i class="fx-ico${opts.ico ? " " + opts.ico : ""}"></i>${bar(w)}${opts.tail || ""}</div>`;
  }

  function side(rows) {
    return `<div class="fx-side">
      <div class="fx-side-head">${bar("62%")}${bar("48%")}${bar("54%")}</div>
      <div class="fx-side-label">${bar("34%")}</div>
      ${rows}
    </div>`;
  }

  const SIDE_DEFAULT = [row("70%", { ico: "is-brand" }), row("58%"), row("74%"), row("50%"), row("64%")].join("");

  function composer(tail) {
    return `<div class="fx-composer">${bar("46%", "is-soft")}<div class="fx-composer-tail">${tail || ""}<i class="fx-send"></i></div></div>`;
  }

  function chat() {
    return `<div class="fx-chat">
      <div class="fx-user">${bar("100%", "is-ink")}</div>
      <div class="fx-reply">${bar("86%")}${bar("72%")}${bar("80%")}<div class="fx-code">${bar("54%")}${bar("68%")}${bar("40%")}</div></div>
    </div>`;
  }

  function app(inner, opts) {
    opts = opts || {};
    return `<div class="fx-app${opts.cls ? " " + opts.cls : ""}">${opts.side || side(SIDE_DEFAULT)}${inner}</div>`;
  }

  const cursor = (cls) => `<i class="fx-cursor ${cls}"><svg viewBox="0 0 16 20"><path d="M1 1v15l4-3.6 2.7 6 2.6-1.2-2.6-5.8H13Z"/></svg></i>`;
  const check = `<svg class="fx-check" viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7"/></svg>`;

  /* ---------- the seven scenes ---------- */

  const pane = (n) => `<div class="fx-pane fx-pane-${n}"><span class="fx-pane-no">${n}</span>${bar("70%")}${bar("52%")}${bar("62%")}</div>`;

  const SCENES = {
    split: app(
      `<div class="fx-main">
        <div class="fx-panes">${pane(1)}${pane(2)}${pane(3)}${pane(4)}</div>
        <div class="fx-drop"></div>
        <div class="fx-ghost">${row("64%", { ico: "is-brand" })}</div>
        ${cursor("fx-cursor-split")}
      </div>`,
      { side: side([row("70%", { ico: "is-brand" }), row("58%"), row("74%", { cls: "fx-row-pick" }), row("50%"), row("64%")].join("")) }
    ),

    agents: app(
      `<div class="fx-main">
        <div class="fx-chat">
          <div class="fx-user">${bar("100%", "is-ink")}</div>
          <div class="fx-reply">${bar("78%")}
            <div class="fx-steps">
              <div class="fx-step fx-step-1"><i></i>${bar("52%")}</div>
              <div class="fx-step fx-step-2"><i></i>${bar("44%")}</div>
              <div class="fx-step fx-step-3"><i></i>${bar("58%")}</div>
            </div>
            <div class="fx-done-line">${check}${bar("60%")}</div>
          </div>
        </div>
        ${composer()}
      </div>`,
      {
        side: side(
          row("72%", { ico: "is-brand", cls: "fx-lead", tail: `<i class="fx-spin fx-spin-lead"></i>` }) +
          [1, 2, 3].map((n) => `<div class="fx-row fx-sub fx-sub-${n}"><i class="fx-ico is-helper"></i>${bar(["58%", "50%", "64%"][n - 1])}<i class="fx-spin"></i>${check}</div>`).join("") +
          row("54%") + row("66%")
        )
      }
    ),

    usage: app(
      `<div class="fx-main">
        ${chat()}
        <div class="fx-focus fx-focus-usage"></div>
        ${composer(`<span class="fx-meter fx-meter-a"><em>5h</em><span class="fx-track"><span class="fx-fill"></span></span><strong class="fx-num">68%</strong></span>
          <span class="fx-meter fx-meter-b"><em>7d</em><span class="fx-track"><span class="fx-fill"></span></span><strong class="fx-num">53%</strong></span>
          <span class="fx-balance">¥ 86.40</span>`)}
      </div>`
    ),

    themes: app(
      `<div class="fx-main">
        ${chat()}
        ${composer()}
        <div class="fx-palette">
          <div class="fx-palette-title">${bar("40%")}</div>
          <div class="fx-swatches">
            ${["graphite", "glacier", "sakura", "mint", "amber", "grape"].map((c) => `<i class="fx-sw fx-sw-${c}"><i></i></i>`).join("")}
          </div>
          <i class="fx-sw-ring"></i>
        </div>
        ${cursor("fx-cursor-themes")}
      </div>`,
      { cls: "fx-app-themes" }
    ),

    modes: app(
      `<div class="fx-main">
        <div class="fx-launch">
          <div class="fx-card">
            <img src="agents/icons/claude.svg" alt="" width="20" height="20">
            <span class="fx-card-name">Claude Code</span>
            <span class="fx-toggle"><i class="fx-toggle-pill"></i><span>Terminal</span><span>Desktop</span></span>
          </div>
        </div>
        <div class="fx-modes-view">
          <div class="fx-term">
            <p><span class="fx-prompt">❯</span> claude</p>
            <p class="fx-dim">${bar("62%")}</p>
            <p class="fx-dim">${bar("48%")}</p>
            <p><span class="fx-prompt">❯</span> <i class="fx-caret"></i></p>
          </div>
          <div class="fx-desk">${chat()}${composer()}</div>
        </div>
        ${cursor("fx-cursor-modes")}
      </div>`
    ),

    changes: app(
      `<div class="fx-main fx-with-panel">
        <div class="fx-diff">
          <div class="fx-diff-head">${bar("38%")}</div>
          ${["ctx", "del", "add", "add", "ctx", "add", "del", "add"].map((t, i) => `<div class="fx-dl fx-dl-${t}" style="--i:${i}"><span>${t === "add" ? "+" : t === "del" ? "−" : ""}</span>${bar(["58%", "46%", "64%", "52%", "40%", "70%", "38%", "56%"][i])}</div>`).join("")}
        </div>
        <div class="fx-panel">
          <div class="fx-panel-tabs"><span class="is-on"></span><span></span></div>
          ${[["+19", "−0"], ["+2", "−1"], ["+3", "−0"], ["+20", "−4"]].map((n, i) => `<div class="fx-file fx-file-${i}"><i class="fx-doc"></i>${bar(["56%", "44%", "38%", "50%"][i])}<span class="fx-plus">${n[0]}</span><span class="fx-minus">${n[1]}</span></div>`).join("")}
        </div>
        ${cursor("fx-cursor-changes")}
      </div>`,
      {
        side: side(
          ["open", "merged", "closed", "draft", "open"].map((s, i) =>
            row(["70%", "58%", "66%", "50%", "62%"][i], { ico: i === 0 ? "is-brand" : "", tail: `<i class="fx-pr fx-pr-${s}" style="--i:${i}"></i>` })
          ).join("")
        )
      }
    ),

    tasks: app(
      `<div class="fx-main fx-with-panel">
        <div class="fx-chat">
          <div class="fx-user">${bar("100%", "is-ink")}</div>
          <div class="fx-reply">${bar("80%")}${bar("66%")}</div>
          <div class="fx-user fx-user-new">${bar("100%", "is-ink")}</div>
          <div class="fx-reply fx-reply-new">${bar("74%")}${bar("58%")}</div>
        </div>
        ${composer()}
        <div class="fx-flyer">${bar("100%", "is-ink")}</div>
        <div class="fx-panel">
          <div class="fx-panel-tabs"><span class="is-on"></span><span></span></div>
          ${[0, 1, 2, 3].map((i) => `<div class="fx-task fx-task-${i}"><i class="fx-box">${check}</i>${bar(["64%", "72%", "52%", "60%"][i])}</div>`).join("")}
        </div>
        ${cursor("fx-cursor-tasks")}
      </div>`
    )
  };

  /* ---------- carousel ---------- */

  function init() {
    const root = document.getElementById("hero-features");
    if (!root) return;
    const screen = root.querySelector(".fx-screen");
    const dots = root.querySelector(".fx-dots");
    const caption = root.querySelector(".fx-caption");
    if (!screen || !dots || !caption) return;

    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)");
    const scenes = ORDER.map(function (id, i) {
      const el = document.createElement("div");
      el.className = "fx-scene fx-scene-" + id;
      el.innerHTML = SCENES[id];
      screen.appendChild(el);

      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = "fx-dot";
      dot.setAttribute("aria-label", String(i + 1) + " / " + ORDER.length);
      dot.addEventListener("click", function () {
        show(i);
        schedule();
      });
      dots.appendChild(dot);
      return { el: el, dot: dot };
    });

    const titleEl = caption.querySelector(".fx-caption-title");
    const bodyEl = caption.querySelector(".fx-caption-body");

    let current = -1;
    let timer = 0;
    let visible = true;

    function show(i) {
      if (i === current) {
        // Replay the same scene from the start.
        scenes[i].el.classList.remove("is-on");
        void scenes[i].el.offsetWidth;
        scenes[i].el.classList.add("is-on");
        return;
      }
      if (current >= 0) {
        scenes[current].el.classList.remove("is-on");
        scenes[current].dot.classList.remove("is-on");
        scenes[current].dot.removeAttribute("aria-current");
      }
      current = i;
      scenes[i].el.classList.add("is-on");
      scenes[i].dot.classList.add("is-on");
      scenes[i].dot.setAttribute("aria-current", "true");
      const id = ORDER[i];
      titleEl.setAttribute("data-i18n", "fx-" + id + "-title");
      bodyEl.setAttribute("data-i18n", "fx-" + id + "-body");
      const dict = (typeof I18N_DICT === "object" && (I18N_DICT[currentLang] || I18N_DICT.en)) || {};
      titleEl.innerHTML = dict["fx-" + id + "-title"] || CAPTIONS.en[id][0];
      bodyEl.innerHTML = dict["fx-" + id + "-body"] || CAPTIONS.en[id][1];
    }

    function schedule() {
      clearTimeout(timer);
      if ((reduce && reduce.matches) || !visible || document.hidden) return;
      timer = setTimeout(function () {
        show((current + 1) % ORDER.length);
        schedule();
      }, SCENE_MS);
    }

    show(Math.floor(Math.random() * ORDER.length));
    schedule();

    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (entries) {
        visible = entries[0].isIntersecting;
        root.classList.toggle("is-paused", !visible);
        schedule();
      }).observe(root);
    }
    document.addEventListener("visibilitychange", schedule);
    if (reduce && reduce.addEventListener) reduce.addEventListener("change", schedule);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
