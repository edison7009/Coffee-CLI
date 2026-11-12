/**
 * docs.js — docs page behaviour: theme toggle (shared with the homepage),
 * screenshots that follow the theme, sidebar scroll-spy, mobile drawer and
 * back-to-top.
 */
(function () {
  "use strict";
  var root = document.documentElement;
  var moon = "M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z";
  var sun = "M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41M12 17a5 5 0 1 1 0-10 5 5 0 0 1 0 10Z";

  function store(key, value) { try { localStorage.setItem(key, value); } catch (e) {} }

  // Screenshots: Chinese pages get the Chinese recordings, others English;
  // light page → Glacier recordings, dark page → black ones.
  var shotLang = /^zh/.test(root.getAttribute("data-lang") || "") ? "zh" : "en";
  function syncShots() {
    var tone = root.getAttribute("data-theme") === "dark" ? "black" : "glacier";
    document.querySelectorAll("img[data-shot]").forEach(function (img) {
      var src = "/demo/features/" + shotLang + "/" + tone + "/" + img.getAttribute("data-shot") + "-poster.webp";
      if (img.getAttribute("src") !== src) img.setAttribute("src", src);
    });
  }

  function initTheme() {
    var btn = document.getElementById("theme-toggle");
    var icon = btn && btn.querySelector("svg");
    var paint = function () {
      if (icon) icon.innerHTML = '<path d="' + (root.getAttribute("data-theme") === "dark" ? sun : moon) + '"></path>';
      syncShots();
    };
    paint();
    if (btn) btn.addEventListener("click", function () {
      var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      store("coffee-cli-theme", next);
      paint();
    });
  }

  function initDrawer() {
    var btn = document.getElementById("docs-menu");
    var scrim = document.querySelector(".docs-scrim");
    var close = function () { document.body.classList.remove("side-open"); if (btn) btn.setAttribute("aria-expanded", "false"); };
    if (btn) btn.addEventListener("click", function () {
      var open = document.body.classList.toggle("side-open");
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    });
    if (scrim) scrim.addEventListener("click", close);
    document.querySelectorAll(".docs-side a").forEach(function (a) { a.addEventListener("click", close); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });
  }

  // Highlight the sidebar entry of the section being read.
  function initSpy() {
    var links = {};
    document.querySelectorAll('.docs-side a[href^="#"]').forEach(function (a) { links[a.getAttribute("href").slice(1)] = a; });
    var sections = Array.prototype.filter.call(document.querySelectorAll(".docs-article section[id]"), function (s) { return links[s.id]; });
    if (!sections.length) return;
    var current = null;
    var update = function () {
      var hit = sections[0];
      for (var i = 0; i < sections.length; i++) { if (sections[i].getBoundingClientRect().top <= 120) hit = sections[i]; }
      if ((window.innerHeight + window.scrollY) >= document.body.scrollHeight - 4) hit = sections[sections.length - 1];
      if (hit === current) return;
      if (current) links[current.id].classList.remove("active");
      current = hit;
      var a = links[hit.id];
      a.classList.add("active");
      var side = document.querySelector(".docs-side");
      if (side && (a.offsetTop < side.scrollTop || a.offsetTop > side.scrollTop + side.clientHeight - 60)) {
        side.scrollTop = a.offsetTop - side.clientHeight / 3;
      }
    };
    var queued = false;
    window.addEventListener("scroll", function () {
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () { queued = false; update(); });
    }, { passive: true });
    window.addEventListener("resize", update);
    update();
  }

  function initToTop() {
    var btn = document.querySelector(".to-top");
    if (!btn) return;
    window.addEventListener("scroll", function () { btn.classList.toggle("show", window.scrollY > 900); }, { passive: true });
    btn.addEventListener("click", function () { window.scrollTo({ top: 0 }); });
  }

  function boot() { initTheme(); initDrawer(); initSpy(); initToTop(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
