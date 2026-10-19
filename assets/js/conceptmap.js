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
  var NUM_W = 20;      // 节点里那个「01」章号的占位宽

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

  function measureNodes(data, locale) {
    return data.nodes.map(function (n) {
      var label = locale === "en" ? (n.en || n.zh) : n.zh;
      var sub = n.num != null ? String(n.num) : "";
      var w = measure(label, 13.5) + PAD * 2 + (sub ? NUM_W : 0);
      return { id: n.id, d: n.d || 0, label: label, sub: sub, w: Math.max(w, 96) };
    });
  }

  function index(nodes) {
    var byId = {};
    nodes.forEach(function (n) { byId[n.id] = n; });
    return byId;
  }

  /* 横向分层：宽屏用。层级从左到右，同层上下并列。 */
  function layout(data, locale) {
    var nodes = measureNodes(data, locale);
    var byId = index(nodes);

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

  /* 竖向树：窄屏用。一行一个节点，按层级缩进，靠 L 形折线连接。
     横向分层在 390px 手机上要 553px 宽，只能横向滚动 —— 而横滚没有
     任何可见提示，读者看到 01、02 就以为图到此为止，三条支线全在屏幕外。
     竖排虽然长一点，但一眼看完，也不需要横滚。 */
  function layoutTree(data, locale) {
    var INDENT = 26;
    var nodes = measureNodes(data, locale);
    var byId = index(nodes);
    var ordered = nodes.slice().sort(function (a, b) { return a.d - b.d; });

    var maxRight = 0;
    ordered.forEach(function (n, i) {
      n.x = PAD + n.d * INDENT;
      n.y = PAD + i * (NODE_H + GAP_Y);
      n.h = NODE_H;
      maxRight = Math.max(maxRight, n.x + n.w);
    });

    return {
      width: maxRight + PAD * 2,
      height: PAD * 2 + ordered.length * NODE_H + (ordered.length - 1) * GAP_Y,
      nodes: nodes,
      byId: byId,
    };
  }

  /* 由依赖边反推层级（最长路径分层）。
     门户页原本按声明顺序给 d，五章就排成一条直线 —— 但 03/04/05 其实是
     挂在 02 下面的三条并列支线，画成直线等于告诉读者「必须按顺序一路学完」，
     与导览词里「颜色单独成章、低维与时序并行实战」的说法自相矛盾。
     图很小（≤10 个节点），用最朴素的多轮松弛就够，不需要拓扑排序。 */
  function layering(nodes, edges) {
    var depth = {};
    nodes.forEach(function (n) { depth[n.id] = 0; });
    for (var pass = 0; pass < nodes.length; pass++) {
      var changed = false;
      (edges || []).forEach(function (e) {
        if (depth[e[0]] == null || depth[e[1]] == null) return;
        if (depth[e[1]] < depth[e[0]] + 1) { depth[e[1]] = depth[e[0]] + 1; changed = true; }
      });
      if (!changed) break;
    }
    return depth;
  }

  /* 传递约简：若 a→c 还能经由 a→b→c 走到，这条边就是冗余的。
     留着它不仅多一条线，在分层布局里还会横穿中间那一列的节点。
     01→03 正是这种情况（01→02→03），去掉后图的含义不变。 */
  function reduceEdges(nodes, edges) {
    var adj = {};
    (edges || []).forEach(function (e) { (adj[e[0]] = adj[e[0]] || []).push(e[1]); });
    function reachable(from, to) {
      var seen = {}, stack = (adj[from] || []).slice();
      while (stack.length) {
        var cur = stack.pop();
        if (cur === to) return true;
        if (seen[cur]) continue;
        seen[cur] = 1;
        (adj[cur] || []).forEach(function (n) { stack.push(n); });
      }
      return false;
    }
    return (edges || []).filter(function (e) {
      // 临时摘掉这条边，看是否仍能到达
      var saved = adj[e[0]];
      adj[e[0]] = saved.filter(function (x) { return x !== e[1]; });
      var bypass = reachable(e[0], e[1]);
      adj[e[0]] = saved;
      return !bypass;
    });
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

  /* 树形折线：从父节点左下角的「脊」竖直下落，到子节点中线再横过去。
     脊线取 x + 12（落在左侧色条右侧），因为所有子节点都缩进了 26px，
     脊线永远在它们的左边，不会穿过任何一个兄弟节点。 */
  function edgeTree(a, b) {
    var x1 = a.x + 12;
    var y1 = a.y + a.h;
    var y2 = b.y + b.h / 2;
    return "M" + x1 + " " + y1 + " V" + y2 + " H" + b.x;
  }

  /* 回指边（如第 2 章「交互 → 数据变换」）在树里要从最下面绕回最左边：
     直接走 edgeTree 会向上穿过中间的兄弟节点。 */
  function edgeTreeLoop(a, b) {
    var yBase = a.y + a.h + 16;
    var xSide = 6;                 // 所有节点都从 PAD(12) 起排，6 一定在它们左边
    return "M" + (a.x + a.w / 2) + " " + (a.y + a.h) + " V" + yBase +
           " H" + xSide + " V" + (b.y + b.h / 2) + " H" + b.x;
  }

  function render(host, data, opts) {
    opts = opts || {};
    var locale = (doc.documentElement.getAttribute("data-locale") || "zh") === "en" ? "en" : "zh";
    var tree = opts.tree;
    var L = tree ? layoutTree(data, locale) : layout(data, locale);

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
    // 树形布局本身就是窄的，不需要 min-width 撑开；横向布局在窄屏靠横滚看全
    svg.style.minWidth = tree ? "" : Math.min(L.width, 640) + "px";

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
        d: tree ? edgeTree(a, b) : edgePath(a, b), fill: "none", stroke: cLine,
        "stroke-width": "1.5", "marker-end": "url(#cm-arrow)",
        "stroke-linejoin": "round",
        opacity: "0.9",
      }));
    });

    if (data.loop) {
      var a = L.byId[data.loop[0]], b = L.byId[data.loop[1]];
      if (a && b) {
        svg.appendChild(el("path", {
          d: tree ? edgeTreeLoop(a, b) : edgePath(a, b, true), fill: "none", stroke: cAccent,
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

      // 章号（只有门户主线图有）。图和下方章节卡片之间原本没有任何共同的
      // 视觉锚点，读者得靠标题文字自己配对；标上号就能一一对应。
      if (n.sub) {
        var num = el("text", {
          x: n.x + PAD - 1, y: n.y + n.h / 2 + 0.5,
          "dominant-baseline": "central", "text-anchor": "start",
          fill: accent, "font-size": "10.5", "font-weight": "700",
          "font-family": "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
        });
        num.textContent = n.sub.length < 2 ? "0" + n.sub : n.sub;
        g.appendChild(num);
      }

      var t = el("text", {
        x: n.x + n.w / 2 + (n.sub ? NUM_W / 2 : 0), y: n.y + n.h / 2 + 0.5,
        "text-anchor": "middle", "dominant-baseline": "central",
        fill: cText, "font-size": "13.5", "font-weight": "500",
        "font-family": "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
      });
      t.textContent = n.label;
      g.appendChild(t);

      svg.appendChild(g);
    });

    host.appendChild(svg);

    /* 首次绘制时让节点依次浮上来、连线随后淡入。
       用 WAAPI 而不是给 SVG 写 CSS class：图每次切主题/语言都会重绘，
       CSS 动画不会重放，而这里可以显式控制「只在第一次播」。
       动效可关，且不影响任何数据 —— 图本身在动画开始前就已完整。 */
    if (opts.animate && !reducedMotion() && svg.animate) {
      var groups = svg.querySelectorAll("g");
      for (var gi = 0; gi < groups.length; gi++) {
        groups[gi].animate(
          [{ opacity: 0, transform: "translateY(5px)" }, { opacity: 1, transform: "none" }],
          { duration: 340, delay: 40 + gi * 55, easing: "cubic-bezier(.22,.61,.36,1)", fill: "backwards" }
        );
      }
      var lines = svg.querySelectorAll("path[marker-end]");
      for (var li = 0; li < lines.length; li++) {
        lines[li].animate(
          [{ opacity: 0 }, { opacity: 0.9 }],
          { duration: 320, delay: li * 70, fill: "backwards" }
        );
      }
    }
  }

  function reducedMotion() {
    return !!(window.matchMedia &&
              window.matchMedia("(prefers-reduced-motion: reduce)").matches);
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
      // 门户用的数据没有 d 字段 —— 层级从依赖边算出来，不再按声明顺序铺成一排
      var depth = layering(data.nodes, data.edges);
      data = {
        nodes: data.nodes.map(function (n) {
          return { id: n.id, zh: n.zh, en: n.en, num: n.num, d: depth[n.id] || 0 };
        }),
        edges: reduceEdges(data.nodes, data.edges),
      };
    } else {
      opts.label = "本章概念依赖图";
    }

    // 横向布局至少要 553px（门户主线）/ 640px（章节概念图 min-width）。
    // 容器窄于 620 就换竖排 —— 章节概念图在 390px 手机上同样要横滚 316px。
    var BREAK = 620;
    function treeMode() {
      return host.clientWidth > 0 && host.clientWidth < BREAK;
    }

    var first = true;
    function draw() {
      opts.tree = treeMode();
      opts.animate = first;      // 只在首帧播一次，切主题/语言重绘时不再重播
      first = false;
      render(host, data, opts);
    }
    draw();
    doc.addEventListener("wb:locale", draw);
    // 主题切换会改变 CSS 变量，图里的取色需要跟着重取
    new MutationObserver(draw).observe(doc.documentElement, {
      attributes: true, attributeFilter: ["data-theme"],
    });
    // 跨过断点要换布局形态，横竖两种画法不能只靠 CSS 切换
    var t;
    window.addEventListener("resize", function () {
      clearTimeout(t);
      t = setTimeout(draw, 160);
    });
  }

  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", init);
  else init();

  window.WBConceptMap = { render: render };
})();
