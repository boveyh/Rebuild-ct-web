/* ============================================================================
   lesson.js —— 章节页运行时（按需加载演示）
   ----------------------------------------------------------------------------
   原站的 lesson.js 在页面打开时就把整章的演示代码全部解析并执行，
   而 D3 也一并下载。这对读者是纯浪费：想读「讲解」的人也被迫下载了
   「演示」用的全部代码。

   这里改成：只有当某个小节的「演示」标签页真的被打开时，才去
   import 对应章节的演示模块。第 1 章的演示模块 17 KB、第 3 章 33 KB，
   而且每个都带 d3 —— 省下的这一笔是实打实的。
   ========================================================================= */

import { applyTo, observe, setLocale } from "./demo-i18n.js";

(function () {
  "use strict";

  var doc = document;
  var $$ = function (sel, ctx) { return Array.prototype.slice.call((ctx || doc).querySelectorAll(sel)); };

  var LOADING = { zh: "正在加载演示…", en: "Loading demo…" };
  var FAILED = {
    zh: "演示没能加载。可能是网络无法访问 D3.js 的 CDN。\n" +
        "如果你在离线环境，请把 d3 放到本地并把 assets/js/demos 顶部的 import 地址改成本地路径。",
    en: "The demo failed to load. The D3.js CDN may be unreachable.\n" +
        "For offline use, host d3 locally and repoint the import in assets/js/demos."
  };

  var modules = {};   // moduleId -> Promise<registry>

  function locale() {
    return (doc.documentElement.getAttribute("data-locale") || "zh") === "en" ? "en" : "zh";
  }

  // 演示模块按两位编号命名（ch01.js … ch05.js），而页面上的
  // data-demo-chapter 写的是 "1"。不补零就会拼出 ./demos/ch1.js ——
  // 整个演示区一次都加载不出来，而且报的还是「CDN 不可达」，
  // 把排查方向带偏。这里统一补零，两种写法都能命中。
  function moduleId(chapterId) {
    var s = String(chapterId || "").trim();
    return s.length < 2 ? "0" + s : s;
  }

  function loadChapter(chapterId) {
    var id = moduleId(chapterId);
    if (modules[id]) return modules[id];
    var p = import("./demos/ch" + id + ".js")
      .then(function (m) { return m.default || {}; })
      .catch(function (err) {
        delete modules[id];   // 允许重试
        throw err;
      });
    modules[id] = p;
    return p;
  }

  function setState(mount, state, text) {
    mount.setAttribute("data-state", state);
    var box = mount.querySelector(".demo-state");
    if (!box) {
      box = doc.createElement("p");
      box.className = "demo-state";
      mount.insertBefore(box, mount.firstChild);
    }
    box.textContent = text;
  }

  /* 演示里有不少画布只有 width/height、没有 viewBox。站点给 svg 设了
     max-width:100% + height:auto，这种画布被压窄之后内容并不跟着缩放 ——
     浏览器照原坐标画，超出框的部分直接被裁掉。第 3 章「CVD 论文图」的
     缩略图就是这样：三张 220×110 的图挤进 84px 的列里，只剩左上角一块，
     正常/红盲/绿盲三行只看得见第一行。
     补一个等价的 viewBox，SVG 就会等比缩放，整张图至少是完整的。 */
  function fitCanvases(mount) {
    $$("svg", mount).forEach(function (s) {
      if (s.hasAttribute("viewBox")) return;
      var w = parseFloat(s.getAttribute("width"));
      var h = parseFloat(s.getAttribute("height"));
      if (w > 0 && h > 0) s.setAttribute("viewBox", "0 0 " + w + " " + h);
    });
  }

  /* 演示常常在 await 之后才把图插进来（要先把 csv 拉下来），
     所以挂一个观察器再补几次；本身是幂等的，改属性不会触发 childList。 */
  function watchCanvases(mount) {
    if (!window.MutationObserver) return;
    var mo = new MutationObserver(function () { fitCanvases(mount); });
    mo.observe(mount, { childList: true, subtree: true });
  }

  function runDemo(mount) {
    if (!mount || mount.getAttribute("data-ready") === "1") return;

    var chapterId = mount.getAttribute("data-demo-chapter");
    var demoKey = mount.getAttribute("data-demo");
    if (!chapterId || !demoKey) return;

    if (mount.getAttribute("data-state") === "loading") return;
    mount.setAttribute("data-state", "loading");
    setState(mount, "loading", LOADING[locale()]);

    loadChapter(chapterId).then(function (registry) {
      var fn = registry[demoKey];
      if (typeof fn !== "function") {
        setState(mount, "error", "演示 " + demoKey + " 未注册。");
        return;
      }
      var box = mount.querySelector(".demo-state");
      if (box) box.remove();
      mount.removeAttribute("data-state");
      mount.setAttribute("data-ready", "1");
      try {
        fn(mount);
      } catch (err) {
        mount.setAttribute("data-state", "error");
        setState(mount, "error", "演示运行出错：" + (err && err.message ? err.message : err));
        if (window.console) console.error("[demo " + chapterId + "/" + demoKey + "]", err);
      }
      // 演示的文案是运行时生成的，双语层只能在这里接手：
      // 先挂 MutationObserver（演示常在 await 之后才画完），当前是英文就立刻翻一遍。
      observe(mount);
      if (locale() === "en") applyTo(mount);
      fitCanvases(mount);
      watchCanvases(mount);
    }).catch(function (err) {
      mount.setAttribute("data-state", "error");
      setState(mount, "error", FAILED[locale()]);
      if (window.console) console.warn("[demo load]", err);
    });
  }

  function init() {
    var mounts = $$(".demo-mount[data-demo]");
    if (!mounts.length) return;

    // 已经处于选中状态的演示面板，立刻加载
    mounts.forEach(function (mount) {
      var panel = mount.closest(".tab-panel");
      if (panel && panel.getAttribute("data-active") === "true") runDemo(mount);
    });

    // 其余等面板第一次显示时再加载
    $$(".tab-panel[data-panel=\"demo\"]").forEach(function (panel) {
      panel.addEventListener("wb:revealed", function () {
        if (panel.getAttribute("data-active") !== "true") return;
        $$(".demo-mount[data-demo]", panel).forEach(runDemo);
      });
    });

    // 语言切换后，把还停在加载/失败态的文案刷新一下
    doc.addEventListener("wb:locale", function () {
      $$(".demo-mount[data-state]").forEach(function (m) {
        var s = m.getAttribute("data-state");
        if (s === "loading") setState(m, "loading", LOADING[locale()]);
        if (s === "error") setState(m, "error", FAILED[locale()]);
      });
      // 已经渲染好的演示：英文就按词典翻一遍，中文就从 WeakMap 里还原。
      // 不重跑演示，读者拖过的滑块、展开的节点都还在。
      setLocale(locale());
    });

    // 演示区里常常有 resvg / 动态尺寸，窗口变化后通知一次
    var t;
    window.addEventListener("resize", function () {
      clearTimeout(t);
      t = setTimeout(function () {
        doc.dispatchEvent(new CustomEvent("wb:resize"));
      }, 180);
    });
  }

  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", init);
  else init();

  window.WBLesson = { runDemo: runDemo };
})();
