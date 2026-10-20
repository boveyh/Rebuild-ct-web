/* ============================================================================
   kg.js —— 门户「知识图谱」渲染器
   ----------------------------------------------------------------------------
   和 conceptmap.js 的分工：
     · conceptmap.js 画「先学什么、后学什么」—— 有向分层图，一章一个方块；
     · 这里画「这门课由哪些知识点构成」—— 可展开的节点网络，一个点一个概念。

   三个设计决定：
     1. 默认只画 root + 5 个章节点，这就是原来的「课程主线」，一眼看完；
        点开某一章才把它下面的知识点放上来，图不会一上来就糊成一片。
     2. d3 用动态 import，并且等图谱滚进视口才加载。门户首屏是读者第一个
        打开的页面，不该为一个第二屏的图付 280 KB。
     3. 力导向只负责「摆得开」，不负责「摆得对」。没有展开时五章吸附在一个
        固定半径的环上 —— 每次打开图长得一样，读者才不会怀疑图变了。
   ========================================================================= */

// 宿主是内层容器：外层 section 的 id 留给导航锚点（#kg），
// 两处同名会被审计判成重复 id。
const host = document.getElementById("kg-app");
const dataEl = document.getElementById("kg-data");

if (host && dataEl) boot();

function boot() {
  let data;
  try { data = JSON.parse(dataEl.textContent); } catch (e) { return; }

  /* ------------------------------------------------------------- 文案 */
  const TEXT = {
    zh: {
      home: "可视化导论", overview: "总览",
      back: "返回上一级", root: "回到根节点",
      expandAll: "展开全部", collapseAll: "收起全部", relayout: "重排位置",
      loading: "正在装配图谱…",
      detail: "节点详情", browsing: "浏览中", isExpanded: "已展开", isCollapsed: "已收起",
      nodes: "知识点", links: "关系", expandable: "可展开", entries: "可进入",
      attrs: "属性信息", type: "类型", status: "状态", cluster: "分类",
      vid: "视图 ID", rel: "关联",
      ops: "操作", expand: "展开节点", collapse: "收起节点",
      enterChapter: "进入本章", jump: "跳到该节", locate: "定位到该章", start: "从第 1 章开始",
      typeRoot: "根节点", typeChapter: "章节节点", typeConcept: "知识点",
      unitChapter: "章",
      count: (n, m) => `${n} 个节点 · ${m} 条关系`,
      aria: "知识图谱：可展开的课程知识点网络",
    },
    en: {
      home: "Visualization", overview: "Overview",
      back: "Go up", root: "Back to root",
      expandAll: "Expand all", collapseAll: "Collapse all", relayout: "Re-layout",
      loading: "Assembling the graph…",
      detail: "Node detail", browsing: "Browsing", isExpanded: "Expanded", isCollapsed: "Collapsed",
      nodes: "Concepts", links: "Relations", expandable: "Expandable", entries: "Entries",
      attrs: "Attributes", type: "Type", status: "Status", cluster: "Cluster",
      vid: "View ID", rel: "Links to",
      ops: "Actions", expand: "Expand node", collapse: "Collapse node",
      enterChapter: "Open chapter", jump: "Jump to section", locate: "Focus its chapter", start: "Start with Chapter 1",
      typeRoot: "Root", typeChapter: "Chapter", typeConcept: "Concept",
      unitChapter: "chapters",
      count: (n, m) => `${n} nodes · ${m} relations`,
      aria: "Knowledge graph: an expandable network of course concepts",
    },
  };

  const locale = () =>
    document.documentElement.getAttribute("data-locale") === "en" ? "en" : "zh";
  const T = () => TEXT[locale()];
  const pick = (o) => (o == null ? "" : typeof o === "string" ? o : o[locale()] || o.zh || "");

  /* ------------------------------------------------------------- 数据 */
  const chapters = data.chapters;
  const byChapter = {};
  chapters.forEach((c) => { byChapter[c.id] = c; });

  const model = { nodes: [], links: [], byId: {}, adj: {}, concepts: [] };

  function addNode(n) {
    model.nodes.push(n);
    model.byId[n.id] = n;
    model.adj[n.id] = {};
    return n;
  }

  addNode({
    id: "root", kind: "root", r: 30,
    zh: data.root.zh, en: data.root.en,
    summary: data.root.summary, tags: data.root.tags,
    href: data.root.href,
  });

  chapters.forEach((c, i) => {
    addNode({
      id: c.id, kind: "chapter", r: 22,
      zh: c.title.zh, en: c.title.en, num: c.num,
      /* 固定角度：01 落在正上方，顺时针排下去，和课程顺序一致 */
      angle: -Math.PI / 2 + (i * 2 * Math.PI) / chapters.length,
      summary: c.summary, tags: c.tags, href: c.href, sections: c.sections,
    });
  });

  Object.keys(data.nodes).forEach((id) => {
    const n = data.nodes[id];
    const ch = byChapter[id.slice(0, 2)];
    addNode({
      id, kind: "concept", ch: ch.id,
      zh: n.zh, en: n.en, summary: n.summary, tags: n.tags,
      href: n.href, section: n.section, num: ch.num,
    });
    model.concepts.push(model.byId[id]);
  });

  /* 边分四类：
       owner   root → 章，表示「属于」，细而淡；
       member  章 → 知识点，展开时才有；没有它，知识点在力导向里是一盘散沙，
               会被斥力推到画布外，和所属的章断成两块；
       path    章 → 章，原来的课程主线，虚线箭头 + 流动；
       concept 知识点之间的关系，含跨章，实线。 */
  function addLink(sid, tid, kind, bend) {
    model.links.push({ key: sid + ">" + tid, sid, tid, kind, bend });
    (model.adj[sid] = model.adj[sid] || {})[tid] = 1;
    (model.adj[tid] = model.adj[tid] || {})[sid] = 1;
  }

  chapters.forEach((c) => addLink("root", c.id, "owner", 0));
  model.concepts.forEach((c) => addLink(c.ch, c.id, "member", 0));
  (data.chapterEdges || []).forEach(([a, b]) => addLink(a, b, "path", 26));
  (data.edges || []).forEach(([a, b]) => addLink(a, b, "concept", 12));

  Object.keys(model.byId).forEach((id) => {
    model.byId[id].degree = Object.keys(model.adj[id] || {}).length;
  });
  // 连接越多的知识点，点越大 —— 它多半是这一段的主干
  model.concepts.forEach((n) => { n.r = 8.5 + Math.min(n.degree, 4) * 1.1; });

  /* ------------------------------------------------------------- 状态 */
  /* 默认展开第 1 章、选中它。理由：这张图叫「知识图谱」，如果一进来只有
     五个章方块，读者看到的还是课程目录，得先点一下才知道下面有知识点。
     默认展开一章，两种层级同时可见 —— 章可以展开、知识点长什么样、
     右侧面板给的是什么，一眼全懂。 */
  const state = { expanded: new Set([chapters[0].id]), selected: chapters[0].id, hover: null, many: false };
  const isOpen = (id) => state.expanded.has(id);
  const visible = (n) => n.kind !== "concept" || isOpen(n.ch);

  /* ------------------------------------------------------- 标签折行 */
  const textW = (s) => [...s].reduce(
    (a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 11 : 6.1), 0);

  function labelLines(n) {
    const raw = pick(n);
    if (n.kind === "chapter" || n.kind === "root") return [raw];
    const max = 108;
    if (textW(raw) <= max) return [raw];

    const chars = [...raw];
    let cut = 0, acc = "";
    for (let i = 0; i < chars.length; i++) {
      if (textW(acc + chars[i]) > max) break;
      acc += chars[i];
      cut = i + 1;
    }
    let a = chars.slice(0, cut).join("");
    let b = chars.slice(cut).join("");

    // 断在分隔符后面读起来比断在词中间自然
    const at = Math.max(a.lastIndexOf("·"), a.lastIndexOf(" "), a.lastIndexOf("、"));
    if (at > a.length * 0.55) {
      b = a.slice(at + 1) + b;
      a = a.slice(0, at + 1).trim();
    }
    b = b.trim().replace(/^[·、/\s]+/, "");

    if (textW(b) > max) {
      let acc2 = "";
      for (const c of b) {
        if (textW(acc2 + c) > max - 12) break;
        acc2 += c;
      }
      b = acc2 + "…";
    }
    return [a, b].filter(Boolean);
  }

  const labelWidth = (n) =>
    labelLines(n).reduce((m, s) => Math.max(m, textW(s)), 0);

  function paintLabels(sel) {
    sel.each(function (d) {
      const lab = d3.select(this).select(".kg-node__label");
      lab.selectAll("*").remove();
      lab.attr("y", d.r + 15);
      labelLines(d).forEach((line, i) => {
        lab.append("tspan").attr("x", 0).attr("dy", i === 0 ? 0 : 12).text(line);
      });
    });
  }

  /* ------------------------------------------------------------- 面板 */
  /* 「关系数」只数真正的知识依赖：章→知识点的归属边不算，
     否则每展开一章数字就虚涨一截。 */
  const isRelation = (l) => l.kind === "concept" || l.kind === "path";

  function statsOf(n) {
    if (n.kind === "root") {
      return {
        nodes: model.concepts.length,
        links: model.links.filter(isRelation).length,
        expand: chapters.length,
        entries: chapters.length,
      };
    }
    if (n.kind === "chapter") {
      const pts = model.concepts.filter((c) => c.ch === n.id);
      const inCh = (id) => id === n.id || id.indexOf(n.id + ".") === 0;
      return {
        nodes: pts.length,
        // 章内依赖 + 跨章依赖，两条都算 —— 后者才是「这一章和别处的接口」
        links: model.links.filter((l) => isRelation(l) && (inCh(l.sid) || inCh(l.tid))).length,
        expand: pts.length,
        entries: n.sections,
      };
    }
    return {
      nodes: 1,
      links: model.links.filter((l) => isRelation(l) && (l.sid === n.id || l.tid === n.id)).length,
      expand: 0,
      entries: 1,
    };
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  const panel = host.querySelector(".kg__panel");

  function renderPanel() {
    const n = model.byId[state.selected] || model.byId.root;
    const t = T();
    const s = statsOf(n);
    panel.textContent = "";

    const head = el("div", "kg__panel-head");
    head.appendChild(el("p", "kg__eyebrow", t.detail));
    const badge = el("span", "kg__badge");
    badge.textContent = n.kind === "root" ? t.browsing
      : n.kind === "chapter" ? (isOpen(n.id) ? t.isExpanded : t.isCollapsed)
      : t.typeConcept;
    head.appendChild(badge);
    panel.appendChild(head);

    panel.appendChild(el("h3", "kg__panel-title", pick(n)));
    panel.appendChild(el("p", "kg__panel-desc", pick(n.summary)));

    const tags = pick(n.tags);
    if (Array.isArray(tags) && tags.length) {
      const row = el("p", "kg__tags");
      tags.forEach((tag) => row.appendChild(el("span", "kg__tag", "# " + tag)));
      panel.appendChild(row);
    }

    const stats = el("dl", "kg__stats");
    [[s.nodes, t.nodes], [s.links, t.links], [s.expand, t.expandable], [s.entries, t.entries]]
      .forEach(([v, label]) => {
        const d = el("div");
        d.appendChild(el("dt", null, label));
        d.appendChild(el("dd", null, String(v)));
        stats.appendChild(d);
      });
    panel.appendChild(stats);

    panel.appendChild(el("p", "kg__panel-sub", t.attrs));
    const attrs = el("dl", "kg__attrs");
    const row = (k, v, mono) => {
      const d = el("div");
      d.appendChild(el("dt", null, k));
      const dd = el("dd", null, v);
      if (mono) dd.className = "is-mono";
      d.appendChild(dd);
      attrs.appendChild(d);
    };
    row(t.type, n.kind === "root" ? t.typeRoot
      : n.kind === "chapter" ? t.typeChapter : t.typeConcept);
    row(t.status, n.kind === "root" ? t.browsing
      : n.kind === "chapter" ? (isOpen(n.id) ? t.isExpanded : t.isCollapsed)
      // 知识点自己没有展开态，显示所属章节的状态更有用 —— 它说明这张图上
      // 还有没有别人是「亮着的」，读者能判断自己看到的是全貌还是局部
      : (isOpen(n.ch) ? t.isExpanded : t.isCollapsed));
    row(t.cluster, n.kind === "root" ? t.overview
      : n.kind === "chapter" ? pick(n) : pick(byChapter[n.ch].title));
    row(t.vid, n.id, true);
    row(t.rel, n.kind === "root" ? `${chapters.length} ${t.unitChapter}`
      : n.kind === "chapter" ? `${s.nodes} ${t.nodes}`
      : `${pick(byChapter[n.ch].title)} · §${byChapter[n.ch].num}.${n.section}`);
    panel.appendChild(attrs);

    panel.appendChild(el("p", "kg__panel-sub", t.ops));
    const acts = el("div", "kg__panel-acts");

    const main = el("button", "kg-btn kg-btn--primary");
    main.type = "button";
    if (n.kind === "chapter") {
      main.textContent = isOpen(n.id) ? t.collapse : t.expand;
      main.addEventListener("click", () => setOpen(n.id, !isOpen(n.id)));
    } else if (n.kind === "concept") {
      main.textContent = t.locate;
      main.addEventListener("click", () => select(n.ch));
    } else {
      main.textContent = state.expanded.size === chapters.length ? t.collapseAll : t.expandAll;
      main.addEventListener("click", () => setAll(state.expanded.size !== chapters.length));
    }
    acts.appendChild(main);

    const go = el("a", "kg-btn");
    go.href = n.href;
    go.textContent = n.kind === "root" ? t.start
      : n.kind === "chapter" ? t.enterChapter : t.jump;
    acts.appendChild(go);

    panel.appendChild(acts);
  }

  /* ------------------------------------------------------------ 工具条 */
  const bar = {
    crumb: host.querySelector("[data-kg-crumb]"),
    count: host.querySelector("[data-kg-count]"),
    back: host.querySelector("[data-kg-up]"),
    root: host.querySelector("[data-kg-root]"),
    all: host.querySelector("[data-kg-all]"),
    relayout: host.querySelector("[data-kg-relayout]"),
  };

  function renderBar() {
    const t = T();
    const n = model.byId[state.selected] || model.byId.root;
    bar.crumb.textContent = n.kind === "root" ? t.overview : pick(n);
    bar.back.textContent = t.back;
    bar.root.textContent = t.root;
    bar.all.textContent = state.expanded.size === chapters.length ? t.collapseAll : t.expandAll;
    bar.relayout.textContent = t.relayout;
    bar.back.disabled = n.kind === "root";
  }

  function renderCount() {
    const seen = new Set(model.nodes.filter(visible).map((n) => n.id));
    const n = seen.size;
    // 只数知识依赖。把「归属」边算进来，数字会随展开虚涨，读者会以为
    // 展开一章凭空多出六条关系。
    const l = model.links.filter((k) => isRelation(k) && seen.has(k.sid) && seen.has(k.tid)).length;
    bar.count.textContent = T().count(n, l);
  }

  /* ------------------------------------------------------------ 画布 */
  let d3 = null;
  let svg, view, linkLayer, nodeLayer, sim, zoomer;
  let nodeSel, linkSel, baseSel, flowSel;
  let lastSig = "";
  let zoomMoved = false;
  const size = { w: 760, h: 560 };

  function measureBox() {
    const box = host.querySelector(".kg__canvas");
    size.w = Math.max(320, box.clientWidth);
    size.h = Math.max(320, box.clientHeight);
  }

  function curveOf(l) {
    const a = l.source, b = l.target;
    const dx = b.x - a.x, dy = b.y - a.y;
    const dist = Math.hypot(dx, dy) || 1;
    const ux = dx / dist, uy = dy / dist;
    const x1 = a.x + ux * (a.r + 1), y1 = a.y + uy * (a.r + 1);
    const x2 = b.x - ux * (b.r + 7), y2 = b.y - uy * (b.r + 7);
    if (!l.bend) return `M${x1},${y1}L${x2},${y2}`;
    const mx = (x1 + x2) / 2 - uy * l.bend;
    const my = (y1 + y2) / 2 + ux * l.bend;
    return `M${x1},${y1}Q${mx},${my} ${x2},${y2}`;
  }

  function ticked() {
    if (baseSel) baseSel.attr("d", curveOf);
    if (flowSel) flowSel.attr("d", curveOf);
    if (nodeSel) nodeSel.attr("transform", (d) => `translate(${d.x},${d.y})`);
  }

  function refresh() {
    const vn = model.nodes.filter(visible);
    const seen = new Set(vn.map((n) => n.id));
    const vl = model.links
      .filter((l) => seen.has(l.sid) && seen.has(l.tid))
      .map((l) => ({ ...l, source: l.sid, target: l.tid }));

    const sig = vn.length + "|" + vl.length + "|" + vn.map((n) => n.id).join(",");
    const structural = sig !== lastSig;
    lastSig = sig;

    if (structural) {
      /* 新点从它挂着的那个点的周围长出来，沿一圈均匀分布 ——
         全部挤在同一点上，碰撞力会在第一帧把它们弹到画布外。 */
      vn.forEach((n) => {
        if (n.x != null) return;
        /* 章节点直接落在固定角度的环上：首帧就是规整的五边形，
           力导向只做微调，不会先「炸开」再收拢。 */
        if (n.kind === "chapter") {
          n.x = size.w / 2 + Math.cos(n.angle) * 120;
          n.y = size.h / 2 + Math.sin(n.angle) * 120;
          return;
        }
        if (n.kind === "root") {
          n.x = size.w / 2;
          n.y = size.h / 2;
          return;
        }
        const parent = model.byId[n.ch];
        const cx = parent && parent.x != null ? parent.x : size.w / 2;
        const cy = parent && parent.y != null ? parent.y : size.h / 2;
        const same = model.concepts.filter((c) => c.ch === n.ch);
        const ang = (same.indexOf(n) / Math.max(same.length, 1)) * Math.PI * 2 - Math.PI / 2;
        n.x = cx + Math.cos(ang) * 58 + (Math.random() - 0.5) * 8;
        n.y = cy + Math.sin(ang) * 58 + (Math.random() - 0.5) * 8;
      });

      const linkJoin = linkLayer.selectAll("g.kg-link").data(vl, (d) => d.key);
      linkJoin.exit().transition().duration(160).style("opacity", 0).remove();
      const linkEnter = linkJoin.enter().append("g")
        .attr("class", (d) => "kg-link kg-link--" + d.kind)
        .style("opacity", 0)
        // 边跟着起点那一章的颜色，跨章依赖才看得出「从哪儿来」
        .style("--kg-c", (d) => {
          const src = model.byId[d.sid];
          return `var(--viz-${(((src && src.num) || 1) - 1) % 8 + 1})`;
        });
      linkEnter.append("path").attr("class", "kg-link__base");
      linkEnter.append("path").attr("class", "kg-link__flow");
      linkEnter.transition().duration(260).style("opacity", 1);
      linkSel = linkLayer.selectAll("g.kg-link");
      baseSel = linkSel.select(".kg-link__base");
      flowSel = linkSel.select(".kg-link__flow");

      const nodeJoin = nodeLayer.selectAll("g.kg-node").data(vn, (d) => d.id);
      nodeJoin.exit().transition().duration(160).style("opacity", 0).remove();
      const enter = nodeJoin.enter().append("g")
        .attr("class", (d) => "kg-node kg-node--" + d.kind)
        .attr("tabindex", 0)
        .attr("role", "button")
        .style("opacity", 0);
      enter.append("circle").attr("class", "kg-node__halo");
      enter.append("circle").attr("class", "kg-node__dot");
      enter.append("g").attr("class", "kg-node__badge");
      enter.append("text").attr("class", "kg-node__label");
      enter.transition().duration(300).style("opacity", 1);

      nodeSel = nodeLayer.selectAll("g.kg-node");
      nodeSel.select(".kg-node__dot").attr("r", (d) => d.r);
      nodeSel.select(".kg-node__halo").attr("r", (d) => d.r + 9);

      nodeSel.each(function (d) {
        const g = d3.select(this);
        /* 每个点带上自己那一章的颜色：章节点和内嵌的知识点同色，
           读者不看标签也能认出「这几颗是一伙的」。root 用主色，区别于所有章。 */
        g.style("--kg-c", d.kind === "root"
          ? "var(--brand-solid)"
          : `var(--viz-${((d.num - 1) % 8) + 1})`);
        const badge = g.select(".kg-node__badge");
        badge.selectAll("*").remove();
        if (d.kind === "chapter") {
          badge.append("text")
            .attr("class", "kg-node__num")
            .attr("text-anchor", "middle")
            .attr("dominant-baseline", "central")
            .text(String(d.num).padStart(2, "0"));
        } else if (d.kind === "root") {
          for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
              badge.append("circle")
                .attr("class", "kg-node__cell")
                .attr("cx", (i - 1) * 8)
                .attr("cy", (j - 1) * 8)
                .attr("r", i === 1 && j === 1 ? 2.6 : 1.7);
            }
          }
        }
        g.attr("aria-label", pick(d) + (d.kind === "chapter"
          ? (isOpen(d.id) ? " · " + T().isExpanded : " · " + T().isCollapsed) : ""));
      });
      paintLabels(nodeSel);

      const centre = { x: size.w / 2, y: size.h / 2 };
      const open = state.expanded.size > 0;
      /* root 钉在画布中心。它是这张图的锚点：一旦让它跟着力跑，
         每次展开一章整张图都会漂移，读者会以为换了一张图。 */
      model.byId.root.fx = centre.x;
      model.byId.root.fy = centre.y;
      if (sim) sim.stop();
      sim = d3.forceSimulation(vn)
        .force("link", d3.forceLink(vl).id((d) => d.id)
          /* 归属边只是「别跑远」，真正决定间距的是碰撞半径。
             给它太强的力，五六个知识点会被拽成一个环，标签互相压死。 */
          .distance((l) => (l.kind === "owner" ? 132
            : l.kind === "member" ? 96
            : l.kind === "path" ? 178 : 104))
          .strength((l) => (l.kind === "owner" ? 0.16
            : l.kind === "member" ? 0.16
            : l.kind === "path" ? 0.05 : 0.4)))
        .force("charge", d3.forceManyBody()
          .strength((d) => (d.kind === "root" ? -1500 : d.kind === "chapter" ? -620 : -360))
          .distanceMax(620))
        .force("collide", d3.forceCollide(
          (d) => Math.max(d.r + 12, labelWidth(d) / 2 + 12)).strength(0.95))
        /* 没有展开任何一章时，五章吸附在半径 150 的环上，构图稳定可复现；
           一旦展开，环力退到几乎没有，让位给知识点自己的聚集。 */
        .force("ring", d3.forceRadial(open ? 146 : 120, centre.x, centre.y)
          .strength((d) => (d.kind === "chapter" ? (open ? 0.16 : 0.6) : 0)))
        .force("x", d3.forceX(centre.x).strength(0.03))
        .force("y", d3.forceY(centre.y).strength(0.03))
        .on("tick", ticked)
        /* 力导向收敛完再确认一次可见性。固定 1100ms 的定时器有时早于稳定，
           量到的是还在移动的中间状态，于是图看起来「刚好贴边」。 */
        .on("end", () => { checkOverflow(); });

      sim.alpha(0.7).restart();
      bindNodes();

      // 布局稳定之后再确认一次没跑出画布
      setTimeout(checkOverflow, 1100);
    } else {
      paintLabels(nodeSel);
    }

    /* 一次性摆上十几个知识点时，标签必然互相压。这时候只留章节名，
       鼠标停到哪颗就看哪颗 —— 语义缩放之外的第二道闸。 */
    state.many = model.concepts.filter(visible).length > 12;
    if (view) view.classed("is-far", state.many);

    paintFocus();
    renderPanel();
    renderBar();
    renderCount();
  }

  /* 悬停和选中的强度不一样：
       hover  临时聚焦 —— 其余节点连同标签一起淡出，只看这一条链；
       select 只是「我点了它」—— 高亮它和它的邻居，但**不动别人**。
     早期两者都 dim，结果点开一个知识点，图上三十个标签全消失，
     读者看到的是一堆没有名字的圆点。 */
  function paintFocus() {
    if (!nodeSel) return;
    const hover = state.hover;
    const near = hover ? (model.adj[hover] || {}) : {};
    const selNear = model.adj[state.selected] || {};
    const focusId = hover || state.selected;

    nodeSel
      .classed("is-sel", (d) => d.id === state.selected)
      /* 选中项的邻居也标成 is-hi（但不压暗别人）。图缩小、标签被语义缩放
         收起来时，这一条决定了读者还能不能读出「我点的这一章有哪几颗」——
         没有它，点完只剩一堆光点。 */
      .classed("is-hi", (d) => (hover
        ? d.id !== hover && !!near[d.id]
        : d.id !== state.selected && !!selNear[d.id]))
      .classed("is-dim", (d) => !!hover && d.id !== hover && !near[d.id]);

    if (linkSel) {
      linkSel
        .classed("is-hi", (d) => d.sid === focusId || d.tid === focusId)
        .classed("is-dim", (d) => !!hover && d.sid !== hover && d.tid !== hover);
    }
  }

  /* ------------------------------------------------------------ 交互 */
  function select(id) {
    if (!model.byId[id]) return;
    state.selected = id;
    refresh();
  }

  function setOpen(id, open) {
    if (open) state.expanded.add(id);
    else state.expanded.delete(id);
    refresh();
  }

  /* 回到总览：收起所有章节 + 选中 root。只改选中项不改展开状态的话，
     图还是展开的样子，和按钮文字「回到根节点」对不上。 */
  function goRoot() {
    state.expanded.clear();
    state.selected = "root";
    refresh();
    resetView();
  }

  function setAll(open) {
    state.expanded.clear();
    if (open) chapters.forEach((c) => state.expanded.add(c.id));
    refresh();
    /* 全部展开后图会比画布大，直接给一个「看得见全貌」的缩放。
       等布局稍稳一点再算包围盒，否则量到的是过渡中间的位置。 */
    if (!d3) return;
    setTimeout(() => (open ? fitView() : resetView()), open ? 700 : 60);
  }

  /* 当前可见节点的外包框，标签也算在内（标签在圆下方） */
  function bbox() {
    const vn = model.nodes.filter((n) => visible(n) && n.x != null);
    if (!vn.length) return null;
    return {
      minX: Math.min(...vn.map((n) => n.x - n.r)),
      maxX: Math.max(...vn.map((n) => n.x + n.r)),
      minY: Math.min(...vn.map((n) => n.y - n.r)),
      maxY: Math.max(...vn.map((n) => n.y + n.r + 30)),
    };
  }

  /* 有点跑到画布外就把整张图收进视口。
     正常情况下不该触发 —— 触发了说明这一章（或全部展开）比视口大，
     与其让读者自己去角落里找，不如直接缩到看得见全貌。 */
  function checkOverflow() {
    if (!d3 || !svg) return;
    const b = bbox();
    if (!b) return;
    if (b.minX < -4 || b.minY < -4 || b.maxX > size.w + 4 || b.maxY > size.h + 4) fitView();
  }

  /* 把当前所有节点收进视口：算包围盒，反推一个 zoom transform。 */
  function fitView(animated = true) {
    const b = bbox();
    if (!b) return;
    const bw = Math.max(1, b.maxX - b.minX);
    const bh = Math.max(1, b.maxY - b.minY);
    /* 留白按「屏幕像素」算，不按 SVG 单位 —— 图缩得越小，同样的 SVG 留白
       在屏幕上就越窄，标签会贴到画布边上。 */
    /* 画布底部还压着一条操作提示（约 30px），留白要把它算进去，
       否则最下面那颗的标签正好被提示条盖住。 */
    const padPx = 40;
    const k = Math.max(0.5, Math.min((size.w - padPx * 2) / bw, (size.h - padPx * 2) / bh, 1.15));
    const minX = b.minX, maxX = b.maxX, minY = b.minY, maxY = b.maxY;
    const t = d3.zoomIdentity
      .translate(size.w / 2 - (k * (minX + maxX)) / 2, size.h / 2 - (k * (minY + maxY)) / 2)
      .scale(k);
    const target = animated && svg.transition ? svg.transition().duration(420) : svg;
    target.call(zoomer.transform, t);
  }

  function resetView() {
    const target = svg.transition ? svg.transition().duration(360) : svg;
    target.call(zoomer.transform, d3.zoomIdentity);
  }

  function bindNodes() {
    nodeSel
      .on("click", function (event, d) {
        if (event.defaultPrevented) return;
        event.stopPropagation();
        // 章节点点一下就展开，少一步；已展开的再点只是选中，不会误收
        if (d.kind === "chapter" && !isOpen(d.id)) {
          state.selected = d.id;
          state.expanded.add(d.id);
          refresh();
        } else {
          select(d.id);
        }
      })
      .on("dblclick", function (event, d) {
        event.preventDefault();
        event.stopPropagation();
        if (d.kind === "chapter") setOpen(d.id, !isOpen(d.id));
      })
      .on("pointerenter", function (event, d) {
        if (event.pointerType && event.pointerType !== "mouse") return;
        state.hover = d.id;
        paintFocus();
      })
      .on("pointerleave", function (event) {
        if (event.pointerType && event.pointerType !== "mouse") return;
        state.hover = null;
        paintFocus();
      })
      .on("keydown", function (event, d) {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          if (d.kind === "chapter") setOpen(d.id, !isOpen(d.id));
          select(d.id);
        }
      })
      .call(d3.drag()
        // root 是锚点，不参与拖动
        .filter((event, d) => d.kind !== "root")
        .on("start", function (event, d) {
          if (!event.active) sim.alphaTarget(0.16).restart();
          d.fx = d.x;
          d.fy = d.y;
          d3.select(this).classed("is-drag", true);
        })
        .on("drag", function (event, d) {
          d.fx = event.x;
          d.fy = event.y;
        })
        .on("end", function (event, d) {
          if (!event.active) sim.alphaTarget(0);
          // 松手后停在原处：弹回去会让人觉得白拖了一场
          d.fx = event.x;
          d.fy = event.y;
          d3.select(this).classed("is-drag", false);
        }));
  }

  function wireBar() {
    bar.back.addEventListener("click", () => {
      const n = model.byId[state.selected];
      if (!n) return;
      select(n.kind === "concept" ? n.ch : "root");
    });
    bar.root.addEventListener("click", goRoot);
    const home = host.querySelector("[data-kg-home]");
    if (home) home.addEventListener("click", goRoot);
    bar.all.addEventListener("click", () => setAll(state.expanded.size !== chapters.length));
    bar.relayout.addEventListener("click", () => {
      model.nodes.forEach((n) => { n.fx = null; n.fy = null; });
      sim.alpha(1).restart();
      // 重排常常把点甩到视口外，顺手再收一次框
      setTimeout(() => fitView(), 760);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && host.contains(document.activeElement)) goRoot();
    });
  }

  /* ------------------------------------------------------------ 装配 */
  async function mount() {
    measureBox();

    try {
      // kg.js 在 assets/js/ 下，vendor 是它的同级目录
      d3 = await import(new URL("./vendor/d3.esm.js", import.meta.url).href);
    } catch (e) {
      const tip = host.querySelector(".kg__loading");
      tip.textContent = locale() === "en" ? "The graph could not load." : "图谱加载失败。";
      return;
    }

    svg = d3.select(host.querySelector(".kg__svg"))
      .attr("role", "group")
      .attr("aria-label", T().aria);
    view = svg.append("g").attr("class", "kg-view");
    linkLayer = view.append("g").attr("class", "kg-links");
    nodeLayer = view.append("g").attr("class", "kg-nodes");

    const defs = svg.append("defs");
    [["kg-arrow", "var(--border-3)"], ["kg-arrow-brand", "var(--brand)"]].forEach(([id, stroke]) => {
      defs.append("marker")
        .attr("id", id).attr("viewBox", "0 0 10 10")
        .attr("refX", 9).attr("refY", 5)
        .attr("markerWidth", 7).attr("markerHeight", 7)
        .attr("orient", "auto-start-reverse")
        .append("path")
        .attr("d", "M1 1L8 5L1 9")
        .attr("fill", "none")
        .attr("stroke", stroke)
        .attr("stroke-width", 1.4)
        .attr("stroke-linecap", "round")
        .attr("stroke-linejoin", "round");
    });

    zoomer = d3.zoom()
      .scaleExtent([0.45, 2.2])
      .on("start", () => { zoomMoved = false; })
      .on("zoom", (event) => {
        view.attr("transform", event.transform);
        /* 语义缩放：缩到字读不清的时候，概念标签先让位，只留章节名；
           鼠标停到某个点上时它自己的标签再浮出来。26 个标签同时挤在
           一块小画布上是没法读的，不如分层给信息。 */
        view.classed("is-far", state.many || event.transform.k < 0.8);
        // 拖动画布不应该被当成「点了空白」
        const src = event.sourceEvent;
        if (src && (src.type === "mousemove" || src.type === "touchmove")) zoomMoved = true;
      });
    svg.call(zoomer);
    svg.on("dblclick.zoom", null);   // 双击留给节点展开

    // 点画布空白处回到总览（平移过程中松手不算，见 zoomMoved）
    svg.on("click", () => {
      if (zoomMoved) { zoomMoved = false; return; }
      if (!state.hover) goRoot();
    });

    host.classList.add("is-ready");
    host.querySelector(".kg__loading").hidden = true;

    refresh();
    wireBar();

    let rt;
    window.addEventListener("resize", () => {
      clearTimeout(rt);
      rt = setTimeout(() => {
        measureBox();
        if (!sim) return;
        sim.force("ring", d3.forceRadial(state.expanded.size ? 146 : 120, size.w / 2, size.h / 2)
          .strength((d) => (d.kind === "chapter" ? (state.expanded.size ? 0.16 : 0.6) : 0)));
        sim.force("x", d3.forceX(size.w / 2).strength(0.03))
           .force("y", d3.forceY(size.h / 2).strength(0.03));
        sim.alpha(0.5).restart();
        setTimeout(checkOverflow, 900);
      }, 180);
    });

    // 切语言：标签和面板重取，布局不动
    document.addEventListener("wb:locale", () => {
      refresh();
      if (sim) sim.alpha(0.3).restart();
      // 英文标签更长，换语言后包围盒会变
      setTimeout(checkOverflow, 700);
    });

    // 切主题：颜色走 CSS 变量自动跟随，这里只让力导向重算一次碰撞半径
    new MutationObserver(() => { if (sim) sim.alpha(0.3).restart(); })
      .observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  }

  /* 等图谱滚进视口再加载 d3。没有 IntersectionObserver 的老浏览器直接加载。 */
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        mount();
      }
    }, { rootMargin: "360px 0px" });
    io.observe(host);
  } else {
    mount();
  }
}
