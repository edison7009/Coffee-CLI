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
    "page-title": "Coffee CLI - The Native AI Companion",
    "logo-text": "Coffee CLI",
    "hero-title-1": "Enjoy life while you work.",
    "hero-title-2": "Coffee CLI for",
    "hero-subtitle": "Tailor-made for you, no coding or English required.",
    "opc-link": "Coffee OPC University"
  },
  zh: {
    "page-title": "咖啡办公 - 你的原生桌面 AI 伴侣",
    "logo-text": "咖啡办公",
    "hero-title-1": "一边享受生活 一边工作",
    "hero-title-2": "咖啡办公适合",
    "hero-subtitle": "为不懂代码、英文不好的你量身打造",
    "opc-link": "咖啡一人公司大学"
  },
  "zh-TW": {
    "page-title": "咖啡辦公 - 原生 AI 伴侶",
    "logo-text": "咖啡辦公",
    "hero-title-1": "一邊享受生活 一邊工作",
    "hero-title-2": "咖啡辦公適用於",
    "hero-subtitle": "為不懂程式設計英文不好的您量身打造",
    "opc-link": "Coffee OPC 大學"
  },
  ja: {
    "page-title": "コーヒーオフィス - ネイティブ AI コンパニオン",
    "logo-text": "コーヒーオフィス",
    "hero-title-1": "生活を楽しみながら働く",
    "hero-title-2": "コーヒーオフィスは以下の方に",
    "hero-subtitle": "コーディングも英語も不要。为您量身打造。",
    "opc-link": "Coffee OPC 大学"
  },
  ko: {
    "page-title": "커피 오피스 - 네이티브 AI 동반자",
    "logo-text": "커피 오피스",
    "hero-title-1": "삶을 즐기며 일하다",
    "hero-title-2": "커피 오피스는 이런 분께",
    "hero-subtitle": "코딩이나 영어 없이 나만을 위해 맞춤화되었습니다.",
    "opc-link": "Coffee OPC 대학"
  },
  es: {
    "page-title": "Coffee Office - El compañero nativo de IA",
    "logo-text": "Coffee Office",
    "hero-title-1": "Disfruta la vida mientras trabajas",
    "hero-title-2": "Coffee Office para",
    "hero-subtitle": "Hecho a tu medida, sin código ni inglés necesarios.",
    "opc-link": "Universidad Coffee OPC"
  },
  fr: {
    "page-title": "Coffee Office - Le compagnon IA natif",
    "logo-text": "Coffee Office",
    "hero-title-1": "Profitez de la vie tout en travaillant",
    "hero-title-2": "Coffee Office pour",
    "hero-subtitle": "Conçu pour vous, sans code ni anglais requis.",
    "opc-link": "Université Coffee OPC"
  },
  de: {
    "page-title": "Coffee Office - Der native KI-Begleiter",
    "logo-text": "Coffee Office",
    "hero-title-1": "Genieße das Leben, während du arbeitest",
    "hero-title-2": "Coffee Office für",
    "hero-subtitle": "Für Sie gemacht, kein Code oder Englisch erforderlich.",
    "opc-link": "Coffee OPC Universität"
  },
  pt: {
    "page-title": "Coffee Office - O companheiro nativo de IA",
    "logo-text": "Coffee Office",
    "hero-title-1": "Aproveite a vida enquanto trabalha",
    "hero-title-2": "Coffee Office para",
    "hero-subtitle": "Feito sob medida para você, sem código ou inglês necessários.",
    "opc-link": "Universidade Coffee OPC"
  },
  ru: {
    "page-title": "Coffee Office - Нативный ИИ-компаньон",
    "logo-text": "Coffee Office",
    "hero-title-1": "Наслаждайтесь жизнью, работая",
    "hero-title-2": "Coffee Office для",
    "hero-subtitle": "Создано для вас, без программирования и английского.",
    "opc-link": "Университет Coffee OPC"
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
    "���售��監", "自媒體創作者", "活動運營專員", "HR專員", "行政管理",
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
    "Финансовые директора", "Проджект-менеджеры", "UI/UX дизайнеры", "Марке��ол��ги", "Аналитики данных",
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
    windows: { hint: "右键单击 开始菜单 > 选择“终端(管理员)” > 粘贴执行:", command: "iwr -useb https://coffeecli.com/install.ps1 | iex" },
    macos: { hint: "利用 Spotlight 或 Launchpad 启动终端，粘贴并在其中执行:", command: "curl -fsSL https://coffeecli.com/install.sh | bash" },
    linux: { hint: "打开您的日常终端引擎，执行此快速部署脚本:", command: "curl -fsSL https://coffeecli.com/install.sh | bash" }
  },
  "zh-TW": {
    windows: { hint: "右鍵單擊 開始菜單 > 選擇「終端機(管理員)」 > 貼上執行:", command: "iwr -useb https://coffeecli.com/install.ps1 | iex" },
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
    linux: { hint: "터미널을 열고 다�� 명령어 실행:", command: "curl -fsSL https://coffeecli.com/install.sh | bash" }
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

function initDemoTabs() {
  const tabs = document.querySelectorAll(".demo-tab");
  const gif = document.getElementById("demo-gif");
  const title = document.getElementById("demo-title");
  const desc = document.getElementById("demo-desc");
  if (!tabs.length || !gif) return;

  tabs.forEach(tab => {
    tab.addEventListener("click", () => {
      if (tab.classList.contains("active")) return;

      tabs.forEach(t => t.classList.remove("active"));
      tab.classList.add("active");

      // Fade out
      gif.classList.add("fading");
      title.classList.add("fading");
      desc.classList.add("fading");

      setTimeout(() => {
        gif.src = tab.dataset.gif;
        title.textContent = tab.dataset.title;
        desc.textContent = tab.dataset.desc;

        // Fade in
        gif.classList.remove("fading");
        title.classList.remove("fading");
        desc.classList.remove("fading");
      }, 200);
    });
  });
}