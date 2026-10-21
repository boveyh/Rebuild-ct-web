/* ============================================================================
   portal.js —— 门户页的小幅增强
   ----------------------------------------------------------------------------
   1. 找到读者上次读到的地方，在对应章节卡片上打一个「继续」标记
      —— 原站每次打开都要自己回忆学到哪了；
   2. 统计数字进入视口时做一次简短的递增，给「课程体量」一个直观感受。
      只在用户没有设置「减少动态效果」时执行。
   ========================================================================= */

(function () {
  "use strict";

  var doc = document;
  var $$ = function (sel) { return Array.prototype.slice.call(doc.querySelectorAll(sel)); };
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var SVG_NS = "http://www.w3.org/2000/svg";

  function readProgress() {
    try { return JSON.parse(localStorage.getItem("wb.progress") || "{}"); } catch (e) { return {}; }
  }

  function isEn() {
    return doc.documentElement.getAttribute("data-locale") === "en";
  }

  function esc(str) {
    return String(str).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  /* 这一站读到哪了。分母来自构建期写入的 data-progress-total ——
     门户页里没有小节节点，数不出实际条数。 */
  function stopDone(stop) {
    var scope = stop.getAttribute("data-progress-scope");
    var total = parseInt(stop.getAttribute("data-progress-total") || "0", 10);
    if (!scope || !total) return { done: 0, total: 0 };
    var map = readProgress();
    var done = 0;
    for (var k in map) if (map[k] && k.indexOf(scope) === 0) done++;
    return { done: Math.min(done, total), total: total };
  }

  function stateText(done, total, en) {
    if (!total) return "";
    if (done >= total) return en ? "Read" : "已读完";
    if (done > 0) return en ? done + " / " + total + " read" : "读到 " + done + " / " + total;
    return en ? "Not started" : "未开始";
  }

  /* --------------------------------------------------- 上次读到哪了 */
  function markResume() {
    var map;
    try { map = JSON.parse(localStorage.getItem("wb.progress") || "{}"); } catch (e) { return; }

    // 切语言时会重跑一遍，先清掉上一次的标记，免得叠出两个「继续」
    $$(".chapter-card__resume").forEach(function (b) { b.remove(); });
    $$('.chapter-card[data-resume="1"]').forEach(function (c) { c.removeAttribute("data-resume"); });

    var best = null;
    $$(".chapter-card").forEach(function (card) {
      var scope = card.getAttribute("data-progress-scope");
      var total = parseInt(card.getAttribute("data-progress-total") || "0", 10);
      if (!scope || !total) return;
      var done = 0;
      for (var k in map) if (map[k] && k.indexOf(scope) === 0) done++;
      if (done > 0 && (!best || done / total > best.ratio)) {
        best = { card: card, done: done, total: total, ratio: done / total };
      }
    });

    if (!best) return;
    var en = document.documentElement.getAttribute("data-locale") === "en";
    var badge = doc.createElement("span");
    badge.className = "chapter-card__resume";
    badge.textContent = en
      ? "Continue · " + best.done + " / " + best.total + " read"
      : "继续 · 已读 " + best.done + " / " + best.total;
    var foot = best.card.querySelector(".chapter-card__foot");
    if (foot) foot.insertBefore(badge, foot.firstChild);
    best.card.setAttribute("data-resume", "1");
  }

  /* --------------------------------------------------- 数字递增动画 */
  function countUp() {
    $$(".portal-stats dd").forEach(function (dd) {
      var raw = dd.textContent.trim();
      var m = raw.match(/^(\d+)(.*)$/);
      if (!m) return;
      var target = parseInt(m[1], 10);
      var suffix = m[2];
      if (reduce || target < 3) return;

      dd.textContent = "0" + suffix;
      var start = null;
      var dur = 620;
      function step(ts) {
        if (start === null) start = ts;
        var p = Math.min(1, (ts - start) / dur);
        // 先快后慢
        var eased = 1 - Math.pow(1 - p, 3);
        dd.textContent = Math.round(target * eased) + suffix;
        if (p < 1) requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    });
  }

  /* --------------------------------------------------- 学习路径走到哪了 */
  /* 步骤序号上的对勾由 shell.js 统一处理（它会给每个 [data-progress-scope]
     写 data-progress-value）。但它只在 100% 时才看得出来，中途没有任何反馈，
     于是「学习路径」这一块对回访者来说等于静止的。这里补一条「已读 m / n 章」。

     一章没读就不显示：一个刚打开页面的人看到「已读 0 / 5」只会觉得自己落后。 */
  function markRoutes() {
    var en = isEn();

    $$(".world").forEach(function (card) {
      var meter = card.querySelector("[data-route-meter]");
      var done = 0;
      var list = Array.prototype.slice.call(card.querySelectorAll(".stop"));

      list.forEach(function (st) {
        var r = stopDone(st);
        var state = st.querySelector("[data-stop-state]");
        if (state) state.textContent = stateText(r.done, r.total, en);
        // 连线要按「走到哪」分实线/虚线，所以把结果留在属性上给绘制用
        st.setAttribute("data-done", r.done >= r.total ? "1" : "0");
        if (r.done >= r.total) done++;
      });

      if (!meter) return;
      if (!done) {
        meter.hidden = true;
        meter.removeAttribute("data-state");
        return;
      }
      meter.hidden = false;
      meter.setAttribute("data-state", done === list.length ? "done" : "partial");
      meter.textContent = en
        ? done + " of " + list.length + " chapters read"
        : "已读 " + done + " / " + list.length + " 章";
    });
  }

  /* --------------------------------------------------- 章节卡：进度环 */
  /* 卡右上角的百分比原来只是一行字。换成环形表盘之后，进度有了形状 ——
     但形状得「长」出来才算数，静止画好只是换了个外观。所以填两次：

       · 卡片第一次滚进视口，环从空扫到真实值；
       · 鼠标移进卡片（或 Tab 聚焦）再快速重播一遍。触屏没有 hover，
         手指抬起也不会配对 pointerleave，干脆不播。

     环心数字不参与动画。它是这张卡唯一的文字读数，要同时喂给读屏、
     打印和「在页面里搜 80%」，不能为了动效先把它变成 0%。环负责「长」，
     数字负责「准」；一静一动，比两个一起数更清楚，也不会在环没长完时
     出现「数字说 80%、环说 0%」的自相矛盾。 */
  var Rings = {
    items: [],

    init: function () {
      var self = this;

      this.items = $$(".chapter-card__ring-fill").map(function (fill) {
        var card = fill.parentNode;
        while (card && !card.classList.contains("chapter-card")) card = card.parentNode;
        if (!card) return null;
        return {
          card: card,
          fill: fill,
          num: card.querySelector("[data-progress-num]"),
          pct: 0,
          played: false,
          lastBeat: 0,
        };
      }).filter(Boolean);

      if (!this.items.length) return;

      this.items.forEach(function (it) {
        it.pct = self.read(it.card);
        self.writeNum(it);
        self.paint(it, 0, false);   // 环先空着，等它进视口再长出来

        var replay = function (e) {
          if (reduce) return;
          if (e.type === "pointerenter" && e.pointerType && e.pointerType !== "mouse") return;
          // 点进来会先 pointerenter 再 focus，挨得太近只播一次
          var now = Date.now();
          if (now - it.lastBeat < 500) return;
          it.lastBeat = now;
          self.paint(it, 0, false);
          requestAnimationFrame(function () {
            requestAnimationFrame(function () { self.paint(it, it.pct, true); });
          });
        };
        it.card.addEventListener("pointerenter", replay);
        it.card.addEventListener("focus", replay);
      });

      // 减少动态效果 / 没有 IntersectionObserver：直接给答案，不做入场动画
      if (reduce || !("IntersectionObserver" in window)) {
        this.items.forEach(function (it) { self.paint(it, it.pct, false); });
        return;
      }

      var io = new IntersectionObserver(function (entries, obs) {
        entries.forEach(function (e) {
          if (!e.isIntersecting) return;
          obs.unobserve(e.target);
          var it = self.items.filter(function (x) { return x.card === e.target; })[0];
          if (!it) return;
          requestAnimationFrame(function () {
            requestAnimationFrame(function () { self.paint(it, it.pct, true); });
          });
        });
      }, { threshold: 0.2 });
      this.items.forEach(function (it) { io.observe(it.card); });
    },

    /* 百分比优先取 shell.js 写在卡片上的 data-progress-value；
       它还没跑过就自己按 scope 数一遍，两条路结果一致。 */
    read: function (card) {
      var v = card.getAttribute("data-progress-value");
      if (v !== null && v !== "") {
        var n = parseFloat(v);
        if (!isNaN(n)) return Math.max(0, Math.min(100, n));
      }
      var scope = card.getAttribute("data-progress-scope");
      var total = parseInt(card.getAttribute("data-progress-total") || "0", 10);
      if (!scope || !total) return 0;
      var map = readProgress();
      var done = 0;
      for (var k in map) if (map[k] && k.indexOf(scope) === 0) done++;
      return Math.min(100, Math.round(done / total * 100));
    },

    writeNum: function (it) {
      if (it.num) it.num.textContent = Math.round(it.pct) + "%";
    },

    paint: function (it, pct, animate) {
      if (!animate) {
        // 先把过渡关掉再写值，否则「归零」也会被 1000ms 拉成一段倒放
        it.fill.style.transition = "none";
        it.fill.style.strokeDashoffset = String(100 - pct);
        void it.fill.getBoundingClientRect();
        it.fill.style.transition = "";
        return;
      }
      it.fill.style.transition = "";
      it.fill.style.strokeDashoffset = String(100 - pct);
      it.played = true;
    },

    /* 进度变了（读了一节回来）。数字立刻对齐；环只在播过入场的卡片上
       平滑跟上 —— 没露过面的卡保持空环，等它进视口时一次画到新值。 */
    refresh: function () {
      var self = this;
      this.items.forEach(function (it) {
        var pct = self.read(it.card);
        if (pct === it.pct) return;
        it.pct = pct;
        self.writeNum(it);
        if (!it.played) return;
        self.paint(it, pct, true);
      });
    },
  };


  /* --------------------------------------------------- 学习路径：关卡图 */
  /* 连线不能写死坐标：每一站多宽是 flex 按容器算的，换语言（英文标签更长）、
     换字号、窄屏变竖排，坐标全变。所以量出站点圆心的实际位置，再连曲线。 */
  var PathMap = {
    data: null,
    sel: { w: 0, i: 0 },
    ready: false,

    init: function () {
      var el = doc.getElementById("path-data");
      var host = doc.getElementById("paths");
      if (!el || !host || !host.querySelector(".world")) return;
      try { this.data = JSON.parse(el.textContent); } catch (e) { return; }

      this.host = host;
      this.panel = doc.getElementById("path-panel");
      this.ready = true;

      var self = this;
      Array.prototype.slice.call(host.querySelectorAll(".stop")).forEach(function (st) {
        var btn = st.querySelector(".stop__btn");
        if (!btn) return;
        var world = st.parentNode;
        while (world && !world.getAttribute("data-world")) world = world.parentNode;
        if (!world) return;
        var w = parseInt(world.getAttribute("data-world"), 10);
        var i = parseInt(st.getAttribute("data-i"), 10);

        btn.addEventListener("pointerenter", function (e) {
          // 触屏没有 hover：手指抬起后不会配对 pointerleave，会一直停在这个站
          if (e.pointerType && e.pointerType !== "mouse") return;
          self.select(w, i);
        });
        btn.addEventListener("focus", function () { self.select(w, i); });
        btn.addEventListener("click", function () {
          /* 窄屏没有右侧面板：点一下就该进那一章，否则这些按钮点了毫无反应。
             面板只在宽屏存在（见 .paths__panel 的媒体查询）。 */
          if (window.matchMedia("(max-width: 1020px)").matches) {
            var href = this.parentNode.getAttribute("data-href");
            if (href) window.location.href = href;
            return;
          }
          self.select(w, i);
        });
      });

      this.select(0, 0);
      this.draw();

      var relayout = this.debounce(function () { self.draw(); }, 120);
      window.addEventListener("resize", relayout, { passive: true });
      if (window.ResizeObserver) {
        var ro = new ResizeObserver(relayout);
        Array.prototype.slice.call(host.querySelectorAll(".pathmap")).forEach(function (m) {
          ro.observe(m);
        });
      }
      // 字体晚一步落地时标签宽度会变，圆心跟着移
      if (doc.fonts && doc.fonts.ready) doc.fonts.ready.then(function () { self.draw(); });
    },

    debounce: function (fn, wait) {
      var t = null;
      return function () {
        clearTimeout(t);
        t = setTimeout(fn, wait);
      };
    },

    select: function (w, i) {
      if (!this.ready) return;
      this.sel = { w: w, i: i };
      Array.prototype.slice.call(this.host.querySelectorAll(".stop")).forEach(function (st) {
        var world = st.parentNode;
        while (world && !world.getAttribute("data-world")) world = world.parentNode;
        var on = world &&
          parseInt(world.getAttribute("data-world"), 10) === w &&
          parseInt(st.getAttribute("data-i"), 10) === i;
        st.classList.toggle("is-active", !!on);
      });
      this.render();
    },

    render: function () {
      var panel = this.panel;
      if (!panel || !this.data) return;
      var world = this.data.worlds[this.sel.w];
      if (!world) return;
      var st = world.steps[this.sel.i];
      if (!st) return;

      var en = isEn();
      var text = function (o) { return en ? o.en : o.zh; };
      var stopEl = this.host.querySelector(
        '.world[data-world="' + this.sel.w + '"] .stop[data-i="' + this.sel.i + '"]');
      var done = stopEl ? parseInt(stopEl.getAttribute("data-done") || "0", 10) : 0;
      var read = parseFloat(stopEl ? stopEl.getAttribute("data-progress-value") || "0" : "0");
      var finished = done === 1 || read >= 100;

      var chips = (st.concepts[en ? "en" : "zh"] || []).map(function (c) {
        return "<li>" + esc(c) + "</li>";
      }).join("");

      var idx = en
        ? "stop " + (this.sel.i + 1) + " of " + world.steps.length
        : "第 " + (this.sel.i + 1) + " 站，共 " + world.steps.length + " 站";

      panel.innerHTML =
        '<p class="paths__eyebrow">' + esc(world.tag) + " · " + idx + "</p>" +
        '<h3 class="paths__title" id="path-panel-title">' + esc(text(st.title)) + "</h3>" +
        '<ul class="paths__meta">' +
          "<li>" + (en ? "Chapter " + st.ch : "第 " + st.ch + " 章") + "</li>" +
          "<li>" + st.sections + (en ? " sections" : " 节") + "</li>" +
          '<li data-done="' + (finished ? "1" : "0") + '">' +
            (finished ? (en ? "Read" : "已读完") : (en ? "Not read" : "未读")) + "</li>" +
        "</ul>" +
        '<p class="paths__lead">' + esc(text(st.lead)) + "</p>" +
        '<div class="paths__block"><h4>' + (en ? "On this path" : "这条路径里做什么") + "</h4><p>" +
          esc(text(st.note)) + "</p></div>" +
        (chips
          ? '<div class="paths__block"><h4>' + (en ? "Key concepts" : "关键概念") + "</h4>" +
            '<ul class="paths__chips">' + chips + "</ul></div>"
          : "") +
        '<a class="paths__cta" href="' + esc(st.href) + '">' +
          (en ? "Open chapter" : "进入本章") +
          '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5"/></svg>' +
        "</a>";
    },

    draw: function () {
      if (!this.host) return;
      Array.prototype.slice.call(this.host.querySelectorAll(".world")).forEach(function (world) {
        var svg = world.querySelector(".pathmap__wires");
        var dots = Array.prototype.slice.call(world.querySelectorAll(".stop__dot"));
        if (!svg || dots.length < 2) return;

        var box = svg.getBoundingClientRect();
        if (box.width < 2 || box.height < 2) return;

        var w = Math.round(box.width);
        var h = Math.round(box.height);
        svg.setAttribute("viewBox", "0 0 " + w + " " + h);
        svg.setAttribute("width", w);
        svg.setAttribute("height", h);
        svg.innerHTML = "";

        var pts = dots.map(function (d) {
          var r = d.getBoundingClientRect();
          return {
            x: r.left - box.left + r.width / 2,
            y: r.top - box.top + r.height / 2,
            st: d.parentNode.parentNode,
          };
        });

        var all = "";
        for (var i = 0; i < pts.length - 1; i++) {
          var a = pts[i];
          var b = pts[i + 1];
          // 控制点放在两站的水平中点：曲线先从圆顶切线方向离开，再到下一站，
          // 比直接连斜线更像「走」过去的路
          var mx = (a.x + b.x) / 2;
          var d = "M" + a.x + " " + a.y + " C" + mx + " " + a.y + " " + mx + " " + b.y +
                  " " + b.x + " " + b.y;
          all += d;

          var seg = doc.createElementNS(SVG_NS, "path");
          seg.setAttribute("d", d);
          seg.setAttribute("class", "pathmap__seg");
          if (b.st && b.st.getAttribute("data-done") === "1") seg.classList.add("is-done");
          svg.appendChild(seg);
        }

        if (!all) return;
        var flow = doc.createElementNS(SVG_NS, "path");
        flow.setAttribute("d", all);
        flow.setAttribute("class", "pathmap__flow");
        svg.appendChild(flow);
      });
    },
  };

  /* --------------------------------------------------- 顶栏板块导航高亮 */
  /* 顶栏是 sticky 的，滚到哪里都看得见这排链接。既然一直挂在眼前，就得回答
     「我现在在这一页的哪一块」—— 否则它只是一排可以点的字，读者不知道点完会不会
     又回到上面。用 rAF 节流，别再给滚动加第二个监听器。 */
  function spySections() {
    var links = $$(".topnav__link");
    if (!links.length) return;

    var targets = links.map(function (a) {
      return { id: a.getAttribute("data-nav-target"), el: null, link: a };
    }).filter(function (t) { return !!t.id; });

    targets.forEach(function (t) { t.el = doc.getElementById(t.id); });
    var live = targets.filter(function (t) { return t.el; });
    if (!live.length) return;

    var current = null;
    var queued = false;

    function paint() {
      queued = false;
      var top = parseFloat(getComputedStyle(doc.documentElement)
        .getPropertyValue("--topbar-h")) || 56;
      // 判定线放在顶栏下沿再往下一点：标题刚碰到顶栏就算进了这一块
      var line = top + 32;
      var hit = null;
      live.forEach(function (t) {
        var r = t.el.getBoundingClientRect();
        if (r.top <= line) hit = t.id;
      });
      if (hit === current) return;
      current = hit;
      live.forEach(function (t) {
        if (t.id === hit) t.link.setAttribute("aria-current", "true");
        else t.link.removeAttribute("aria-current");
      });
    }

    function onScroll() {
      if (queued) return;
      queued = true;
      requestAnimationFrame(paint);
    }

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    paint();
  }

  function init() {
    markResume();
    markRoutes();
    Rings.init();
    PathMap.init();
    spySections();
    doc.addEventListener("wb:locale", function () {
      markResume();
      markRoutes();
      // 英文标签更长，圆心会挪，连线得重画
      PathMap.render();
      PathMap.draw();
    });
    /* 阅读进度是 shell.js 写的，它可能比这里晚一步跑完 —— 进度一变，
       站点上的「已读完 / 读到 2 / 5」和实线段都要跟着变。 */
    doc.addEventListener("wb:progress", function () {
      markRoutes();
      Rings.refresh();
      PathMap.render();
      PathMap.draw();
    });
    if ("IntersectionObserver" in window) {
      var io = new IntersectionObserver(function (entries, obs) {
        entries.forEach(function (e) {
          if (!e.isIntersecting) return;
          countUp();
          obs.disconnect();
        });
      }, { threshold: 0.4 });
      var stats = doc.querySelector(".portal-stats");
      if (stats) io.observe(stats);
    }
  }

  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", init);
  else init();
})();
