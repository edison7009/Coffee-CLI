// Shared course tabs nav for /courses/*.html pages.
// Each page should have an empty <nav class="course-tabs"></nav> and load this script.
// To add/rename/reorder a course: edit COURSE_TABS below — nothing else.
(function () {
  const COURSE_TABS = [
    { href: '../index.html',          en: '← Coffee CLI',       zh: '← Coffee CLI', id: 'back-nav', isBack: true },
    { href: 'claude-code.html',       en: 'Claude Code',        zh: 'Claude Code' },
    { href: 'founders-playbook.html', en: "Founder's Playbook", zh: 'Claude 教你创业' },
    { href: 'codex.html',             en: 'Codex',              zh: 'Codex' },
    { href: 'opencode.html',          en: 'OpenCode',           zh: 'OpenCode' },
    { href: 'openclaw.html',          en: 'OpenClaw',           zh: 'OpenClaw' },
  ];

  function currentFile() {
    const parts = location.pathname.split('/');
    return parts[parts.length - 1] || 'index.html';
  }

  function currentLang() {
    return localStorage.getItem('coffee-cli-lang')
      || (navigator.language && navigator.language.includes('zh') ? 'zh' : 'en');
  }

  function render() {
    const lang = currentLang();
    const file = currentFile();
    const containers = document.querySelectorAll('nav.course-tabs');
    containers.forEach((container) => {
      container.innerHTML = '';
      for (const tab of COURSE_TABS) {
        const a = document.createElement('a');
        a.href = tab.href;
        a.className = 'course-tab';
        a.textContent = tab[lang] || tab.en;
        if (tab.id) a.id = tab.id;
        if (!tab.isBack && tab.href === file) a.classList.add('active');
        container.appendChild(a);
      }
    });
  }

  // Expose so pages can force a re-render if they bypass the standard pattern.
  window.refreshCourseTabsLang = render;

  function init() {
    render();
    // Pages all do `document.documentElement.lang = currentLang` in their
    // updateLangUI() — observe that so tabs re-render with zero coupling to
    // each page's inline lang-toggle handler.
    new MutationObserver(render).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['lang'],
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Cross-tab sync (when another browser tab toggles the language).
  window.addEventListener('storage', (e) => {
    if (e.key === 'coffee-cli-lang') render();
  });
})();
