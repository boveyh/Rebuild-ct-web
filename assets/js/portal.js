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
    var map;
    try { map = JSON.parse(localStorage.getItem("wb.progress") || "{}"); } catch (e) { return; }
    var en = document.documentElement.getAttribute("data-locale") === "en";

    $$(".route").forEach(function (card) {
      var meter = card.querySelector("[data-route-meter]");
      if (!meter) return;
      var steps = Array.prototype.slice.call(card.querySelectorAll(".route__step"));
      var done = 0;

      steps.forEach(function (st) {
        var scope = st.getAttribute("data-progress-scope");
        var total = parseInt(st.getAttribute("data-progress-total") || "0", 10);
        if (!scope || !total) return;
        var n = 0;
        for (var k in map) if (map[k] && k.indexOf(scope) === 0) n++;
        if (n >= total) done++;
      });

      if (!done) {
        meter.hidden = true;
        meter.removeAttribute("data-state");
        return;
      }
      meter.hidden = false;
      meter.setAttribute("data-state", done === steps.length ? "done" : "partial");
      meter.textContent = en
        ? done + " of " + steps.length + " chapters read"
        : "已读 " + done + " / " + steps.length + " 章";
    });
  }

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
    spySections();
    doc.addEventListener("wb:locale", function () {
      markResume();
      markRoutes();
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
