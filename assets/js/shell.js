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
  var win = window;
  var root = doc.documentElement;

  /* 第一件事：给 <html> 打上 data-js，声明「脚本已接管」。
     放在最前面、在任何可能抛异常的调用之前 —— 它是个纯标记，
     供以后写「只在有 JS 时才生效」的样式用；本文件里 tab 面板的显隐
     另由 data-tabs 控制（见 Lesson.init），因为那是另一个模块的责任。 */
  root.setAttribute("data-js", "1");

  /* 站点根目录。以本模块自身的位置推算（assets/js/shell.js -> 上两级），
     因为页面可能位于 /、/lesson-0X/、/supplementary/ 等不同层级，
     而站点级资源（搜索索引等）只有一份。 */
  var SITE_ROOT = new URL("../../", import.meta.url);

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
      "search.failed": "搜索索引没能加载。请确认是通过 HTTP 服务器打开本站（直接双击 HTML 用 file:// 打开会被浏览器拦截）。",
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
      "tour.step": "第 {n} / {total} 步",
      "lab.eyebrow": "延伸实验",
      "lab.open": "打开实验目录"
    },
    en: {
      "search.placeholder": "Search concepts, code, demos…",
      "search.empty": "No matching results",
      "search.failed": "The search index could not be loaded. Make sure the site is opened over HTTP (file:// is blocked by browsers).",
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
      "tour.step": "Step {n} / {total}",
      "lab.eyebrow": "Extra labs",
      "lab.open": "Open lab folder"
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
        // 门户页与侧栏的「全部章节」不在本章页面里，拿不到小节节点，
        // 因此允许用 data-progress-total 显式声明分母。
        var total = items.length || parseInt(el.getAttribute("data-progress-total") || "0", 10);
        if (!total) return;
        var done = items.filter(function (i) { return map[i.getAttribute("data-progress-key")]; }).length;
        if (!items.length) {
          for (var k in map) if (map[k] && k.indexOf(scope) === 0) done++;
        }
        var pct = Math.min(100, Math.round((done / total) * 100));
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
        // 1) 阅读进度：凡是「底边已经越过视口 60% 线」的小节都算读过。
        //    这里必须放在下面的提前 return 之前 —— 之前把打点写在
        //    「当前小节发生变化」那个分支里，结果是：只要不换节，
        //    再怎么往下滚都不会记录，进度永远停在 0%。
        var markLine = window.innerHeight * 0.6;
        for (var i = 0; i < sections.length; i++) {
          if (sections[i].getBoundingClientRect().bottom <= markLine) {
            Progress.mark(sections[i].getAttribute("data-progress-key"));
          }
        }

        // 2) 高亮「当前小节」：视口上部 22% 处所在的那一节
        var s = pick();
        var id = s.getAttribute("data-section-id");
        if (id === currentId) return;

        if (currentId && links[currentId]) links[currentId].removeAttribute("aria-current");
        currentId = id;
        if (links[id]) links[id].setAttribute("aria-current", "true");
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

      // 索引是按语言分组的，切换语言后已渲染的结果要跟着重来
      doc.addEventListener("wb:locale", function () {
        if (self.isOpen()) self.run(self.input.value);
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

      // 索引地址必须以 shell.js 自身的位置为基准，不能写成页面相对路径。
      // 写成 "assets/search-index.json" 时，在 /lesson-03/ 下会去请求
      // /lesson-03/assets/search-index.json —— 404 被下面的 catch 吞掉，
      // 表现是「搜索框能打开、输入什么都不出结果」。也就是说：
      // 除了门户页，全站搜索都是坏的，而且坏得没有任何提示。
      var url = window.WB_SEARCH_INDEX ||
                new URL("assets/search-index.json", SITE_ROOT).href;

      this.loading = fetch(url)
        .then(function (r) {
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r.json();
        })
        .then(function (data) { self.index = Array.isArray(data) ? data : (data.entries || []); return self.index; })
        .catch(function (err) {
          console.warn("[shell] 搜索索引加载失败：" + url, err);
          self.index = [];
          self.failed = true;
          return self.index;
        });

      return this.loading;
    },

    /** 极简相关度打分：标题命中 > 正文命中，前缀命中 > 词中命中。
     *  入参必须是 localize() 归一化过的条目（run() 里统一做过了）。 */
    score: function (entry, q) {
      var title = entry.title.toLowerCase();
      var body = entry.text.toLowerCase();
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
      var entries = (this.index || []).map(localize);

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
        // 区分「确实没搜到」和「索引根本没加载成功」。
        // 后者如果也显示「没有找到」，会让人以为站内真的没有这个内容。
        var msg = this.failed ? Locale.t("search.failed") : Locale.t("search.empty");
        this.list.innerHTML = '<p class="search-panel__empty">' + esc(msg) + "</p>";
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

  /* 搜索索引是**按语言分组的**：每条记录长这样
       { href, primary, zh: { title, where, text }, en: { … } }
     取字段必须先看当前语言。
     之前直接读 entry.title / entry.text，全都取到 undefined，
     于是「输入任何关键词」都会在 score() 里抛异常 —— 搜索框能打开，
     列表里还留着上一次空查询的结果，看起来像是「搜不到」，其实是崩了。 */
  function localize(entry) {
    var loc = Locale.current === "en" ? "en" : "zh";
    var o = entry[loc] || entry.zh || entry.en || {};
    return {
      href: entry.href,
      primary: !!entry.primary,
      title: o.title || "",
      where: o.where || "",
      text: o.text || ""
    };
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

      // 导览脚本内嵌在页面里（<script type="application/json" id="tour-data">），
      // 这样脚本本身不必知道任何一章的内容
      this.steps = window.__WB_TOUR__ || [];
      if (!this.steps.length) {
        var holder = doc.getElementById("tour-data");
        if (holder) {
          try { this.steps = JSON.parse(holder.textContent); } catch (e) { this.steps = []; }
        }
      }
      if (!this.steps.length) return;

      var self = this;

      // 启动按钮可能在页面上出现两次（门户页 hero 里一个、底部导览条一个），
      // 所以用属性选择器全绑一遍，而不是 getElementById —— 之前两处都写了
      // id="tour-play"，重复 id 是非法的，而且 getElementById 只返回第一个，
      // 底部那个按钮点击后毫无反应。
      $$("[data-tour-start]").forEach(function (el) {
        el.addEventListener("click", function () { self.start(); });
      });

      // 其余控制按钮每页最多一个，逐个守卫而不是假设它们都在：
      // 之前 #tour-play 漏在模板外，一行 null.addEventListener 就把整个 boot
      // 里排在后面的搜索、进度初始化全部中断了——而且不报 404，只是静默失效。
      // 绑定失败最多少一个按钮用，不该拖垮别的模块。
      [["#tour-prev", function () { self.go(self.i - 1); }],
       ["#tour-next", function () { self.go(self.i + 1); }],
       ["#tour-exit", function () { self.stop(); }],
       ["#tour-toggle", function () { self.playing ? self.pause() : self.resume(); }]
      ].forEach(function (pair) {
        var el = $(pair[0]);
        if (!el) return;                       // 该形态下没这个按钮，正常
        el.addEventListener("click", pair[1]);
      });

      // 折叠态按钮上标出总步数，让人知道点下去会发生什么
      var total = $("#tour-total");
      if (total) total.textContent = this.steps.length + " 步";

      doc.addEventListener("keydown", function (e) {
        if (!self.on) return;
        if (e.key === "Escape") self.stop();
        if (e.key === "ArrowRight") self.go(self.i + 1);
        if (e.key === "ArrowLeft") self.go(self.i - 1);
      });

      /* 往下读的时候把胶囊收起来。
         它固定在视口底部，390px 手机上正好压住一行正文 —— 而且一直压着：
         普通滚动改变不了它的位置，除非滚到页面最底部（那里留了空白）。
         做法和手机浏览器自己收地址栏一样：向下滚收起，向上滚或回到页顶再出现。
         导览进行中（data-open="true"）不收起，否则解说条会一半消失。 */
      var lastY = win.pageYOffset || 0;
      var queued = false;
      function syncBar() {
        queued = false;
        var y = win.pageYOffset || 0;
        var open = self.bar.getAttribute("data-open") === "true";
        if (open) {
          self.bar.removeAttribute("data-hidden");
        } else if (y > lastY + 6 && y > 240) {
          self.bar.setAttribute("data-hidden", "true");
        } else if (y < lastY - 6 || y < 240) {
          self.bar.removeAttribute("data-hidden");
        }
        if (Math.abs(y - lastY) > 6) lastY = y;
      }
      win.addEventListener("scroll", function () {
        if (queued) return;
        queued = true;
        win.requestAnimationFrame(syncBar);
      }, { passive: true });

      // 键盘 Tab 落到按钮上时必须能看见它
      this.bar.addEventListener("focusin", function () {
        self.bar.removeAttribute("data-hidden");
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
      var bound = 0;
      var preferred = store("wb.tab");

      $$(".section").forEach(function (sec) {
        var tabs = $$(".tab-btn", sec);
        if (!tabs.length) return;
        bound++;

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

        /* 每一节都必须选中一个面板 —— 这是「首访读者看到空白页」那个 bug 的修法。
           原逻辑是「有记忆才恢复」，于是第一次来的读者（localStorage 里没有
           wb.tab）一个面板都没选中：CSS 里 .tab-panel 默认 display:none，
           整章 24 个面板全部不可见，页面只剩一行行小节标题，正文 1208 字。
           老读者因为点过一次 tab、留下了记忆，反而是正常的 —— 所以这个 bug
           在本机很难被发现，是把 localStorage 清掉才复现出来的。

           优先级：上次选择 → explain → 该节第一个 tab。最后一步兜底的是
           万一记忆里的 tab 在当前节不存在（比如某节没有演示）。 */
        var names = tabs.map(function (b) { return b.getAttribute("data-tab"); });
        var pick = (preferred && names.indexOf(preferred) >= 0) ? preferred
                 : (names.indexOf("explain") >= 0 ? "explain" : names[0]);
        self.showTab(sec, pick, true);
      });

      /* 确实绑上了才声明「tab 已接管」。CSS 里
         `html:not([data-tabs]) .tab-panel { display: block }` 靠这个标记决定
         要不要隐藏非活动面板 —— 万一本模块没跑起来（脚本被拦、解析失败），
         读者看到的是三栏全部展开的完整正文，而不是一片空白。 */
      if (bound) root.setAttribute("data-tabs", "1");
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
  /* 每个模块独立初始化并各自兜住异常。
     理由很实在：这些模块之间没有依赖关系，但共用一次 boot。
     之前 Tour.init 因为找不到一个按钮抛异常，就静默带停了后面的
     进度条与 scrollspy —— 页面看起来「只是没反应」，排查成本很高。
     现在一个坏了只影响它自己，并且控制台会直说是哪个模块坏在哪。 */
  function boot() {
    [
      ["主题", Theme],
      ["语言", Locale],
      ["侧栏", Sidebar],
      ["搜索", Search],
      ["小节 Tab", Lesson],
      ["快捷键", Keys],
      ["回到顶部", { init: initTopLink }],
      ["自动导览", Tour],
      ["阅读进度", { init: function () { Progress.paint(); } }],
      ["大纲高亮", ScrollSpy]
    ].forEach(function (pair) {
      try {
        pair[1].init();
      } catch (err) {
        console.error("[shell] " + pair[0] + "初始化失败，已跳过：", err);
      }
    });
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
