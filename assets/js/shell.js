/* ============================================================================
   shell.js —— 站点外壳运行时
   ----------------------------------------------------------------------------
   职责（按顺序初始化）：
     1. 主题      跟随系统 / 手动切换 / 持久化
     2. 语言      切换 zh ⇄ en（纯 CSS 驱动，见 shell.css）
     3. 阅读进度  顶部进度条 + 侧栏 scrollspy + 小节完成标记
     4. 搜索      命令面板（懒加载索引，支持键盘全流程操作）
     5. 侧栏      窄屏抽屉 + 遮罩
     6. 键盘      全局快捷键
     7. 导览      站内自动演示（供课堂讲解 / 录屏使用）
   零依赖，不使用任何构建产物。
   ========================================================================= */

(function () {
  "use strict";

  var doc = document;
  var root = doc.documentElement;
  var STORE = {
    theme: "wb.theme",
    locale: "wb.locale",
    progress: "wb.progress"
  };

  /* ---------------------------------------------------------------- 工具 */
  function $(sel, ctx) { return (ctx || doc).querySelector(sel); }
  function $$(sel, ctx) { return Array.prototype.slice.call((ctx || doc).querySelectorAll(sel)); }

  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, value);
      return value;
    } catch (e) {
      return null; // 隐私模式下 localStorage 可能不可用
    }
  }

  var prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ================================================================ 1. 主题 */
  var Theme = {
    init: function () {
      var saved = store(STORE.theme);
      var theme = saved || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
      this.apply(theme, false);

      var btn = $("#theme-toggle");
      if (btn) {
        btn.addEventListener("click", function () { Theme.toggle(); });
      }

      // 系统主题变化时，只有当用户没有手动选择过才跟随
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function (e) {
        if (!store(STORE.theme)) Theme.apply(e.matches ? "dark" : "light", false);
      });
    },

    apply: function (theme, persist) {
      root.setAttribute("data-theme", theme);
      if (persist !== false) store(STORE.theme, theme);

      var btn = $("#theme-toggle");
      if (btn) {
        var isDark = theme === "dark";
        btn.setAttribute("aria-pressed", String(isDark));
        btn.setAttribute("aria-label", isDark ? "切换到浅色主题" : "切换到深色主题");
        btn.title = isDark ? "浅色主题" : "深色主题";
        var on = $(".icon-sun", btn);
        var off = $(".icon-moon", btn);
        if (on) on.style.display = isDark ? "none" : "";
        if (off) off.style.display = isDark ? "" : "none";
      }
    },

    toggle: function () {
      this.apply(root.getAttribute("data-theme") === "dark" ? "light" : "dark", true);
    }
  };

  /* ================================================================ 2. 语言 */
  var I18N = {
    zh: {
      "search.placeholder": "搜索知识点、代码、演示…",
      "search.empty": "没有匹配的结果",
      "search.hint": "输入关键词开始检索 · 支持中文与英文",
      "search.open": "打开搜索",
      "search.close": "关闭搜索",
      "search.chapters": "章节",
      "search.demos": "演示",
      "search.terms": "术语",
      "sidebar.toc": "本章目录",
      "sidebar.chapters": "全部章节",
      "sidebar.resources": "配套资源",
      "sidebar.progress": "学习进度",
      "sidebar.done": "已读",
      "nav.prev": "上一节",
      "nav.next": "下一节",
      "nav.top": "回到顶部",
      "toast.copied": "已复制",
      "tour.play": "自动导览",
      "tour.pause": "暂停",
      "tour.resume": "继续",
      "tour.exit": "退出导览",
      "tour.prev": "上一步",
      "tour.next": "下一步",
      "tour.step": "第 {n} / {total} 步"
    },
    en: {
      "search.placeholder": "Search concepts, code, demos…",
      "search.empty": "No matching results",
      "search.hint": "Type to search · Chinese and English supported",
      "search.open": "Open search",
      "search.close": "Close search",
      "search.chapters": "Chapter",
      "search.demos": "Demo",
      "search.terms": "Term",
      "sidebar.toc": "On this page",
      "sidebar.chapters": "All chapters",
      "sidebar.resources": "Resources",
      "sidebar.progress": "Progress",
      "sidebar.done": "read",
      "nav.prev": "Previous",
      "nav.next": "Next",
      "nav.top": "Back to top",
      "toast.copied": "Copied",
      "tour.play": "Guided tour",
      "tour.pause": "Pause",
      "tour.resume": "Resume",
      "tour.exit": "Exit tour",
      "tour.prev": "Previous step",
      "tour.next": "Next step",
      "tour.step": "Step {n} / {total}"
    }
  };

  var Locale = {
    current: "zh",

    t: function (key, vars) {
      var dict = I18N[this.current] || I18N.zh;
      var s = dict[key] || (I18N.zh[key] || key);
      if (vars) {
        Object.keys(vars).forEach(function (k) {
          s = s.replace("{" + k + "}", vars[k]);
        });
      }
      return s;
    },

    init: function () {
      var qs = new URLSearchParams(location.search).get("lang");
      var saved = store(STORE.locale);
      var initial = qs === "en" ? "en" : (qs === "zh" ? "zh" : (saved === "en" ? "en" : "zh"));
      this.apply(initial, false);

      var self = this;
      $$("[data-lang-btn]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var lang = btn.getAttribute("data-lang-btn");
          if (lang && lang !== self.current) self.apply(lang, true);
        });
      });
    },

    apply: function (lang, persist) {
      this.current = lang === "en" ? "en" : "zh";
      root.setAttribute("data-locale", this.current);
      root.setAttribute("lang", this.current === "en" ? "en" : "zh-CN");
      if (persist !== false) store(STORE.locale, this.current);

      $$("[data-lang-btn]").forEach(function (btn) {
        btn.setAttribute("aria-pressed", String(btn.getAttribute("data-lang-btn") === lang));
      });

      // 刷新所有带 data-i18n 的界面文案
      var self = this;
      $$("[data-i18n]").forEach(function (el) {
        var key = el.getAttribute("data-i18n");
        var val = self.t(key);
        if (val !== key) el.textContent = val;
      });
      $$("[data-i18n-aria]").forEach(function (el) {
        el.setAttribute("aria-label", self.t(el.getAttribute("data-i18n-aria")));
      });
      $$("[data-i18n-placeholder]").forEach(function (el) {
        el.setAttribute("placeholder", self.t(el.getAttribute("data-i18n-placeholder")));
      });
      $$("[data-i18n-title]").forEach(function (el) {
        el.title = self.t(el.getAttribute("data-i18n-title"));
      });
      $$("[data-i18n-html]").forEach(function (el) {
        var v = self.t(el.getAttribute("data-i18n-html"));
        if (v) el.innerHTML = v;
      });

      doc.dispatchEvent(new CustomEvent("wb:locale", { detail: { locale: this.current } }));
    },

    toggle: function () {
      this.apply(this.current === "zh" ? "en" : "zh", true);
    }
  };

  /* ================================================================ 3. 侧栏 */
  var Sidebar = {
    init: function () {
      var sidebar = $("#sidebar");
      var toggle = $("#sidebar-toggle");
      var scrim = $("#sidebar-scrim");
      if (!sidebar) return;

      function close() {
        sidebar.setAttribute("data-open", "false");
        if (scrim) scrim.setAttribute("data-open", "false");
        if (toggle) toggle.setAttribute("aria-expanded", "false");
        doc.body.style.removeProperty("overflow");
      }

      function open() {
        sidebar.setAttribute("data-open", "true");
        if (scrim) scrim.setAttribute("data-open", "true");
        if (toggle) toggle.setAttribute("aria-expanded", "true");
        doc.body.style.overflow = "hidden";
      }

      if (toggle) {
        toggle.addEventListener("click", function () {
          if (sidebar.getAttribute("data-open") === "true") close(); else open();
        });
      }
      if (scrim) scrim.addEventListener("click", close);

      // 点击侧栏里的链接后自动收起（窄屏）
      sidebar.addEventListener("click", function (e) {
        if (e.target.closest("a") && window.matchMedia("(max-width: 900px)").matches) close();
      });

      doc.addEventListener("keydown", function (e) {
        if (e.key === "Escape" && sidebar.getAttribute("data-open") === "true") close();
      });

      this.el = sidebar;
    }
  };

  /* ========================================================== 4. 进度追踪 */
  var Progress = {
    read: function () {
      try { return JSON.parse(store(STORE.progress) || "{}"); } catch (e) { return {}; }
    },

    write: function (map) {
      store(STORE.progress, JSON.stringify(map));
    },

    /** 把 _key 标记为已读，并刷新页面上所有进度显示 */
    mark: function (key) {
      if (!key) return;
      var map = this.read();
      if (map[key]) return;
      map[key] = 1;
      this.write(map);
      doc.dispatchEvent(new CustomEvent("wb:progress", { detail: { key: key, map: map } }));
      this.paint();
    },

    /** 侧栏与页面上的进度显示 */
    paint: function () {
      var map = this.read();

      $$("[data-progress-key]").forEach(function (el) {
        el.setAttribute("data-done", map[el.getAttribute("data-progress-key")] ? "1" : "0");
      });

      $$("[data-progress-scope]").forEach(function (el) {
        var scope = el.getAttribute("data-progress-scope");
        var items = $$('[data-progress-key^="' + scope + '"]');
        if (!items.length) return;
        var done = items.filter(function (i) { return map[i.getAttribute("data-progress-key")]; }).length;
        var pct = Math.round((done / items.length) * 100);
        var out = $("[data-progress-out]", el);
        if (out) out.textContent = pct + "%";
        var bar = $("[data-progress-bar]", el);
        if (bar) bar.style.width = pct + "%";
        el.setAttribute("data-progress-value", String(pct));
      });
    }
  };

  /* ==================================================== 5. 阅读进度 + 定位 */
  var ScrollSpy = {
    init: function () {
      var bar = $("#progress-bar");
      var sections = $$("[data-section-id]");
      var links = {};

      $$("[data-toc-link]").forEach(function (a) {
        links[a.getAttribute("data-toc-link")] = a;
      });

      var currentId = null;

      function onScroll() {
        if (bar) {
          var max = doc.documentElement.scrollHeight - window.innerHeight;
          var pct = max > 0 ? Math.min(100, Math.max(0, (window.scrollY / max) * 100)) : 0;
          bar.style.width = pct.toFixed(2) + "%";
        }
      }

      if (bar) {
        onScroll();
        window.addEventListener("scroll", onScroll, { passive: true });
        window.addEventListener("resize", onScroll);
      }

      if (!sections.length || !Object.keys(links).length) return;

      /** 判定「当前小节」：视口上部第一块进入为止的 section */
      function pick() {
        var line = window.scrollY + (window.innerHeight * 0.22);
        var best = null;
        for (var i = 0; i < sections.length; i++) {
          var top = sections[i].getBoundingClientRect().top + window.scrollY;
          if (top <= line) best = sections[i]; else break;
        }
        return best || sections[0];
      }

      function sync() {
        var s = pick();
        var id = s.getAttribute("data-section-id");
        if (id === currentId) return;

        if (currentId && links[currentId]) links[currentId].removeAttribute("aria-current");
        currentId = id;
        if (links[id]) links[id].setAttribute("aria-current", "true");

        // 阅读到底部附近才算「读完」这一节
        var rect = s.getBoundingClientRect();
        if (rect.bottom < window.innerHeight * 0.6) {
          Progress.mark(s.getAttribute("data-progress-key"));
        }
      }

      var ticking = false;
      window.addEventListener("scroll", function () {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(function () { sync(); ticking = false; });
      }, { passive: true });

      window.addEventListener("resize", sync);
      sync();
    }
  };

  /* ================================================================ 6. 搜索 */
  var Search = {
    index: null,
    loading: false,
    active: -1,
    results: [],

    init: function () {
      this.layer = $("#search-layer");
      if (!this.layer) return;

      this.input = $("#search-input", this.layer);
      this.list = $("#search-results", this.layer);
      var self = this;

      $$("[data-search-open]").forEach(function (btn) {
        btn.addEventListener("click", function (e) { e.preventDefault(); self.open(); });
      });

      $$("[data-search-close]", this.layer).forEach(function (el) {
        el.addEventListener("click", function () { self.close(); });
      });

      this.layer.addEventListener("mousedown", function (e) {
        if (e.target === self.layer) self.close();
      });

      this.input.addEventListener("input", function () { self.run(this.value); });

      this.input.addEventListener("keydown", function (e) {
        if (e.key === "ArrowDown") { e.preventDefault(); self.move(1); }
        else if (e.key === "ArrowUp") { e.preventDefault(); self.move(-1); }
        else if (e.key === "Enter") {
          e.preventDefault();
          var r = self.results[self.active];
          if (r) self.close(), (location.href = r.href);
        }
      });

      this.layer.addEventListener("keydown", function (e) {
        // 焦点陷阱：Tab 在面板内循环
        if (e.key !== "Tab") return;
        var f = $$('a[href], button:not([disabled]), input', self.layer).filter(function (el) {
          return el.offsetParent !== null;
        });
        if (!f.length) return;
        var first = f[0], last = f[f.length - 1];
        if (e.shiftKey && doc.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && doc.activeElement === last) { e.preventDefault(); first.focus(); }
      });

      doc.addEventListener("keydown", function (e) {
        if (e.key === "Escape" && self.isOpen()) { self.close(); }
      });
    },

    isOpen: function () { return this.layer.getAttribute("data-open") === "true"; },

    open: function (query) {
      this.layer.setAttribute("data-open", "true");
      this.layer.setAttribute("aria-hidden", "false");
      this.lastFocus = doc.activeElement;
      var self = this;
      this.load().then(function () {
        self.input.focus();
        self.input.select();
        if (query) { self.input.value = query; self.run(query); }
        else if (!self.input.value) self.run("");
      });
    },

    close: function () {
      this.layer.setAttribute("data-open", "false");
      this.layer.setAttribute("aria-hidden", "true");
      if (this.lastFocus && this.lastFocus.focus) this.lastFocus.focus();
    },

    /** 索引按需加载：没打开过搜索的读者不会付出这次请求 */
    load: function () {
      var self = this;
      if (this.index) return Promise.resolve(this.index);
      if (this.loading) return this.loading;

      this.loading = fetch(window.WB_SEARCH_INDEX || "assets/search-index.json")
        .then(function (r) { return r.ok ? r.json() : []; })
        .then(function (data) { self.index = Array.isArray(data) ? data : (data.entries || []); return self.index; })
        .catch(function () { self.index = []; return self.index; });

      return this.loading;
    },

    /** 极简相关度打分：标题命中 > 正文命中，前缀命中 > 词中命中 */
    score: function (entry, q) {
      var title = entry.title.toLowerCase();
      var body = (entry.text || "").toLowerCase();
      var low = q.toLowerCase();
      var s = 0;
      var i = title.indexOf(low);
      if (i === 0) s += 60; else if (i > 0) s += 34;
      var j = body.indexOf(low);
      if (j >= 0) s += 12;
      // 关键词逐个命中再加一点分
      low.split(/\s+/).forEach(function (w) {
        if (!w) return;
        if (title.indexOf(w) >= 0) s += 8;
        if (body.indexOf(w) >= 0) s += 3;
      });
      return s;
    },

    run: function (query) {
      var self = this;
      var q = (query || "").trim();
      var entries = this.index || [];

      var hits;
      if (!q) {
        // 空查询：给出「下一步学什么」的引导，而不是一片空白
        hits = entries.filter(function (e) { return e.primary; }).slice(0, 8);
      } else {
        hits = entries
          .map(function (e) { return { e: e, s: self.score(e, q) }; })
          .filter(function (x) { return x.s > 0; })
          .sort(function (a, b) { return b.s - a.s; })
          .slice(0, 24)
          .map(function (x) { return x.e; });
      }

      this.results = hits.map(function (e) {
        return { href: e.href, el: null };
      });

      if (!hits.length) {
        this.list.innerHTML = '<p class="search-panel__empty">' + esc(Locale.t("search.empty")) + "</p>";
        this.active = -1;
        return;
      }

      this.list.innerHTML = hits.map(function (e, i) {
        return (
          '<a class="search-result" href="' + esc(e.href) + '" data-i="' + i + '">' +
            '<span class="search-result__head">' +
              '<span class="search-result__title">' + mark(e.title, q) + "</span>" +
              '<span class="search-result__where">' + esc(e.where || "") + "</span>" +
            "</span>" +
            (e.text ? '<span class="search-result__snippet">' + mark(snippet(e.text, q), q) + "</span>" : "") +
          "</a>"
        );
      }).join("");

      this.active = -1;
      $$(".search-result", this.list).forEach(function (el, i) {
        self.results[i].el = el;
        el.addEventListener("mouseenter", function () { self.setActive(i); });
      });
      this.setActive(0);
    },

    setActive: function (i) {
      this.active = i;
      $$(".search-result", this.list).forEach(function (el, k) {
        el.setAttribute("data-active", String(k === i));
      });
    },

    move: function (delta) {
      if (!this.results.length) return;
      var n = this.results.length;
      var i = (this.active + delta + n) % n;
      this.setActive(i);
      var el = this.results[i].el;
      if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
    }
  };

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function mark(text, q) {
    var safe = esc(text);
    if (!q) return safe;
    var words = q.trim().split(/\s+/).filter(Boolean)
      .map(function (w) { return w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); });
    if (!words.length) return safe;
    return safe.replace(new RegExp("(" + words.join("|") + ")", "gi"), "<mark>$1</mark>");
  }

  function snippet(text, q) {
    if (!text) return "";
    if (!q) return text.slice(0, 110);
    var i = text.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return text.slice(0, 110);
    var start = Math.max(0, i - 34);
    return (start > 0 ? "…" : "") + text.slice(start, start + 120);
  }

  /* ============================================================== 7. 提示条 */
  var Toast = {
    el: null,
    timer: null,
    show: function (msg) {
      if (!this.el) {
        this.el = doc.createElement("div");
        this.el.className = "toast";
        this.el.setAttribute("role", "status");
        this.el.setAttribute("aria-live", "polite");
        doc.body.appendChild(this.el);
      }
      this.el.textContent = msg;
      this.el.setAttribute("data-show", "true");
      var self = this;
      clearTimeout(this.timer);
      this.timer = setTimeout(function () { self.el.setAttribute("data-show", "false"); }, 1600);
    }
  };

  /* ================================================================ 8. 键盘 */
  var Keys = {
    init: function () {
      doc.addEventListener("keydown", function (e) {
        var tag = (e.target.tagName || "").toLowerCase();
        var typing = tag === "input" || tag === "textarea" || e.target.isContentEditable;

        // Cmd/Ctrl + K —— 打开搜索
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
          e.preventDefault();
          Search.isOpen() ? Search.close() : Search.open();
          return;
        }

        if (typing || Search.isOpen()) return;

        // "/" —— 打开搜索
        if (e.key === "/") { e.preventDefault(); Search.open(); return; }

        // "t" —— 切换主题
        if (e.key === "t" && !e.metaKey && !e.ctrlKey) { Theme.toggle(); return; }

        // "[" / "]" 或 ← / → —— 切换小节（与浏览器前进后退不冲突）
        if (e.key === "[" || e.key === "]") {
          e.preventDefault();
          Keys.section(e.key === "]" ? 1 : -1);
          return;
        }

        var pager = doc.querySelector(".lesson-pager");
        if (!pager) return;

        // g 前缀跳转到上/下一章
        if (e.key === "j" && !e.metaKey) location.href = pager.getAttribute("data-next") || location.href;
        if (e.key === "k" && !e.metaKey) location.href = pager.getAttribute("data-prev") || location.href;
      });
    },

    /** 在当前页的小节之间跳转（不跨页） */
    section: function (delta) {
      var sections = $$("[data-section-id]");
      if (!sections.length) return;
      var line = window.scrollY + (window.innerHeight * 0.25);
      var idx = 0;
      for (var i = 0; i < sections.length; i++) {
        var top = sections[i].getBoundingClientRect().top + window.scrollY;
        if (top <= line) idx = i;
      }
      var next = Math.min(sections.length - 1, Math.max(0, idx + delta));
      if (next === idx && delta > 0) return;
      var target = sections[next];
      window.scrollTo({
        top: target.getBoundingClientRect().top + window.scrollY - 96,
        behavior: prefersReduced ? "auto" : "smooth"
      });
      Progress.mark(target.getAttribute("data-progress-key"));
    }
  };

  /* ============================================================ 9. 回到顶部 */
  function initTopLink() {
    $$("[data-top]").forEach(function (el) {
      el.addEventListener("click", function (e) {
        e.preventDefault();
        window.scrollTo({ top: 0, behavior: prefersReduced ? "auto" : "smooth" });
      });
    });
  }

  /* ============================================================ 10. 自动导览 */
  /* 课堂讲解与录屏时用：按预设脚本自动走一遍重点，把「改了什么」演出来。 */
  var Tour = {
    steps: [],
    i: 0,
    playing: false,
    timer: null,

    init: function () {
      this.bar = $("#tour-bar");
      if (!this.bar) return;

      this.steps = window.__WB_TOUR__ || [];
      if (!this.steps.length) return;

      var self = this;
      $("#tour-play").addEventListener("click", function () { self.start(); });
      $("#tour-prev").addEventListener("click", function () { self.go(self.i - 1); });
      $("#tour-next").addEventListener("click", function () { self.go(self.i + 1); });
      $("#tour-exit").addEventListener("click", function () { self.stop(); });
      $("#tour-toggle").addEventListener("click", function () { self.playing ? self.pause() : self.resume(); });

      doc.addEventListener("keydown", function (e) {
        if (!self.on) return;
        if (e.key === "Escape") self.stop();
        if (e.key === "ArrowRight") self.go(self.i + 1);
        if (e.key === "ArrowLeft") self.go(self.i - 1);
      });
    },

    start: function () {
      this.on = true;
      this.i = 0;
      this.bar.setAttribute("data-open", "true");
      doc.body.classList.add("tour-on");
      this.go(0);
      this.playing = true;
      this.syncButton();
    },

    stop: function () {
      this.on = false;
      this.playing = false;
      clearTimeout(this.timer);
      this.bar.setAttribute("data-open", "false");
      doc.body.classList.remove("tour-on");
    },

    pause: function () { this.playing = false; clearTimeout(this.timer); this.syncButton(); },

    resume: function () {
      if (!this.on) return;
      this.playing = true;
      this.syncButton();
      this.schedule();
    },

    syncButton: function () {
      var btn = $("#tour-toggle");
      if (!btn) return;
      btn.textContent = this.playing ? Locale.t("tour.pause") : Locale.t("tour.resume");
    },

    schedule: function () {
      if (!this.playing) return;
      var step = this.steps[this.i];
      if (!step) { this.playing = false; this.syncButton(); return; }
      var self = this;
      clearTimeout(this.timer);
      this.timer = setTimeout(function () {
        if (!self.playing) return;
        if (self.i >= self.steps.length - 1) { self.playing = false; self.syncButton(); return; }
        self.go(self.i + 1);
      }, step.hold || 5200);
    },

    go: function (i) {
      if (i < 0 || i >= this.steps.length) return;
      this.i = i;
      var step = this.steps[i];

      $("#tour-title").textContent = step.title || "";
      $("#tour-say").textContent = step.say || "";
      $("#tour-count").textContent = Locale.t("tour.step", { n: i + 1, total: this.steps.length });

      if (step.section) {
        var sec = doc.querySelector('[data-section-id="' + step.section + '"]');
        if (sec) {
          if (step.tab) Lesson.showTab(sec, step.tab);
          window.scrollTo({
            top: sec.getBoundingClientRect().top + window.scrollY - 96,
            behavior: prefersReduced ? "auto" : "smooth"
          });
        }
      } else if (step.selector) {
        var el = doc.querySelector(step.selector);
        if (el) window.scrollTo({
          top: el.getBoundingClientRect().top + window.scrollY - 110,
          behavior: prefersReduced ? "auto" : "smooth"
        });
      } else if (step.top) {
        window.scrollTo({ top: 0, behavior: prefersReduced ? "auto" : "smooth" });
      }

      this.schedule();
    }
  };

  /* ============================================================ 11. 小节 Tab */
  /* 原站把 tab 切换放在每章各自的 lesson.js 里，重复了 5 遍。
     这里统一实现，并对外暴露 showTab 供导览复用。 */
  var Lesson = {
    init: function () {
      var self = this;

      $$(".section").forEach(function (sec) {
        var tabs = $$(".tab-btn", sec);
        if (!tabs.length) return;

        tabs.forEach(function (btn) {
          btn.addEventListener("click", function () { self.showTab(sec, btn.getAttribute("data-tab")); });
          btn.addEventListener("keydown", function (e) {
            var i = tabs.indexOf(btn);
            var next = null;
            if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
            else if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
            else if (e.key === "Home") next = 0;
            else if (e.key === "End") next = tabs.length - 1;
            if (next === null) return;
            e.preventDefault();
            tabs[next].focus();
            self.showTab(sec, tabs[next].getAttribute("data-tab"));
          });
        });

        // 记忆：同一小节内切过一次后，其余小节跟随上次选择
        var remembered = store("wb.tab");
        if (remembered) self.showTab(sec, remembered, true);
      });
    },

    showTab: function (sec, name, silent) {
      if (!sec || !name) return;
      $$(".tab-btn", sec).forEach(function (b) {
        var on = b.getAttribute("data-tab") === name;
        b.setAttribute("aria-selected", String(on));
        b.classList.toggle("active", on);
        b.setAttribute("tabindex", on ? "0" : "-1");
      });
      $$(".tab-panel", sec).forEach(function (p) {
        var on = p.getAttribute("data-panel") === name;
        p.setAttribute("data-active", String(on));
        p.classList.toggle("active", on);
        p.hidden = !on;
      });

      if (!silent) store("wb.tab", name);

      // 通知 demo 加载器：只有真正被看到的演示才需要下载与执行
      var panel = sec.querySelector('.tab-panel[data-panel="demo"]');
      if (panel) {
        panel.dispatchEvent(new CustomEvent("wb:revealed", { bubbles: true }));
      }
    }
  };

  /* ============================================================== 启动 */
  function boot() {
    Theme.init();
    Locale.init();
    Sidebar.init();
    Search.init();
    Lesson.init();
    Keys.init();
    initTopLink();
    Tour.init();
    Progress.paint();
    ScrollSpy.init();
  }

  // 样式表与内联脚本已经把主题定好了，这里只需在 DOM 就绪后接管交互
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", boot);
  else boot();

  // 对外暴露给各章 demo 与导览脚本使用
  window.WB = {
    theme: Theme,
    locale: Locale,
    t: function (k, v) { return Locale.t(k, v); },
    search: Search,
    toast: Toast,
    tour: Tour,
    lesson: Lesson,
    progress: Progress,
    esc: esc
  };
})();
