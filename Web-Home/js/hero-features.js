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
      "hx-lead": "Claude Code, Codex, OpenCode, Pi and other agents get more than a terminal in Coffee CLI — a polished desktop too: a fully English interface, drag-to-split, multi-agent orchestration, usage meters, hundreds of looks from themes and styles, changes / diffs / PRs for developers, to-do style queued prompts…"
    },
    zh: {
      "hx-eyebrow": "免费开源 · Windows / macOS / Linux",
      "hx-title": L("让终端里的 AI Agent", "丝滑又<em>美得不可方物</em>"),
      "hx-lead": "Claude Code、Codex、OpenCode、Pi 等这些 Agent，在 Coffee CLI 不仅是终端体验，也可以是完美的桌面端：全中文界面、拖拽分屏、多智能体编排、额度显示、多种配色和形态组合上百种个性界面、开发者改动 / 对比 / PR、ToDo 式预输入…"
    },
    "zh-TW": {
      "hx-eyebrow": "免費開源 · Windows / macOS / Linux",
      "hx-title": L("讓終端機裡的 AI Agent", "絲滑又<em>美得不可方物</em>"),
      "hx-lead": "Claude Code、Codex、OpenCode、Pi 等這些 Agent，在 Coffee CLI 不只是終端機體驗，也可以是完美的桌面端：全繁體中文介面、拖曳分割、多智能體編排、額度顯示、多種配色和形態組合上百種個性介面、開發者改動 / 對比 / PR、ToDo 式預輸入…"
    },
    ja: {
      "hx-eyebrow": "無料・オープンソース · Windows / macOS / Linux",
      "hx-title": L("ターミナルの AI エージェントに", "<em>美しい</em>デスクトップを。"),
      "hx-lead": "Claude Code、Codex、OpenCode、Pi などのエージェントは、Coffee CLI ならターミナルだけでなく完璧なデスクトップにも：全日本語の画面、ドラッグで画面分割、マルチエージェント、利用枠表示、配色とスタイルで何百通りもの見た目、開発者向けの変更 / 差分 / PR、ToDo 式の事前入力…"
    },
    ko: {
      "hx-eyebrow": "무료 오픈 소스 · Windows / macOS / Linux",
      "hx-title": L("터미널 속 AI 에이전트에", "<em>아름다운</em> 데스크톱을."),
      "hx-lead": "Claude Code, Codex, OpenCode, Pi 같은 에이전트가 Coffee CLI에서는 터미널을 넘어 완벽한 데스크톱이 됩니다: 전체 한국어 화면, 드래그 화면 분할, 멀티 에이전트, 사용량 표시, 색상과 스타일로 수백 가지 화면, 개발자용 변경 / 비교 / PR, ToDo 식 미리 입력…"
    },
    es: {
      "hx-eyebrow": "Gratis y de código abierto · Windows / macOS / Linux",
      "hx-title": L("Dale a tus agentes de IA", "un escritorio <em>precioso</em>."),
      "hx-lead": "Claude Code, Codex, OpenCode, Pi y otros agentes son en Coffee CLI algo más que una terminal: un escritorio perfecto, con interfaz totalmente en español, pantalla dividida arrastrando, multiagente, uso y saldo, cientos de estilos combinando temas y formas, cambios / diferencias / PR y prompts en lista de tareas…"
    },
    fr: {
      "hx-eyebrow": "Gratuit et open source · Windows / macOS / Linux",
      "hx-title": L("Offrez à vos agents IA", "un bureau <em>magnifique</em>."),
      "hx-lead": "Avec Coffee CLI, Claude Code, Codex, OpenCode, Pi et les autres agents ne sont plus seulement un terminal, mais un bureau parfait : interface entièrement en français, écran partagé par glisser, multi-agents, quotas visibles, des centaines de styles entre thèmes et formes, modifications / diffs / PR, prompts façon liste de tâches…"
    },
    de: {
      "hx-eyebrow": "Kostenlos &amp; Open Source · Windows / macOS / Linux",
      "hx-title": L("Gib deinen Terminal-KI-Agenten", "einen <em>wunderschönen</em> Desktop."),
      "hx-lead": "Claude Code, Codex, OpenCode, Pi und andere Agenten sind in Coffee CLI nicht nur Terminal, sondern ein perfekter Desktop: komplett deutsche Oberfläche, Split per Drag, Multi-Agent, Kontingentanzeige, hunderte Looks aus Farben und Stilen, Änderungen / Diffs / PRs, Prompts als To-do-Liste…"
    },
    pt: {
      "hx-eyebrow": "Grátis e de código aberto · Windows / macOS / Linux",
      "hx-title": L("Dê aos seus agentes de IA", "um desktop <em>lindo</em>."),
      "hx-lead": "Claude Code, Codex, OpenCode, Pi e outros agentes são, no Coffee CLI, mais que um terminal: um desktop perfeito, com interface toda em português, tela dividida arrastando, multiagente, uso e saldo, centenas de visuais combinando temas e formas, alterações / diffs / PR e prompts em lista de tarefas…"
    },
    ru: {
      "hx-eyebrow": "Бесплатно и с открытым кодом · Windows / macOS / Linux",
      "hx-title": L("Дайте ИИ-агентам из терминала", "<em>красивый</em> рабочий стол."),
      "hx-lead": "Claude Code, Codex, OpenCode, Pi и другие агенты в Coffee CLI — не только терминал, но и идеальный рабочий стол: полностью русский интерфейс, разделение экрана перетаскиванием, мультиагенты, лимиты, сотни вариантов оформления, изменения / диффы / PR, задачи в виде списка дел…"
    }
  };

  // Bottom install block: heading and the copy button label.
  const INSTALL_COPY = {
    en: { "install-title": "Or install from the terminal", "copy-label": "Copy", "hx-install-link": "Install via terminal", "hx-more-link": "More versions" },
    zh: { "install-title": "或者用命令一键安装", "copy-label": "复制", "hx-install-link": "命令安装", "hx-more-link": "更多版本" },
    "zh-TW": { "install-title": "或者用命令一鍵安裝", "copy-label": "複製", "hx-install-link": "命令安裝", "hx-more-link": "更多版本" },
    ja: { "install-title": "ターミナルからインストール", "copy-label": "コピー", "hx-install-link": "コマンドでインストール", "hx-more-link": "その他のバージョン" },
    ko: { "install-title": "터미널로 설치하기", "copy-label": "복사", "hx-install-link": "명령어로 설치", "hx-more-link": "더 많은 버전" },
    es: { "install-title": "O instálalo desde la terminal", "copy-label": "Copiar", "hx-install-link": "Instalar por terminal", "hx-more-link": "Más versiones" },
    fr: { "install-title": "Ou installez depuis le terminal", "copy-label": "Copier", "hx-install-link": "Installer en ligne de commande", "hx-more-link": "Plus de versions" },
    de: { "install-title": "Oder im Terminal installieren", "copy-label": "Kopieren", "hx-install-link": "Per Terminal installieren", "hx-more-link": "Weitere Versionen" },
    pt: { "install-title": "Ou instale pelo terminal", "copy-label": "Copiar", "hx-install-link": "Instalar pelo terminal", "hx-more-link": "Mais versões" },
    ru: { "install-title": "Или установите из терминала", "copy-label": "Копировать", "hx-install-link": "Установка из терминала", "hx-more-link": "Другие версии" }
  };

  // Feature sections under the hero: [title, description] per feature.
  const FEATURE_COPY = {
    en: {
      split: ["Split view, up to four sessions", "Drag a chat from the sidebar into the middle to split left/right or top/bottom. Watch two, three or four sessions at once and see who is working."],
      agents: ["One lead, many helpers", "Claude Code breaks a big job into parts and hands them to helpers like DeepSeek Harness that work at the same time. The sidebar shows each helper's progress and ticks it off when done."],
      usage: ["Usage and balance at a glance", "Right next to the message box: the 5-hour and weekly limits for Claude and Codex, or your account balance with providers like DeepSeek. No more checking web dashboards."],
      themes: ["Themes × styles, hundreds of looks", "12 color themes in light, night or follow-system mode, combined with several interface styles. Pick one in Settings and it applies instantly."],
      modes: ["Desktop mode or terminal mode", "Claude Code, Codex, OpenCode and Pi switch with one click on their launch card: a desktop chat view, or back to the native terminal."],
      changes: ["See every change", "The right panel lists every file the AI changed; open one for a line-by-line diff, green added and red removed. The sidebar color-codes each session's pull request."],
      tasks: ["To-do style prompts, one click to send", "Jot ideas into the task list on the right while the AI is busy, then send one with a click when it's free. Keep your favourite prompts ready too."]
    },
    zh: {
      split: ["拖拽分屏，最多四个会话同屏", "把侧栏里的会话直接拖到中间，就能左右或上下分屏。两个、三个、四个会话一起看，谁在干活一眼就知道。"],
      agents: ["一个主管，带一群帮手", "Claude Code 把大任务拆成几块，交给 DeepSeek Harness 等帮手同时去做。侧栏实时显示每个帮手的进度，做完自动打勾。"],
      usage: ["额度和余额，随时看得到", "输入框旁边直接显示当前工具还剩多少：Claude、Codex 的 5 小时和每周额度，DeepSeek 等服务商的账户余额，不用再去网页上查。"],
      themes: ["配色 × 形态，上百种个性界面", "12 种配色，白天、夜晚或跟随系统，再配上多种界面形态，组合出上百种样子。在设置里点一下，立刻生效。"],
      modes: ["桌面模式，或者终端模式", "Claude Code、Codex、OpenCode、Pi 在启动卡片上一键切换：喜欢聊天窗口就用桌面模式，习惯命令行就回到原生终端。"],
      changes: ["改了什么，一目了然", "右侧面板列出 AI 改过的每个文件，点开逐行对比：绿色是新增，红色是删除。侧栏还会用颜色标出每个会话的 PR 状态。"],
      tasks: ["ToDo 式预输入，一键发给 AI", "想到要做的事，先写进右侧的任务列表，等 AI 忙完，点一下就发过去。常用的提示词也能提前存好。"]
    },
    "zh-TW": {
      split: ["拖曳分割，最多四個會話同畫面", "把側欄裡的會話直接拖到中間，就能左右或上下分割。兩個、三個、四個會話一起看，誰在工作一眼就知道。"],
      agents: ["一個主管，帶一群幫手", "Claude Code 把大任務拆成幾塊，交給 DeepSeek Harness 等幫手同時去做。側欄即時顯示每個幫手的進度，完成自動打勾。"],
      usage: ["額度和餘額，隨時看得到", "輸入框旁邊直接顯示目前工具還剩多少：Claude、Codex 的 5 小時與每週額度，DeepSeek 等服務商的帳戶餘額，不用再上網頁查。"],
      themes: ["配色 × 形態，上百種個性介面", "12 種配色，白天、夜晚或跟隨系統，再搭配多種介面形態，組合出上百種樣子。在設定裡點一下，立即生效。"],
      modes: ["桌面模式，或是終端機模式", "Claude Code、Codex、OpenCode、Pi 在啟動卡片上一鍵切換：喜歡聊天視窗就用桌面模式，習慣命令列就回到原生終端機。"],
      changes: ["改了什麼，一目了然", "右側面板列出 AI 改過的每個檔案，點開逐行比對：綠色是新增，紅色是刪除。側欄還會用顏色標出每個會話的 PR 狀態。"],
      tasks: ["ToDo 式預輸入，一鍵送給 AI", "想到要做的事，先寫進右側的任務清單，等 AI 忙完，點一下就送過去。常用的提示詞也能預先存好。"]
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
      Object.assign(dict, HERO_COPY[lang], INSTALL_COPY[lang] || {});
      Object.keys(LABELS[lang] || {}).forEach(function (id) {
        dict["fxl-" + id] = LABELS[lang][id];
      });
      Object.keys(FEATURE_COPY[lang] || {}).forEach(function (id) {
        dict["ft-" + id + "-title"] = FEATURE_COPY[lang][id][0];
        dict["ft-" + id + "-body"] = FEATURE_COPY[lang][id][1];
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

  // Feature rows rise into place as they scroll into view (once each).
  // Without IntersectionObserver, or with reduced motion, they just show.
  function initReveal() {
    const rows = document.querySelectorAll("[data-reveal]");
    if (!rows.length || !("IntersectionObserver" in window)) return;
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        e.target.classList.add("is-in");
        io.unobserve(e.target);
      });
    }, { threshold: 0.18, rootMargin: "0px 0px -8% 0px" });
    rows.forEach(function (r) {
      r.classList.add("reveal");
      io.observe(r);
    });
  }

  // Tool strip: duplicate the list once (hidden from assistive tech) so the
  // CSS animation can slide by exactly half and loop without a seam.
  function initMarquee() {
    const track = document.querySelector(".tm-track");
    if (!track || track.dataset.cloned) return;
    track.dataset.cloned = "1";
    Array.prototype.slice.call(track.children).forEach(function (li) {
      const copy = li.cloneNode(true);
      copy.setAttribute("aria-hidden", "true");
      track.appendChild(copy);
    });
    track.classList.add("is-looping");
  }

  // Highlight the download button for the visitor's own OS (desktop only;
  // phones can't install it, so nothing is singled out there).
  function initPrimaryDownload() {
    const ua = navigator.userAgent || "";
    if (/iPhone|iPad|iPod|Android/i.test(ua)) return;
    const os = /Mac/i.test(ua) ? "macos" : /Win/i.test(ua) ? "windows" : /Linux/i.test(ua) ? "linux" : "";
    const btn = os && document.querySelector('.downloads-row .download-btn[data-platform="' + os + '"]');
    if (btn) btn.classList.add("is-primary");
  }

  function boot() {
    initPrimaryDownload();
    init();
    initMarquee();
    initReveal();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
