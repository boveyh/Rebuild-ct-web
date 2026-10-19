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

  /* 节点被拖动后的偏移量，按「图 + 节点」记。
     之所以不直接改 n.x / n.y：切语言、切主题、改窗口宽度都会整张重绘，
     重绘时布局会重新算一遍。偏移单独存，重绘后再叠回去，读者挪过的位置
     才不会一换主题就跳回原样。 */
  var OFFSETS = {};

  /* 同一页上可能有两张图（门户有主线图，章节页有概念图），容器的 id 不一定
     唯一甚至可能为空，所以给每个容器发一个稳定的内部编号当命名空间。 */
  var UID = 0;
  function hostKey(host) {
    if (!host.dataset.cmId) {
      UID += 1;
      host.dataset.cmId = host.id || ("cm" + UID);
    }
    return host.dataset.cmId;
  }

  /* 横排和竖排是两套完全不同的坐标系（宽高差好几倍），一份偏移不能通用：
     横排里把节点往右拖 200px 有意义，切到竖排后同样的 200px 会把它顶出画布。
     按布局形态分开记，换形态时各自恢复自己的位置。
     第三个参数是模式字符串 "h"/"t" 而不是布尔 —— 传布尔时 "h" 也是真值，
     会静默地全部算成竖排。 */
  function offKey(host, id, mode) {
    return hostKey(host) + "::" + mode + "::" + id;
  }

  /* 边要连到「节点现在的位置」，不是「布局给的位置」。
     拖动只改偏移，所以画边前先把偏移叠上去，w/h/d 保持布局时的值。 */
  function placed(n) {
    return { x: n.x + n.ox, y: n.y + n.oy, w: n.w, h: n.h, d: n.d };
  }

  function render(host, data, opts) {
    opts = opts || {};
    var locale = (doc.documentElement.getAttribute("data-locale") || "zh") === "en" ? "en" : "zh";
    var tree = opts.tree;
    var L = tree ? layoutTree(data, locale) : layout(data, locale);

    // 布局坐标只算一次，偏移从 OFFSETS 里取
    L.nodes.forEach(function (n) {
      var o = OFFSETS[offKey(host, n.id, tree ? "t" : "h")];
      n.ox = o ? o.x : 0;
      n.oy = o ? o.y : 0;
    });

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
    var links = [];      // {a, b, path, loop}，拖动时要跟着重算
    (data.edges || []).forEach(function (pair) {
      var a = L.byId[pair[0]], b = L.byId[pair[1]];
      if (!a || !b) return;
      var path = el("path", {
        d: tree ? edgeTree(placed(a), placed(b)) : edgePath(placed(a), placed(b)),
        fill: "none", stroke: cLine,
        "stroke-width": "1.5", "marker-end": "url(#cm-arrow)",
        "stroke-linejoin": "round",
        opacity: "0.9",
      });
      svg.appendChild(path);
      links.push({ a: a, b: b, path: path, loop: false });
    });

    if (data.loop) {
      var a = L.byId[data.loop[0]], b = L.byId[data.loop[1]];
      if (a && b) {
        var loopPath = el("path", {
          d: tree ? edgeTreeLoop(placed(a), placed(b)) : edgePath(placed(a), placed(b), true),
          fill: "none", stroke: cAccent,
          "stroke-width": "1.5", "stroke-dasharray": "5 4",
          "marker-end": "url(#cm-arrow)", opacity: "0.85",
        });
        svg.appendChild(loopPath);
        links.push({ a: a, b: b, path: loopPath, loop: true });
      }
    }

    function syncLinks() {
      links.forEach(function (l) {
        l.path.setAttribute(
          "d",
          l.loop
            ? (tree ? edgeTreeLoop(placed(l.a), placed(l.b)) : edgePath(placed(l.a), placed(l.b), true))
            : (tree ? edgeTree(placed(l.a), placed(l.b)) : edgePath(placed(l.a), placed(l.b)))
        );
      });
    }

    L.nodes.forEach(function (n, i) {
      // 节点内部坐标始终按布局算，位移挂在 group 的 transform 上：
      // 这样重绘时只要把偏移读出来写回去，不用改任何一处 x/y。
      var g = el("g", {
        "class": "cm-node", "data-node": n.id,
        transform: "translate(" + n.ox + "," + n.oy + ")",
      });
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
    attachDrag(host, svg, L, links, syncLinks, data, opts);

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

  /* ------------------------------------------------------------------ 拖动
     需求：节点能用鼠标/手指挪位置，且切主题、切语言、转屏之后挪过的还在。

     三个实现要点，都是踩过才写下来的：

     1. 坐标必须过 getScreenCTM().inverse()。图靠 viewBox 自适应容器宽度，
        屏幕上的 1px 不等于 SVG 用户单位的 1px。直接拿 clientX 的差值当位移，
        在缩放或换算比例不是 1:1 的屏上就是「鼠标走了 100，方块只走 76」。
     2. 位移只写 n.ox / n.oy，绘制时叠加。切主题会整张重绘，直接改 n.x / n.y
        会被新布局覆盖；偏移单独存才能跨重绘保留。
     3. 松手才落盘到 OFFSETS。拖动过程中每帧写会让持久化跟着帧率跑，低端机上掉帧。
     拖动过程中每帧只改一个 transform + 重算几条边，不给整图重新排布局。 */
  function attachDrag(host, svg, L, links, syncLinks, data, opts) {
    var mode = opts.tree ? "t" : "h";
    var drag = null;
    var groups = svg.querySelectorAll("g.cm-node");

    /* 指针 → SVG 用户坐标 */
    function toUser(e) {
      var m = svg.getScreenCTM();
      if (!m) return { x: e.clientX, y: e.clientY };
      var p = svg.createSVGPoint();
      p.x = e.clientX;
      p.y = e.clientY;
      var q = p.matrixTransform(m.inverse());
      return { x: q.x, y: q.y };
    }

    /* 允许拖到画布边缘，但不许拖出画布：拖出去就再也抓不回来，
       只能刷新页面，而读者多半会以为图坏了。 */
    function clamp(n) {
      var lo = -n.x, hi = L.width - n.x - n.w;
      if (lo <= hi) n.ox = Math.min(Math.max(n.ox, lo), hi);
      lo = -n.y; hi = L.height - n.y - n.h;
      if (lo <= hi) n.oy = Math.min(Math.max(n.oy, lo), hi);
    }

    function paint(n) {
      var g = svg.querySelector('g.cm-node[data-node="' + n.id + '"]');
      if (g) g.setAttribute("transform", "translate(" + n.ox + "," + n.oy + ")");
      syncLinks();
    }

    function commit(n) {
      OFFSETS[offKey(host, n.id, mode)] = { x: n.ox, y: n.oy };
      host.dispatchEvent(new CustomEvent("cm:moved", { bubbles: true }));
    }

    groups.forEach(function (g) {
      g.addEventListener("pointerdown", function (e) {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        var n = L.byId[g.getAttribute("data-node")];
        if (!n) return;
        e.preventDefault();          // 别让浏览器顺手开始拖选文字
        drag = { n: n, g: g, id: e.pointerId, p0: toUser(e), ox: n.ox, oy: n.oy, moved: false };
        // 拖到别的节点上时要压在它上面，否则被拖的那个会被盖住、看起来像消失了
        g.parentNode.appendChild(g);
        try { svg.setPointerCapture(e.pointerId); } catch (err) { /* 老浏览器 */ }
        g.classList.add("cm-node--dragging");
        host.setAttribute("data-dragging", "1");
      });

      // 双击单个节点：回到布局给它的位置
      g.addEventListener("dblclick", function () {
        var n = L.byId[g.getAttribute("data-node")];
        if (!n || (!n.ox && !n.oy)) return;
        n.ox = 0;
        n.oy = 0;
        paint(n);
        delete OFFSETS[offKey(host, n.id, mode)];
      });
    });

    svg.addEventListener("pointermove", function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      // 手指刚落下时会有 1~2px 的抖动，先攒够再动，免得「点一下」也移位
      if (!drag.moved) {
        var rough = Math.abs(e.clientX - drag.p0.x) + Math.abs(e.clientY - drag.p0.y);
        if (rough < 3) return;
        drag.moved = true;
      }
      var p = toUser(e);
      drag.n.ox = drag.ox + (p.x - drag.p0.x);
      drag.n.oy = drag.oy + (p.y - drag.p0.y);
      clamp(drag.n);
      paint(drag.n);
    });

    function end(e) {
      if (!drag || e.pointerId !== drag.id) return;
      drag.g.classList.remove("cm-node--dragging");
      host.removeAttribute("data-dragging");
      if (drag.moved) commit(drag.n);
      drag = null;
    }
    svg.addEventListener("pointerup", end);
    svg.addEventListener("pointercancel", end);
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
    /* 「恢复布局」只在读者真的挪过节点之后才出现。一个从头到尾用不上的按钮
       只会占地方，还让人以为必须点它才能继续。
       章节页塞进 figcaption（那本来就是图的说明行），门户的主线图没有
       figcaption，就放在图下面一行。 */
    var resetBtn = doc.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "cm-reset";
    resetBtn.hidden = true;
    resetBtn.innerHTML = '<span data-lang="zh">恢复布局</span><span data-lang="en">Reset layout</span>';
    resetBtn.addEventListener("click", function () {
      var prefix = hostKey(host) + "::";
      Object.keys(OFFSETS).forEach(function (k) {
        if (k.indexOf(prefix) === 0) delete OFFSETS[k];
      });
      resetBtn.hidden = true;
      draw();
    });
    var fig = host.closest("figure");
    var cap = fig ? fig.querySelector("figcaption") : null;
    if (cap) {
      cap.appendChild(resetBtn);
    } else {
      var tools = doc.createElement("p");
      tools.className = "cm-tools";
      tools.appendChild(resetBtn);
      host.parentNode.insertBefore(tools, host.nextSibling);
    }
    host.addEventListener("cm:moved", function () { resetBtn.hidden = false; });

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
