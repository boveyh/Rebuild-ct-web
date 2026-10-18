/* ============================================================================
   enhance.js —— 内容增强（渐进增强，禁用 JS 时内容依然完整可读）
   ----------------------------------------------------------------------------
   1. 代码块     加语言标签 / 复制按钮 / 行号 / 关键行高亮
   2. 表格       从表头推导窄屏卡片态所需的 data-label
   3. 锚点       为小节标题加可复制的深链接
   4. 外部链接   标注并在新标签页打开
   全部基于原文已经写好的语义化标记，不做内容改写。
   ========================================================================= */

(function () {
  "use strict";

  var doc = document;
  var $$ = function (sel, ctx) { return Array.prototype.slice.call((ctx || doc).querySelectorAll(sel)); };
  var $ = function (sel, ctx) { return (ctx || doc).querySelector(sel); };

  /* ==================================================== 1. 代码块重构 */
  var LANGS = {
    "lang-js": "JavaScript",
    "lang-json": "JSON",
    "lang-html": "HTML",
    "lang-css": "CSS",
    "lang-bash": "Shell",
    "lang-sh": "Shell",
    "lang-py": "Python",
    "lang-sql": "SQL"
  };

  var ICON_COPY =
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<rect x="9" y="9" width="11" height="11" rx="2"/>' +
    '<path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>';
  var ICON_DONE =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12.5l5 5L20 6.5"/></svg>';

  /** 把 <code> 的内容切成「行」，同时保留语法高亮 span。
      做法：先把子树压平成 {text, cls} 片段（累积祖先的 class），再按 \n 切分。 */
  function flatten(node, inherit, out) {
    for (var i = 0; i < node.childNodes.length; i++) {
      var child = node.childNodes[i];
      if (child.nodeType === 3) {
        out.push({ text: child.nodeValue, cls: inherit });
      } else if (child.nodeType === 1) {
        if (child.tagName === "BR") { out.push({ text: "\n", cls: inherit }); continue; }
        var cls = inherit;
        var own = child.getAttribute("class");
        if (own) cls = inherit ? inherit + " " + own : own;
        flatten(child, cls, out);
      }
    }
  }

  function buildLines(codeEl) {
    var segs = [];
    flatten(codeEl, "", segs);

    var lines = [];
    var cur = [];
    segs.forEach(function (seg) {
      var parts = String(seg.text).split("\n");
      for (var i = 0; i < parts.length; i++) {
        if (i > 0) { lines.push(cur); cur = []; }
        if (parts[i] !== "") cur.push({ text: parts[i], cls: seg.cls });
      }
    });
    lines.push(cur);
    return lines;
  }

  function renderLines(codeEl, lines) {
    var frag = doc.createDocumentFragment();
    lines.forEach(function (segs, i) {
      var line = doc.createElement("span");
      line.className = "cl";
      line.setAttribute("data-ln", String(i + 1));

      var starred = false;
      segs.forEach(function (seg) {
        if (/\bstar\b/.test(seg.cls)) starred = true;
        var s = doc.createElement("span");
        if (seg.cls) s.className = seg.cls;
        s.textContent = seg.text;
        line.appendChild(s);
      });

      if (starred) line.setAttribute("data-star", "1");
      frag.appendChild(line);
    });

    codeEl.textContent = "";
    codeEl.appendChild(frag);
  }

  function plainText(codeEl) {
    return $$(".cl", codeEl).map(function (l) { return l.textContent; }).join("\n");
  }

  function buildCodeBlock(pre) {
    var code = pre.querySelector("code");
    if (!code || pre.closest(".code-block")) return;

    var lines = buildLines(code);
    renderLines(code, lines);

    var wrapper = doc.createElement("div");
    wrapper.className = "code-block";
    if (lines.length > 3) wrapper.classList.add("code-block--numbered");

    // 语言标签
    var langKey = null;
    (code.getAttribute("class") || "").split(/\s+/).some(function (c) {
      if (LANGS[c]) { langKey = c; return true; }
      return false;
    });

    var bar = doc.createElement("div");
    bar.className = "code-block__bar";

    var lang = doc.createElement("span");
    lang.className = "code-block__lang";
    lang.textContent = LANGS[langKey] || "Code";
    bar.appendChild(lang);

    // 若代码块上方紧跟「代码目的」说明，把它挪进标题栏，正文区就更干净
    var prev = pre.previousElementSibling;
    if (prev && prev.classList.contains("code-purpose")) {
      var note = doc.createElement("span");
      note.className = "code-block__note";
      note.textContent = prev.textContent.replace(/\s+/g, " ").trim();
      bar.appendChild(note);
      prev.setAttribute("data-moved", "true");
      prev.style.display = "none";
    }

    var actions = doc.createElement("div");
    actions.className = "code-block__actions";

    // 关键行计数：告诉读者「这一块里有几处必须看懂」
    var stars = $$('[data-star="1"]', code).length;
    if (stars) {
      var badge = doc.createElement("span");
      badge.className = "code-block__lang";
      badge.style.color = "var(--viz-2)";
      badge.textContent = stars + " key";
      actions.appendChild(badge);
    }

    var copy = doc.createElement("button");
    copy.type = "button";
    copy.className = "code-block__btn";
    copy.setAttribute("data-copy", "1");
    copy.innerHTML = ICON_COPY + "<span>复制</span>";
    copy.addEventListener("click", function () {
      var text = plainText(code);
      var done = function () {
        copy.setAttribute("data-copied", "true");
        copy.innerHTML = ICON_DONE + "<span>已复制</span>";
        setTimeout(function () {
          copy.removeAttribute("data-copied");
          copy.innerHTML = ICON_COPY + "<span>复制</span>";
        }, 1800);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
      } else {
        fallbackCopy(text, done);
      }
    });
    actions.appendChild(copy);
    bar.appendChild(actions);

    pre.parentNode.insertBefore(wrapper, pre);
    wrapper.appendChild(bar);
    wrapper.appendChild(pre);
  }

  function fallbackCopy(text, done) {
    var ta = doc.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
    doc.body.appendChild(ta);
    ta.select();
    try { doc.execCommand("copy"); done(); } catch (e) { /* 忽略 */ }
    doc.body.removeChild(ta);
  }

  /* ========================================================= 2. 表格增强 */
  function enhanceTables() {
    $$("table").forEach(function (table) {
      if (table.getAttribute("data-enhanced")) return;
      table.setAttribute("data-enhanced", "1");

      var headCells = $$("thead tr:last-child th", table);
      if (headCells.length) {
        $$("tbody tr", table).forEach(function (tr) {
          $$("td", tr).forEach(function (td, i) {
            if (headCells[i] && !td.hasAttribute("data-label")) {
              td.setAttribute("data-label", headCells[i].textContent.trim());
            }
          });
        });
      }

      // 宽表在窄屏需要横向滚动，给它键盘入口与无障碍名字
      if (table.scrollWidth > 0 && !table.parentElement.classList.contains("table-scroll")) {
        var wrap = doc.createElement("div");
        wrap.className = "table-scroll";
        wrap.setAttribute("role", "region");
        wrap.setAttribute("aria-label", "数据表格，可横向滚动");
        wrap.setAttribute("tabindex", "0");
        table.parentNode.insertBefore(wrap, table);
        wrap.appendChild(table);
      }
    });
  }

  /* =================================================== 3. 小标题深链接 */
  var ICON_LINK =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1 1"/>' +
    '<path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1-1"/></svg>';

  function enhanceHeadings() {
    $$(".section__title[id], .tab-panel h3[id]").forEach(function (h) {
      if ($(".heading-anchor", h)) return;
      var a = doc.createElement("a");
      a.className = "heading-anchor";
      a.href = "#" + h.id;
      a.setAttribute("aria-label", "复制本节链接：" + h.textContent.trim());
      a.innerHTML = ICON_LINK;
      a.addEventListener("click", function () {
        var url = location.origin + location.pathname + "#" + h.id;
        if (navigator.clipboard) navigator.clipboard.writeText(url);
        if (window.WB) window.WB.toast("链接已复制：" + h.id);
      });
      h.appendChild(a);
    });
  }

  /* ====================================================== 4. 外部链接标记 */
  function enhanceLinks() {
    $$('a[href^="http"]').forEach(function (a) {
      if (a.hostname === location.hostname) return;
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
      if (!a.getAttribute("title")) a.setAttribute("title", a.textContent.trim() + "（新窗口打开）");
    });
  }

  /* ====================================================== 5. 图片懒加载 */
  function enhanceImages() {
    $$("img").forEach(function (img) {
      if (!img.hasAttribute("loading")) img.setAttribute("loading", "lazy");
      if (!img.hasAttribute("decoding")) img.setAttribute("decoding", "async");
    });
  }

  /* ==================================================== 6. 图片点击放大
     这门课的不少图本身就是内容：Mackinlay 1986 的通道排序图有 1205×779，
     正文里最宽只能占到 920px，上面的小字和刻度基本看不清。放大不是锦上添花，
     是把原本传不过去的信息补回来。

     用 <dialog> 而不是自建遮罩：ESC 关闭、焦点陷阱、backdrop 都是浏览器给的，
     少写一堆还更可靠。图片本身不加 role="button" —— 那会覆盖掉 <img> 的语义，
     读屏用户就听不到 alt 了；改用 tabindex + aria-haspopup 表达「可打开」。 */
  function enhanceImageZoom() {
    var imgs = $$(".content img, .topic img").filter(function (img) {
      // 用构建期写进属性的 width 判断，而不是 naturalWidth：图是 lazy 的，
      // 视口外的图此刻还没加载，naturalWidth 是 0，会被误判成图标跳过。
      var declared = parseInt(img.getAttribute("width"), 10) || 0;
      return declared >= 200 && !img.closest("a");
    });
    if (!imgs.length) return;

    var dlg = doc.createElement("dialog");
    dlg.className = "img-zoom";
    dlg.setAttribute("aria-label", "图片放大");
    dlg.innerHTML =
      '<button class="img-zoom__close" type="button" aria-label="关闭">' +
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>' +
      "</button>" +
      '<figure class="img-zoom__body">' +
        '<img alt="" />' +
        "<figcaption></figcaption>" +
      "</figure>";
    doc.body.appendChild(dlg);

    var big = dlg.querySelector("img");
    var cap = dlg.querySelector("figcaption");

    function open(src, alt, w, h) {
      big.src = src;
      big.alt = alt || "";
      big.width = w || "";
      big.height = h || "";
      cap.textContent = alt || "";
      cap.hidden = !alt;
      if (typeof dlg.showModal === "function") dlg.showModal();
      else dlg.setAttribute("open", "true");
    }

    function close() {
      if (typeof dlg.close === "function") dlg.close();
      else dlg.removeAttribute("open");
    }

    // 点关闭按钮；点图片外的空白也关（<dialog> 的点击目标是它自己时说明点在了
    // 内容区的留白处，而不是图或文字上）
    dlg.querySelector(".img-zoom__close").addEventListener("click", close);
    dlg.addEventListener("click", function (e) {
      if (e.target === dlg) close();
    });

    imgs.forEach(function (img) {
      img.classList.add("is-zoomable");
      img.setAttribute("aria-haspopup", "dialog");
      var alt = img.getAttribute("alt") || "";
      if (alt) img.setAttribute("title", alt + "（点击放大）");

      function fire() {
        // 章节页一个图片可能同时存在于「讲解」和「关键代码」两个面板里，
        // 只有一个面板是显示的。隐藏时不该响应，否则会弹出一张读者没看到的图。
        if (!img.getClientRects().length) return;
        open(img.currentSrc || img.src, alt, img.naturalWidth, img.naturalHeight);
      }
      img.addEventListener("click", fire);
      img.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          fire();
        }
      });
    });

    /* 只有当前可见面板里的图才进 Tab 序列。
       否则按 Tab 会在整页里"路过"一串看不见的图片 —— 焦点莫名其妙消失，
       键盘用户完全不知道发生了什么。切换 tab 后重新同步一次。 */
    function syncTabindex() {
      imgs.forEach(function (img) {
        img.setAttribute("tabindex", img.getClientRects().length ? "0" : "-1");
      });
    }
    syncTabindex();

    doc.addEventListener("click", function (e) {
      if (e.target.closest && e.target.closest("[data-tab]")) {
        setTimeout(syncTabindex, 80);
      }
    }, true);
  }

  /* ============================================================== 启动 */
  function boot() {
    try {
      $$("pre").forEach(buildCodeBlock);
      enhanceTables();
      enhanceHeadings();
      enhanceLinks();
      enhanceImages();
      enhanceImageZoom();
    } catch (e) {
      // 增强失败不能影响正文阅读
      if (window.console) console.warn("[enhance]", e);
    }
  }

  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", boot);
  else boot();

  window.WBEnhance = { rebuild: boot };
})();
