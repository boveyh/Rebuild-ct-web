/* ============================================================================
   conceptmap.js —— 分层有向图渲染器（零依赖，约 6 KB）
   ----------------------------------------------------------------------------
   用来画两处新增的可视化：
     · 门户页的「课程主线」—— 五章之间的依赖关系
     · 每章顶部的「概念依赖图」—— 本章知识点之间的依赖关系
   两处共用同一份实现，数据以 JSON 内嵌在页面里。

   为什么不用 D3：门户页和概念图都不需要数据驱动的力导向布局，
   一个 20 行的分层布局算法就够了。为它引入整个 D3 会让门户页多下载约 280 KB，
   而门户页恰恰是读者第一个打开的页面。
   ========================================================================= */

(function () {
  "use strict";

  var NS = "http://www.w3.org/2000/svg";
  var doc = document;

  var GAP_X = 68;      // 列间距
  var GAP_Y = 18;      // 同列节点间距
  var PAD = 12;
  var NODE_H = 48;

  function el(name, attrs) {
    var n = doc.createElementNS(NS, name);
    for (var k in attrs) if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    return n;
  }

  function cssVar(name, fallback) {
    var v = getComputedStyle(doc.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function measure(text, size, cjkFraction) {
    // 中文按 1 字宽、拉丁按约 0.55 字宽估算，只用于给盒子定宽
    var w = 0;
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      w += (c > 0x2e80) ? size : size * (cjkFraction || 0.56);
    }
    return w;
  }

  function layout(data, locale) {
    var nodes = data.nodes.map(function (n) {
      var label = locale === "en" ? (n.en || n.zh) : n.zh;
      var sub = n.num != null ? String(n.num) : "";
      var w = measure(label, 13.5) + PAD * 2;
      if (sub) w = Math.max(w, measure(label, 13.5) + PAD * 2);
      return { id: n.id, d: n.d || 0, label: label, sub: sub, w: Math.max(w, 96) };
    });

    var byId = {};
    nodes.forEach(function (n) { byId[n.id] = n; });

    var cols = {};
    nodes.forEach(function (n) { (cols[n.d] = cols[n.d] || []).push(n); });

    var depths = Object.keys(cols).map(Number).sort(function (a, b) { return a - b; });
    var maxRows = Math.max.apply(null, depths.map(function (d) { return cols[d].length; }));
    var totalH = maxRows * NODE_H + (maxRows - 1) * GAP_Y;

    var x = PAD;
    depths.forEach(function (d) {
      var colW = Math.max.apply(null, cols[d].map(function (n) { return n.w; }));
      var colH = cols[d].length * NODE_H + (cols[d].length - 1) * GAP_Y;
      var y = PAD + (totalH - colH) / 2;
      cols[d].forEach(function (n) {
        n.x = x;
        n.y = y;
        n.w = colW;               // 同列等宽，视觉上成一列
        n.h = NODE_H;
        y += NODE_H + GAP_Y;
      });
      x += colW + GAP_X;
    });

    return {
      width: x - GAP_X + PAD * 2,
      height: totalH + PAD * 2,
      nodes: nodes,
      byId: byId,
    };
  }

  function edgePath(a, b, loopBelow) {
    var x1 = a.x + a.w;
    var y1 = a.y + a.h / 2;
    var x2 = b.x;
    var y2 = b.y + b.h / 2;
    var mx = (x1 + x2) / 2;

    if (b.d <= a.d || loopBelow) {
      // 回指边：从下方绕回去，避免与向前的边交叉
      var yBase = Math.max(a.y + a.h, b.y + b.h) + 26;
      return "M" + x1 + " " + y1 +
             " C" + (x1 + 30) + " " + yBase + " " + (x2 - 30) + " " + yBase +
             " " + x2 + " " + (y2 + b.h / 2 + 2);
    }
    return "M" + x1 + " " + y1 + " C" + mx + " " + y1 + " " + mx + " " + y2 + " " + x2 + " " + y2;
  }

  function render(host, data, opts) {
    opts = opts || {};
    var locale = (doc.documentElement.getAttribute("data-locale") || "zh") === "en" ? "en" : "zh";
    var L = layout(data, locale);

    var cText = cssVar("--text-1", "#161c24");
    var cSub = cssVar("--text-3", "#6b7688");
    var cLine = cssVar("--border-3", "#ccd4de");
    var cAccent = cssVar("--brand", "#3d4bc0");
    var cSurface = cssVar("--bg-surface", "#ffffff");
    var cBorder = cssVar("--border-2", "#e3e8ef");
    var palettes = ["--viz-1", "--viz-2", "--viz-3", "--viz-4", "--viz-5", "--viz-6"];

    host.textContent = "";
    var svg = el("svg", {
      viewBox: "0 0 " + Math.round(L.width) + " " + Math.round(L.height),
      width: "100%",
      role: "img",
      "aria-label": opts.label || "",
      preserveAspectRatio: "xMidYMid meet",
    });
    svg.style.maxWidth = L.width + "px";
    svg.style.minWidth = Math.min(L.width, 640) + "px";

    var defs = el("defs");
    var marker = el("marker", {
      id: "cm-arrow", viewBox: "0 0 10 10", refX: "8", refY: "5",
      markerWidth: "6", markerHeight: "6", orient: "auto-start-reverse",
    });
    marker.appendChild(el("path", {
      d: "M2 1L8 5L2 9", fill: "none", stroke: cLine,
      "stroke-width": "1.5", "stroke-linecap": "round", "stroke-linejoin": "round",
    }));
    defs.appendChild(marker);
    svg.appendChild(defs);

    // 先画边，节点压在边上面
    (data.edges || []).forEach(function (pair) {
      var a = L.byId[pair[0]], b = L.byId[pair[1]];
      if (!a || !b) return;
      svg.appendChild(el("path", {
        d: edgePath(a, b), fill: "none", stroke: cLine,
        "stroke-width": "1.5", "marker-end": "url(#cm-arrow)",
        opacity: "0.9",
      }));
    });

    if (data.loop) {
      var a = L.byId[data.loop[0]], b = L.byId[data.loop[1]];
      if (a && b) {
        svg.appendChild(el("path", {
          d: edgePath(a, b, true), fill: "none", stroke: cAccent,
          "stroke-width": "1.5", "stroke-dasharray": "5 4",
          "marker-end": "url(#cm-arrow)", opacity: "0.85",
        }));
      }
    }

    L.nodes.forEach(function (n, i) {
      var g = el("g");
      var accent = cssVar(palettes[n.d % palettes.length], cAccent);
      var box = el("rect", {
        x: n.x, y: n.y, width: n.w, height: n.h, rx: 10,
        fill: cSurface, stroke: cBorder, "stroke-width": "1",
      });
      g.appendChild(box);
      // 左侧色条：用色相区分层级，而不是用整块底色（整块底色会压过文字）
      g.appendChild(el("rect", {
        x: n.x, y: n.y, width: 3, height: n.h, rx: 1.5, fill: accent,
      }));

      var t = el("text", {
        x: n.x + n.w / 2, y: n.y + n.h / 2 + 0.5,
        "text-anchor": "middle", "dominant-baseline": "central",
        fill: cText, "font-size": "13.5", "font-weight": "500",
        "font-family": "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
      });
      t.textContent = n.label;
      g.appendChild(t);

      svg.appendChild(g);
    });

    host.appendChild(svg);
  }

  function init() {
    var host = doc.getElementById("concept-map") || doc.getElementById("roadmap");
    if (!host) return;
    var holder = doc.getElementById(doc.getElementById("concept-map") ? "concept-data" : "roadmap-data");
    if (!holder) return;

    var data;
    try { data = JSON.parse(holder.textContent); } catch (e) { return; }

    var opts = {};
    if (host.id === "roadmap") {
      opts.label = "课程主线：五章的依赖关系";
      // 门户用的数据没有 d 字段，按声明顺序排成一列
      data = { nodes: data.nodes.map(function (n, i) {
        return { id: n.id, zh: n.zh, en: n.en, num: n.num, d: i };
      }), edges: data.edges };
    } else {
      opts.label = "本章概念依赖图";
    }

    function draw() { render(host, data, opts); }
    draw();
    doc.addEventListener("wb:locale", draw);
    // 主题切换会改变 CSS 变量，图里的取色需要跟着重取
    new MutationObserver(draw).observe(doc.documentElement, {
      attributes: true, attributeFilter: ["data-theme"],
    });
  }

  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", init);
  else init();

  window.WBConceptMap = { render: render };
})();
