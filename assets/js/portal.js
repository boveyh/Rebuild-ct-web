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
    var badge = doc.createElement("span");
    badge.className = "chapter-card__resume";
    badge.textContent = "继续 · 已读 " + best.done + " / " + best.total;
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

  function init() {
    markResume();
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
