/**
 * main.js - Core Interactions
 * Smooth, lightweight vanilla javascript
 */

let currentLang = "en";

const LANG_LIST = {
  en: "English",
  zh: "简体中文",
  "zh-TW": "繁體中文",
  ja: "日本語",
  ko: "한국어",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  pt: "Português",
  ru: "Русский"
};

const userPrefLang = navigator.language || navigator.userLanguage;
const savedLang = localStorage.getItem("coffee-cli-lang");

if (savedLang && LANG_LIST[savedLang]) {
  currentLang = savedLang;
} else if (userPrefLang) {
  const langCode = userPrefLang.toLowerCase();
  if (langCode.includes("zh")) {
    currentLang = langCode.includes("tw") || langCode.includes("hk") ? "zh-TW" : "zh";
  } else if (langCode.startsWith("ja")) {
    currentLang = "ja";
  } else if (langCode.startsWith("ko")) {
    currentLang = "ko";
  } else if (langCode.startsWith("es")) {
    currentLang = "es";
  } else if (langCode.startsWith("fr")) {
    currentLang = "fr";
  } else if (langCode.startsWith("de")) {
    currentLang = "de";
  } else if (langCode.startsWith("pt")) {
    currentLang = "pt";
  } else if (langCode.startsWith("ru")) {
    currentLang = "ru";
  }
}

const I18N_DICT = {
  en: {
    "logo-text": "Coffee CLI",
    "hero-title-1": "Enjoy life while you work.",
    "hero-title-2": "Coffee CLI for",
    "opc-link": "Coffee 101",
    "feedback": "Feedback"
  },
  zh: {
    "logo-text": "Coffee CLI",
    "hero-title-1": "一边享受生活 一边工作",
    "hero-title-2": "Coffee CLI 适合",
    "opc-link": "Coffee 101",
    "feedback": "问题反馈"
  },
  "zh-TW": {
    "logo-text": "Coffee CLI",
    "hero-title-1": "一邊享受生活 一邊工作",
    "hero-title-2": "Coffee CLI 適用於",
    "opc-link": "Coffee 101",
    "feedback": "問題回饋"
  },
  ja: {
    "logo-text": "Coffee CLI",
    "hero-title-1": "生活を楽しみながら働く",
    "hero-title-2": "Coffee CLIは以下の方に",
    "opc-link": "Coffee 101",
    "feedback": "フィードバック"
  },
  ko: {
    "logo-text": "Coffee CLI",
    "hero-title-1": "삶을 즐기며 일하다",
    "hero-title-2": "Coffee CLI는 이런 분께",
    "opc-link": "Coffee 101",
    "feedback": "피드백"
  },
  es: {
    "logo-text": "Coffee CLI",
    "hero-title-1": "Disfruta la vida mientras trabajas",
    "hero-title-2": "Coffee CLI para",
    "opc-link": "Coffee 101",
    "feedback": "Comentarios"
  },
  fr: {
    "logo-text": "Coffee CLI",
    "hero-title-1": "Profitez de la vie tout en travaillant",
    "hero-title-2": "Coffee CLI pour",
    "opc-link": "Coffee 101",
    "feedback": "Retour"
  },
  de: {
    "logo-text": "Coffee CLI",
    "hero-title-1": "Genieße das Leben, während du arbeitest",
    "hero-title-2": "Coffee CLI für",
    "opc-link": "Coffee 101",
    "feedback": "Feedback"
  },
  pt: {
    "logo-text": "Coffee CLI",
    "hero-title-1": "Aproveite a vida enquanto trabalha",
    "hero-title-2": "Coffee CLI para",
    "opc-link": "Coffee 101",
    "feedback": "Feedback"
  },
  ru: {
    "logo-text": "Coffee CLI",
    "hero-title-1": "Наслаждайтесь жизнью, работая",
    "hero-title-2": "Coffee CLI для",
    "opc-link": "Coffee 101",
    "feedback": "Обратная связь"
  }
};

const T_WORDS_LOCALE = {
  en: [
    "CFOs", "Product Managers", "UI/UX Designers", "Marketers", "Data Analysts",
    "Sales Executives", "Content Creators", "Operations Specialists", "HR Professionals", "Administrative Assistants",
    "Customer Support", "Freelance Writers", "E-commerce Managers", "Social Media Managers", "Legal Advisors",
    "Copywriters", "Illustrators", "Procurement Officers", "Accountants", "Investment Analysts"
  ],
  zh: [
    "企业高管", "产品经理", "UI/UX 设计师", "市场销售", "数据分析师",
    "销售总监", "自媒体创作者", "活动运营专员", "HR专员", "行政管理",
    "客服代表", "独立撰稿人", "电商掌柜", "社媒主理人", "法务顾问",
    "文案策划", "原画师", "采购专员", "会计师", "投资分析师"
  ],
  "zh-TW": [
    "企業高層", "產品經理", "UI/UX 設計師", "市場行銷", "資料分析師",
    "銷售總監", "自媒體創作者", "活動運營專員", "HR專員", "行政管理",
    "客服代表", "自由撰稿人", "電商掌櫃", "社媒主理人", "法務顧問",
    "文案策劃", "原畫師", "採購專員", "會計師", "投資分析師"
  ],
  ja: [
    "CFO", "プロダクトマネージャー", "UI/UXデザイナー", "マーケティング", "データアナリスト",
    "セールスマネージャー", "コンテンツクリエイター", "運営の専門家", "人事の専門家", "総務",
    "カスタマーサポート", "フリーライター", " ECSマ...", "SNS...", "法務アドバイザー",
    "コピーライター", "イラストレーター", "調達担当者", "会計士", "投資アナリスト"
  ],
  ko: [
    "CFO", "프로덕트 매니저", "UI/UX 디자이너", "마케터", "데이터 분석가",
    "영업 관리자", "콘텐츠 크리에이터", "운영 전문가", "인사 전문가", "총무",
    "고객 지원", "프리랜서 라이터", "이커머스 관리자", "SNS 관리자", "법률 상담사",
    "카피라이터", "일러스트레이터", "조달 담당자", "회계사", "투자 분석가"
  ],
  es: [
    "Directores Financieros", "Gerentes de Producto", "Diseñadores UI/UX", "Marketing", "Analistas de Datos",
    "Ejecutivos de Ventas", "Creadores de Contenido", "Especialistas en Operaciones", "Profesionales de RRHH", "Asistentes Administrativos",
    "Soporte al Cliente", "Escritores Freelance", "Gerentes de E-commerce", "Gerentes de Redes Sociales", "Asesores Legales",
    "Redactores", "Ilustradores", "Oficiales de Compras", "Contadores", "Analistas de Inversiones"
  ],
  fr: [
    "Directeurs Financiers", "Chefs de Produit", "Designers UI/UX", "Marketers", "Analystes de Données",
    "Directeurs des Ventes", "Créateurs de Contenu", "Spécialistes des Opérations", "Professionnels RH", "Assistant(e)s Administratif(ve)s",
    "Support Client", "Rédacteurs Freelance", "Managers E-commerce", "Gestionnaires de Réseaux Sociaux", "Conseillers Juridiques",
    "Copywriters", "Illustrateurs", "Officiers d'Approvisionnement", "Comptables", "Analystes d'Investissement"
  ],
  de: [
    "CFOs", "Produktmanager", "UI/UX Designer", "Marktforscher", "Datenanalysten",
    "Vertriebsleiter", "Inhaltsersteller", "Betriebsspezialisten", "HR-Fachleute", "Verwaltungsassistenten",
    "Kundensupport", "Freie Texter", "E-Commerce-Manager", "Social-Media-Manager", "Rechtsberater",
    "Texter", "Illustratoren", "Beschaffungsbeauftragte", "Buchhalter", "Investitionsanalysten"
  ],
  pt: [
    "CFOs", "Gerentes de Produto", "Designers UI/UX", "Marketeers", "Analistas de Dados",
    "Executivos de Vendas", "Criadores de Conteúdo", "Especialistas em Operações", "Profissionais de RH", "Assistentes Administrativos",
    "Atendimento ao Cliente", "Escritores Freelance", "Gerentes de E-commerce", "Gerentes de Redes Sociais", "Consultores Jurídicos",
    "Redatores", "Ilustradores", "Oficiais de Suprimentos", "Contadores", "Analistas de Investimento"
  ],
  ru: [
    "Финансовые директора", "Проджект-менеджеры", "UI/UX дизайнеры", "Маркетологи", "Аналитики данных",
    "Руководители продаж", "Контент-креаторы", "Специалисты по операциям", "HR профессионалы", "Административные ассистенты",
    "Поддержка клиентов", "Фриланс-писатели", "E-commerce менеджеры", "SMM менеджеры", "Юридические консультанты",
    "Копирайтеры", "Иллюстраторы", "Закупщики", "Бухгалтеры", "Инвестиционные аналитики"
  ]
};

let T_WORDS = T_WORDS_LOCALE[currentLang] || T_WORDS_LOCALE.en;

function initTheme() {
  const toggleBtn = document.getElementById("theme-toggle");
  const svgIcon = toggleBtn ? toggleBtn.querySelector("svg") : null;
  
  const moonPath = "M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z";
  const sunPath = "M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41M12 17a5 5 0 1 1 0-10 5 5 0 0 1 0 10Z";

  const savedTheme = localStorage.getItem("coffee-cli-theme");
  const systemPrefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const initialTheme = savedTheme ? savedTheme : (systemPrefersDark ? "dark" : "light");
  
  const updateIcon = (theme) => {
    if (svgIcon) {
      svgIcon.innerHTML = `<path d="${theme === 'dark' ? sunPath : moonPath}"></path>`;
    }
  };

  document.documentElement.setAttribute("data-theme", initialTheme);
  updateIcon(initialTheme);
  
  if (toggleBtn) {
    toggleBtn.addEventListener("click", () => {
      let isDark = document.documentElement.getAttribute("data-theme") === "dark";
      let newTheme = isDark ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", newTheme);
      localStorage.setItem("coffee-cli-theme", newTheme);
      updateIcon(newTheme);
    });
  }
}

document.addEventListener("DOMContentLoaded", () => {
  initTheme();
  initTypewriter();
  initInstallationTabs();
  initI18N();
  initLangDropdown();
  initDemoTabs();
});

const T_TYPING_SPEED = 100;
const T_ERASING_SPEED = 50;
const T_PAUSE_END_WORD = 2000;
const T_PAUSE_BEFORE_NEXT = 500;

let currentWordIndex = 0;
let currentCharIndex = 0;
let isDeleting = false;
let typeElement = document.getElementById("typewriter");

function initTypewriter() {
  if (!typeElement) return;
  setTimeout(typeLoop, 500);
}

function typeLoop() {
  T_WORDS = T_WORDS_LOCALE[currentLang] || T_WORDS_LOCALE.en;

  if (currentWordIndex >= T_WORDS.length) {
    currentWordIndex = 0;
  }

  const currentWord = T_WORDS[currentWordIndex];

  if (isDeleting) {
    typeElement.textContent = currentWord.substring(0, currentCharIndex - 1);
    currentCharIndex--;
  } else {
    typeElement.textContent = currentWord.substring(0, currentCharIndex + 1);
    currentCharIndex++;
  }

  let loopTimeout = isDeleting ? T_ERASING_SPEED : T_TYPING_SPEED;

  if (!isDeleting && currentCharIndex === currentWord.length) {
    loopTimeout = T_PAUSE_END_WORD;
    isDeleting = true;
  } else if (isDeleting && currentCharIndex === 0) {
    isDeleting = false;
    currentWordIndex++;
    if (currentWordIndex === T_WORDS.length) {
      currentWordIndex = 0;
    }
    loopTimeout = T_PAUSE_BEFORE_NEXT;
  }

  let naturalVariance = Math.random() * 40 - 20;
  setTimeout(typeLoop, loopTimeout + (isDeleting ? 0 : naturalVariance));
}

const INSTALL_DATA = {
  en: {
    windows: { hint: "Right-click Start > Terminal (Admin) > Paste:", command: "iwr -useb https://coffeecli.com/install.ps1 | iex" },
    macos: { hint: "Open Terminal.app and paste the following:", command: "curl -fsSL https://coffeecli.com/install.sh | bash" },
    linux: { hint: "For any modern Linux distribution, run:", command: "curl -fsSL https://coffeecli.com/install.sh | bash" }
  },
  zh: {
    windows: { hint: "右键单击 开始菜单 > 选择“终端管理员” > 粘贴执行:", command: "iwr -useb https://coffeecli.com/install.ps1 | iex" },
    macos: { hint: "利用 Spotlight 或 Launchpad 启动终端，粘贴并在其中执行:", command: "curl -fsSL https://coffeecli.com/install.sh | bash" },
    linux: { hint: "打开您的日常终端引擎，执行此快速部署脚本:", command: "curl -fsSL https://coffeecli.com/install.sh | bash" }
  },
  "zh-TW": {
    windows: { hint: "右鍵單擊 開始菜單 > 選擇「終端機管理員」 > 貼上執行:", command: "iwr -useb https://coffeecli.com/install.ps1 | iex" },
    macos: { hint: "利用 Spotlight 或 Launchpad 啟動終端機，貼上並執行:", command: "curl -fsSL https://coffeecli.com/install.sh | bash" },
    linux: { hint: "打開您的日常終端引擎，執行此快速部署腳本:", command: "curl -fsSL https://coffeecli.com/install.sh | bash" }
  },
  ja: {
    windows: { hint: "スタートメニューを右クリック > Terminal(Admin) > 貼り付け:", command: "iwr -useb https://coffeecli.com/install.ps1 | iex" },
    macos: { hint: "Terminal.appを開いて以下のコマンドを貼り付け:", command: "curl -fsSL https://coffeecli.com/install.sh | bash" },
    linux: { hint: "ターミナルを開いて以下のコマンドを実行:", command: "curl -fsSL https://coffeecli.com/install.sh | bash" }
  },
  ko: {
    windows: { hint: "시작 메뉴 우 클릭 > 터미널(관리자) > 붙여넣기:", command: "iwr -useb https://coffeecli.com/install.ps1 | iex" },
    macos: { hint: "Terminal.app을 열고 다음 명령어를 붙여넣기:", command: "curl -fsSL https://coffeecli.com/install.sh | bash" },
    linux: { hint: "터미널을 열고 다음 명령어 실행:", command: "curl -fsSL https://coffeecli.com/install.sh | bash" }
  },
  es: {
    windows: { hint: "Clic derecho en Inicio > Terminal (Admin) > Pegar:", command: "iwr -useb https://coffeecli.com/install.ps1 | iex" },
    macos: { hint: "Abre Terminal.app y pega el siguiente comando:", command: "curl -fsSL https://coffeecli.com/install.sh | bash" },
    linux: { hint: "Para cualquier distribución moderna de Linux, ejecuta:", command: "curl -fsSL https://coffeecli.com/install.sh | bash" }
  },
  fr: {
    windows: { hint: "Clic droit sur Démarrer > Terminal (Admin) > Coller:", command: "iwr -useb https://coffeecli.com/install.ps1 | iex" },
    macos: { hint: "Ouvrez Terminal.app et collez la commande suivante:", command: "curl -fsSL https://coffeecli.com/install.sh | bash" },
    linux: { hint: "Pour toute distribution Linux moderne, exécutez:", command: "curl -fsSL https://coffeecli.com/install.sh | bash" }
  },
  de: {
    windows: { hint: "Rechtsklick auf Start > Terminal (Admin) > Einfügen:", command: "iwr -useb https://coffeecli.com/install.ps1 | iex" },
    macos: { hint: "Öffnen Sie Terminal.app und fügen Sie folgenden Befehl ein:", command: "curl -fsSL https://coffeecli.com/install.sh | bash" },
    linux: { hint: "Für jede moderne Linux-Distribution ausführen:", command: "curl -fsSL https://coffeecli.com/install.sh | bash" }
  },
  pt: {
    windows: { hint: "Clique direito no Iniciar > Terminal (Admin) > Colar:", command: "iwr -useb https://coffeecli.com/install.ps1 | iex" },
    macos: { hint: "Abra o Terminal.app e cole o seguinte comando:", command: "curl -fsSL https://coffeecli.com/install.sh | bash" },
    linux: { hint: "Para qualquer distribuição Linux moderna, execute:", command: "curl -fsSL https://coffeecli.com/install.sh | bash" }
  },
  ru: {
    windows: { hint: "Щелкните правой кнопкой Пуск > Терминал (Администратор) > Вставить:", command: "iwr -useb https://coffeecli.com/install.ps1 | iex" },
    macos: { hint: "Откройте Terminal.app и вставьте следующую команду:", command: "curl -fsSL https://coffeecli.com/install.sh | bash" },
    linux: { hint: "Для любого современного дистрибутива Linux выполните:", command: "curl -fsSL https://coffeecli.com/install.sh | bash" }
  }
};

function initInstallationTabs() {
  const tabs = document.querySelectorAll(".tab-btn");
  const hintDisplay = document.getElementById("install-hint");
  const cmdDisplay = document.getElementById("install-command");
  const copyBtn = document.getElementById("copy-btn");

  const updateContent = (platform) => {
    const langData = INSTALL_DATA[currentLang] || INSTALL_DATA.en;
    const currentConfig = langData[platform];
    if (currentConfig) {
      cmdDisplay.style.opacity = 0;
      hintDisplay.style.opacity = 0;
      setTimeout(() => {
        hintDisplay.textContent = currentConfig.hint;
        cmdDisplay.textContent = currentConfig.command;
        cmdDisplay.style.opacity = 1;
        hintDisplay.style.opacity = 1;
      }, 150);
    }
  };

  tabs.forEach(tab => {
    tab.addEventListener("click", (e) => {
      tabs.forEach(t => t.classList.remove("active"));
      e.target.classList.add("active");
      const platform = e.target.getAttribute("data-platform");
      updateContent(platform);
    });
  });

  cmdDisplay.style.transition = "opacity 0.15s ease";
  hintDisplay.style.transition = "opacity 0.15s ease";

  copyBtn.addEventListener("click", () => {
    const textToCopy = cmdDisplay.textContent;
    navigator.clipboard.writeText(textToCopy).then(() => {
      const originalHTML = copyBtn.innerHTML;
      copyBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#27C93F" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
      `;
      setTimeout(() => {
        copyBtn.innerHTML = originalHTML;
      }, 2000);
    });
  });
}

function initLangDropdown() {
  const dropdown = document.getElementById("lang-dropdown");
  const toggle = document.getElementById("lang-toggle");
  if (!dropdown || !toggle) return;

  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    dropdown.classList.toggle("active");
  });

  // Event delegation: handle all lang-option clicks at the container level
  dropdown.addEventListener("click", (e) => {
    e.stopPropagation();
    const option = e.target.closest(".lang-option");
    if (!option) return;

    const lang = option.dataset.lang;
    if (lang) {
      currentLang = lang;
      localStorage.setItem("coffee-cli-lang", lang);
      T_WORDS = T_WORDS_LOCALE[lang] || T_WORDS_LOCALE.en;
      renderI18N();
      dropdown.classList.remove("active");
    }
  });

  document.addEventListener("click", () => {
    dropdown.classList.remove("active");
  });
}

function renderI18N() {
  document.querySelectorAll("[data-i18n]").forEach(el => {
    const key = el.getAttribute("data-i18n");
    const dict = I18N_DICT[currentLang] || I18N_DICT.en;
    if (dict[key]) {
      el.innerHTML = dict[key];
    }
  });

  const toggle = document.getElementById("lang-toggle");
  if (toggle) {
    const shortLang = currentLang.split("-")[0];
    toggle.textContent = shortLang.toUpperCase();
  }

  const dropdown = document.getElementById("lang-dropdown");
  if (dropdown) {
    dropdown.querySelectorAll(".lang-option").forEach(opt => {
      opt.classList.toggle("selected", opt.dataset.lang === currentLang);
    });
  }

  // Refresh demo tab labels and active description
  refreshDemoLang();

  // Refresh the install command for the current tab (direct call, no .click())
  const activeTab = document.querySelector(".tab-btn.active");
  if (activeTab) {
    const platform = activeTab.getAttribute("data-platform");
    const langData = INSTALL_DATA[currentLang] || INSTALL_DATA.en;
    const config = langData[platform];
    const hintDisplay = document.getElementById("install-hint");
    const cmdDisplay = document.getElementById("install-command");
    if (config && hintDisplay && cmdDisplay) {
      hintDisplay.textContent = config.hint;
      cmdDisplay.textContent = config.command;
    }
  }
}

function initI18N() {
  renderI18N();
}

const DEMO_DATA = {
  en: [
    { label: "Themes",     title: "Theme Switching",    desc: "Switch between built-in themes instantly. The entire interface — including your active terminal session — updates live. No restart, no flicker." },
    { label: "Task Board", title: "Task Board",          desc: "Keep track of everything your agent is doing. Organize work into To-Do, In Progress, and Done — right in the sidebar, while the agent runs." },
    { label: "History",    title: "Session History",     desc: "Every agent session is automatically saved. Scroll back, search, and resume any past conversation exactly where you left off." },
    { label: "Multi-Tab",  title: "Multi-Tab Sessions",  desc: "Run multiple agents and terminals in parallel, each fully isolated. Vibe-code in one tab, run a game in another — zero interference." },
    { label: "Languages",  title: "11 Languages",        desc: "Coffee CLI speaks your language — literally. Switch the entire interface to English, 简体中文, 繁體中文, 日本語, 한국어, Español, Français, Deutsch, Português, Русский, or Tiếng Việt. No English required." },
    { label: "Wallpaper",  title: "Custom Wallpapers",   desc: "Make Coffee CLI yours. Drop in any image or animated video as your background — your workspace, your vibe." }
  ],
  zh: [
    { label: "主题",     title: "主题切换",       desc: "一键切换内置主题，整个界面——包括活跃的终端会话——实时更新，无需重启，不会闪烁。" },
    { label: "任务看板", title: "任务看板",       desc: "追踪 Agent 正在做的一切。在侧边栏将任务整理为待办、进行中、已完成——Agent 工作时一目了然。" },
    { label: "历史记录", title: "会话历史",       desc: "每次 Agent 会话都自动保存。滚动回溯、搜索关键词，随时从上次中断的地方继续。" },
    { label: "多 Tab",   title: "多 Tab 会话",   desc: "同时运行多个 Agent 和终端，每个完全独立。一个 Tab 做 Vibe Coding，另一个跑游戏——互不干扰。" },
    { label: "多语言",   title: "11 种语言",     desc: "Coffee CLI 真正说你的语言。一键将整个界面切换为英语、简体中文、繁體中文、日本語、한국어、Español、Français、Deutsch、Português、Русский 或 Tiếng Việt。不需要懂英语。" },
    { label: "壁纸",     title: "自定义壁纸",     desc: "让 Coffee CLI 属于你。任意图片或动态视频都能作为背景——你的工作台，你的氛围。" }
  ],
  "zh-TW": [
    { label: "主題",       title: "主題切換",         desc: "一鍵切換內建主題，整個介面——包括活躍的終端工作階段——即時更新，無需重啟，不會閃爍。" },
    { label: "任務看板",   title: "任務看板",         desc: "追蹤 Agent 正在做的一切。在側邊欄將任務整理為待辦、進行中、已完成——Agent 工作時一目了然。" },
    { label: "歷史記錄",   title: "工作階段歷史",     desc: "每次 Agent 工作階段都自動儲存。捲動回顧、搜尋關鍵字，隨時從上次中斷的地方繼續。" },
    { label: "多 Tab",     title: "多 Tab 工作階段", desc: "同時執行多個 Agent 和終端機，每個完全獨立。一個 Tab 做 Vibe Coding，另一個跑遊戲——互不干擾。" },
    { label: "多語言",     title: "11 種語言",       desc: "Coffee CLI 真正說你的語言。一鍵將整個介面切換為英語、简体中文、繁體中文、日本語、한국어、Español、Français、Deutsch、Português、Русский 或 Tiếng Việt。不需要懂英語。" },
    { label: "桌布",       title: "自訂桌布",         desc: "讓 Coffee CLI 成為你的。任意圖片或動態影片都能作為背景——你的工作台，你的氛圍。" }
  ],
  ja: [
    { label: "テーマ",       title: "テーマ切替",           desc: "内蔵テーマをワンクリックで切り替え。アクティブなターミナルセッションを含むインターフェース全体がリアルタイムで更新されます。" },
    { label: "タスクボード", title: "タスクボード",         desc: "エージェントの作業をすべて把握。サイドバーでタスクをTODO・進行中・完了に整理できます。エージェントが動いている間も常に見通せます。" },
    { label: "履歴",         title: "セッション履歴",       desc: "すべてのエージェントセッションが自動保存されます。スクロールして過去を振り返り、検索し、中断した場所から再開できます。" },
    { label: "マルチタブ",   title: "マルチタブセッション", desc: "複数のエージェントとターミナルを並列で実行。各タブは完全独立。一方でバイブコーディング、もう一方でゲーム実行——相互干渉ゼロ。" },
    { label: "多言語",       title: "11言語対応",           desc: "Coffee CLI はあなたの言語を話します。インターフェース全体を英語、简体中文、繁體中文、日本語、한국어、Español、Français、Deutsch、Português、Русский、Tiếng Việt に切り替え可能。英語不要。" },
    { label: "壁紙",         title: "カスタム壁紙",         desc: "Coffee CLI をあなた色に。画像でも動画でも、お好きなものを背景に——あなたの作業空間、あなたのムード。" }
  ],
  ko: [
    { label: "테마",     title: "테마 전환",       desc: "내장 테마를 즉시 전환하세요. 활성 터미널 세션을 포함한 전체 인터페이스가 실시간으로 업데이트됩니다. 재시작 없이, 깜박임도 없이." },
    { label: "작업 보드", title: "작업 보드",       desc: "에이전트가 하는 모든 작업을 추적하세요. 에이전트가 실행되는 동안 사이드바에서 할 일, 진행 중, 완료로 작업을 정리할 수 있습니다." },
    { label: "기록",     title: "세션 기록",       desc: "모든 에이전트 세션이 자동으로 저장됩니다. 스크롤하여 과거를 돌아보고, 검색하고, 중단한 곳에서 정확히 다시 시작하세요." },
    { label: "멀티탭",   title: "멀티탭 세션",     desc: "여러 에이전트와 터미널을 병렬로 실행하세요. 각 탭은 완전히 독립적입니다. 한 탭에서 바이브 코딩, 다른 탭에서 게임 — 완전한 격리." },
    { label: "다국어",   title: "11개 언어",       desc: "Coffee CLI는 당신의 언어를 말합니다. 전체 인터페이스를 영어, 简体中文, 繁體中文, 日本語, 한국어, Español, Français, Deutsch, Português, Русский, Tiếng Việt 로 전환하세요. 영어 불필요." },
    { label: "배경",     title: "맞춤 배경화면",     desc: "Coffee CLI를 당신의 것으로. 이미지든 동영상이든 원하는 것을 배경으로 — 당신의 작업 공간, 당신의 분위기." }
  ],
  es: [
    { label: "Temas",       title: "Cambio de Tema",        desc: "Cambia entre temas integrados al instante. Toda la interfaz — incluida tu sesión de terminal activa — se actualiza en tiempo real. Sin reinicios ni parpadeos." },
    { label: "Tareas",      title: "Tablero de Tareas",     desc: "Controla todo lo que hace tu agente. Organiza las tareas en Pendiente, En Progreso y Completado — en la barra lateral mientras el agente trabaja." },
    { label: "Historial",   title: "Historial de Sesiones", desc: "Cada sesión del agente se guarda automáticamente. Desplázate, busca y retoma cualquier conversación pasada exactamente donde la dejaste." },
    { label: "Multi-Tab",   title: "Sesiones Multi-Pestaña", desc: "Ejecuta múltiples agentes y terminales en paralelo, cada uno completamente aislado. Vibe-coding en una pestaña, un juego en otra — sin interferencias." },
    { label: "Idiomas",     title: "11 Idiomas",             desc: "Coffee CLI habla tu idioma — literalmente. Cambia toda la interfaz a inglés, 简体中文, 繁體中文, 日本語, 한국어, Español, Français, Deutsch, Português, Русский o Tiếng Việt. Sin inglés necesario." },
    { label: "Fondo",       title: "Fondos Personalizados",  desc: "Haz tuyo Coffee CLI. Usa cualquier imagen o vídeo animado como fondo — tu espacio de trabajo, tu ambiente." }
  ],
  fr: [
    { label: "Thèmes",      title: "Changement de Thème",    desc: "Changez de thème instantanément. Toute l'interface — y compris votre session de terminal active — se met à jour en temps réel. Sans redémarrage ni scintillement." },
    { label: "Tâches",      title: "Tableau de Tâches",      desc: "Suivez tout ce que fait votre agent. Organisez les tâches en À faire, En cours et Terminé — dans la barre latérale pendant que l'agent travaille." },
    { label: "Historique",  title: "Historique des Sessions", desc: "Chaque session d'agent est automatiquement sauvegardée. Faites défiler, recherchez et reprenez n'importe quelle conversation passée là où vous l'aviez laissée." },
    { label: "Multi-Onglet", title: "Sessions Multi-Onglets", desc: "Exécutez plusieurs agents et terminaux en parallèle, chacun complètement isolé. Vibe-coding dans un onglet, un jeu dans un autre — zéro interférence." },
    { label: "Langues",      title: "11 Langues",             desc: "Coffee CLI parle votre langue — littéralement. Basculez toute l'interface en anglais, 简体中文, 繁體中文, 日本語, 한국어, Español, Français, Deutsch, Português, Русский ou Tiếng Việt. Sans anglais requis." },
    { label: "Fond",         title: "Fonds Personnalisés",    desc: "Coffee CLI à votre image. Utilisez n'importe quelle image ou vidéo animée comme fond — votre espace, votre ambiance." }
  ],
  de: [
    { label: "Themen",      title: "Thema wechseln",        desc: "Wechseln Sie sofort zwischen integrierten Themen. Die gesamte Oberfläche — einschließlich Ihrer aktiven Terminal-Sitzung — aktualisiert sich in Echtzeit. Kein Neustart, kein Flackern." },
    { label: "Aufgaben",    title: "Aufgaben-Board",        desc: "Behalten Sie alles im Blick, was Ihr Agent tut. Organisieren Sie Aufgaben in Offen, In Bearbeitung und Erledigt — in der Seitenleiste, während der Agent läuft." },
    { label: "Verlauf",     title: "Sitzungsverlauf",       desc: "Jede Agenten-Sitzung wird automatisch gespeichert. Scrollen, suchen und jedes vergangene Gespräch genau dort fortsetzen, wo Sie aufgehört haben." },
    { label: "Multi-Tab",   title: "Multi-Tab-Sitzungen",   desc: "Mehrere Agenten und Terminals parallel ausführen, jedes vollständig isoliert. Vibe-Coding in einem Tab, ein Spiel in einem anderen — keine gegenseitige Beeinflussung." },
    { label: "Sprachen",    title: "11 Sprachen",           desc: "Coffee CLI spricht Ihre Sprache — buchstäblich. Wechseln Sie die gesamte Oberfläche zu Englisch, 简体中文, 繁體中文, 日本語, 한국어, Español, Français, Deutsch, Português, Русский oder Tiếng Việt. Kein Englisch erforderlich." },
    { label: "Hintergrund", title: "Eigene Hintergründe",    desc: "Machen Sie Coffee CLI zu Ihrem eigenen. Verwenden Sie ein Bild oder animiertes Video als Hintergrund — Ihr Arbeitsbereich, Ihre Stimmung." }
  ],
  pt: [
    { label: "Temas",       title: "Troca de Tema",          desc: "Alterne entre temas integrados instantaneamente. Toda a interface — incluindo sua sessão de terminal ativa — é atualizada em tempo real. Sem reinicialização, sem cintilação." },
    { label: "Tarefas",     title: "Quadro de Tarefas",      desc: "Acompanhe tudo o que seu agente está fazendo. Organize tarefas em A Fazer, Em Andamento e Concluído — na barra lateral enquanto o agente trabalha." },
    { label: "Histórico",   title: "Histórico de Sessões",   desc: "Cada sessão do agente é salva automaticamente. Role, pesquise e retome qualquer conversa passada exatamente de onde parou." },
    { label: "Multi-Aba",   title: "Sessões Multi-Aba",      desc: "Execute múltiplos agentes e terminais em paralelo, cada um completamente isolado. Vibe-coding em uma aba, um jogo em outra — zero interferência." },
    { label: "Idiomas",     title: "11 Idiomas",             desc: "Coffee CLI fala o seu idioma — literalmente. Mude toda a interface para inglês, 简体中文, 繁體中文, 日本語, 한국어, Español, Français, Deutsch, Português, Русский ou Tiếng Việt. Sem inglês necessário." },
    { label: "Papel Parede", title: "Papel de Parede Personalizado", desc: "Torne o Coffee CLI seu. Use qualquer imagem ou vídeo animado como fundo — seu espaço, seu clima." }
  ],
  ru: [
    { label: "Темы",        title: "Смена темы",               desc: "Переключайтесь между встроенными темами мгновенно. Весь интерфейс — включая активную сессию терминала — обновляется в реальном времени. Без перезапуска и мерцания." },
    { label: "Задачи",      title: "Доска задач",              desc: "Отслеживайте всё, что делает ваш агент. Организуйте задачи в «К выполнению», «В работе» и «Готово» — прямо на боковой панели, пока агент работает." },
    { label: "История",     title: "История сессий",           desc: "Каждая сессия агента сохраняется автоматически. Прокручивайте, ищите и возобновляйте любой прошлый разговор точно с того места, где остановились." },
    { label: "Мультитаб",   title: "Мультивкладочные сессии",  desc: "Запускайте несколько агентов и терминалов параллельно, каждый полностью изолирован. Vibe-кодинг в одной вкладке, игра в другой — никаких помех." },
    { label: "Языки",       title: "11 языков",                desc: "Coffee CLI говорит на вашем языке — буквально. Переключите весь интерфейс на английский, 简体中文, 繁體中文, 日本語, 한국어, Español, Français, Deutsch, Português, Русский или Tiếng Việt. Английский не нужен." },
    { label: "Обои",        title: "Собственные обои",         desc: "Сделайте Coffee CLI своим. Любое изображение или анимированное видео в качестве фона — ваше рабочее место, ваша атмосфера." }
  ]
};

function refreshDemoLang() {
  const tabs = document.querySelectorAll(".demo-tab");
  const title = document.getElementById("demo-title");
  const desc = document.getElementById("demo-desc");
  if (!tabs.length) return;

  const data = DEMO_DATA[currentLang] || DEMO_DATA.en;

  let hasActive = false;
  tabs.forEach((tab, i) => {
    if (!data[i]) return;
    const span = tab.querySelector("span");
    if (span) span.textContent = data[i].label;
    if (tab.classList.contains("active") && title && desc) {
      title.textContent = data[i].title;
      desc.textContent = data[i].desc;
      hasActive = true;
    }
  });

  // Welcome state (no tab active) → fall back to wallpaper copy
  const fallback = data[5];
  if (!hasActive && title && desc && fallback) {
    title.textContent = fallback.title;
    desc.textContent = fallback.desc;
  }
}

function initDemoTabs() {
  const tabs = document.querySelectorAll(".demo-tab");
  const gif = document.getElementById("demo-gif");
  const loading = document.getElementById("demo-loading");
  const title = document.getElementById("demo-title");
  const desc = document.getElementById("demo-desc");
  if (!tabs.length || !gif) return;

  // Tracks the most recent requested src — stale callbacks are silently dropped
  let pendingSrc = null;

  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => {
      if (tab.classList.contains("active")) return;

      tabs.forEach(t => t.classList.remove("active"));
      tab.classList.add("active");

      const newSrc = tab.dataset.gif;
      pendingSrc = newSrc;

      // Fade out current GIF, show coffee cup loading overlay
      gif.classList.add("fading");
      title.classList.add("fading");
      desc.classList.add("fading");
      if (loading) loading.classList.add("visible");

      // Preload in a hidden Image — only commit to DOM when fully downloaded
      const loader = new Image();
      loader.onload = () => {
        if (pendingSrc !== newSrc) return; // a newer click took over, discard
        const data = DEMO_DATA[currentLang] || DEMO_DATA.en;
        gif.src = newSrc;
        title.textContent = data[i] ? data[i].title : tab.dataset.title;
        desc.textContent = data[i] ? data[i].desc : tab.dataset.desc;
        gif.classList.remove("fading");
        title.classList.remove("fading");
        desc.classList.remove("fading");
        if (loading) loading.classList.remove("visible");
      };
      loader.onerror = () => {
        if (pendingSrc !== newSrc) return;
        // GIF failed to load — still update and clear loading state gracefully
        gif.src = newSrc;
        gif.classList.remove("fading");
        title.classList.remove("fading");
        desc.classList.remove("fading");
        if (loading) loading.classList.remove("visible");
      };
      loader.src = newSrc;
    });
  });
}