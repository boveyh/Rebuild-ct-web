#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_supp.py —— 修复与统一「补充 Demo」及第 1 章独立演示
==============================================================================

这两批页面是原站里**没有被页面编辑器污染**的部分：作者手写、自包含、能单独运行，
是课程设计里最有价值的一块。重构时它们的价值必须保住，但有三类毛病要修：

  一类：指向不存在的文件（用户点名要修的「404 页面」）
    · supplementary/index.html 引用 yearcalendar.html，但仓库里从来没有这个文件
    · calendar*.html 把数据写成 '/data/calendar_data_modified.csv'
      —— 站点根绝对路径，本地看着对，部署到 /vis/ 子路径就 404
    · utils/data.js 取 './newstudent.csv'，而文件在上一级目录
    · utils/scatter.js 取 'utils/scatterConfig.json'，而文件就在同级

  二类：能打开但什么都没画
    · regression.html 加载了 d3-regression、算出了回归对象，然后……没有然后，
      页面全白。这种「不报 404 但也不渲染」的情况比断链更难发现。

  三类：小瑕疵
    · 缺 charset / viewport（手机上缩放异常、非 UTF-8 环境下乱码）
    · <html lang="en"> 里装的是中文
    · 注释里留着一行 `import * as d3 from "d3"`，取消注释就会运行时报错
    · 打开后没有回站入口，学生容易「被困」在 demo 里

修复原则：**只改坏的，不改好的**。作者的画法、配色、交互一律不动，
所以这里的改动全部是「精确字符串替换 + 缺失元信息补齐」，并且可重复执行（幂等）。
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SUPP = ROOT / "supplementary"
DEMO01 = ROOT / "lesson-01" / "demo"

CHECK_ONLY = "--check" in __import__("sys").argv


def read(p: Path) -> str:
    return p.read_text(encoding="utf-8")


def write(p: Path, s: str) -> None:
    if CHECK_ONLY:
        return
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(s, encoding="utf-8")


# ===========================================================================
# 一、精确路径修复
# ===========================================================================
# 形式：(文件, 旧串, 新串, 说明)。旧串必须完整唯一，改完再跑一次不会重复改。

PATCHES: list[tuple[str, str, str, str]] = [
    # ---- 站点根绝对路径 -> 正确的相对路径
    *[
        (f, "'/data/calendar_data_modified.csv'", "'data/calendar_data_modified.csv'",
         "站点根绝对路径在 /vis/ 子路径部署下会 404")
        for f in ("calendar.html", "calendar1.html", "calendar3.html")
    ],
    # ---- 注意：这两个文件曾经被我「修」坏过一次，教训值得留在这里 ----
    # d3.csv / d3.json / fetch 的相对路径是按**文档**（地址栏那个页面）解析的，
    # 不是按脚本文件解析的。utils/data.js 里的 './newstudent.csv' 被
    # supplementary/tableshow.html 加载时，实际请求的是
    # supplementary/newstudent.csv —— 它一直都在。
    # 第一版误以为要按脚本位置解析，改成了 '../newstudent.csv'，
    # 结果请求打到了站点根的 /newstudent.csv，把两个本来正常的页面改成了 404。
    # 这两条是回滚，不是修复。
    ("utils/data.js", '"../newstudent.csv"', '"./newstudent.csv"',
     "回滚：该路径按「文档」解析，原值才是对的"),
    ("utils/scatter.js", '"scatterConfig.json"', '"utils/scatterConfig.json"',
     "回滚：同上，crime1985.html 在 supplementary/ 下，'utils/…' 正好命中"),
    # ---- 注释里那行会炸的 import
    ("newstudent.html", '// import * as d3 from "d3";',
     '// 这里原本留着一行 import * as d3 from "d3"; —— 该模块并没有安装，\n'
     '    // 取消注释会直接运行时报错。d3 已由 <script src> 全局提供，故删去。', ""),
    # ---- 语言标记与实际内容不符
    ('newstudent.html', '<html lang="en">', '<html lang="zh-CN">',
     "页面内容是中文，lang 应为 zh-CN（影响朗读与断行）"),
    # ---- 手滑多打的一个 await
    ("newstudent.html", "await await d3.csv", "await d3.csv", "多余的 await"),
]


def apply_patches() -> int:
    n = 0
    for fname, old, new, why in PATCHES:
        p = SUPP / fname
        if not p.is_file():
            print(f"  ! 跳过（文件不存在）：{fname}")
            continue
        txt = read(p)
        if old not in txt:
            continue  # 已修过或本来就没有
        write(p, txt.replace(old, new))
        n += 1
        print(f"  · {fname}：修复 {why or '路径'}")
    return n


# ===========================================================================
# 二、基础元信息补齐
# ===========================================================================

RE_HAS_CHARSET = re.compile(r"<meta[^>]+charset", re.I)
RE_HAS_VIEWPORT = re.compile(r"<meta[^>]+name=[\"']viewport", re.I)
RE_HEAD_OPEN = re.compile(r"<head\b[^>]*>", re.I)


def ensure_meta() -> int:
    """缺 charset / viewport 的补上。顺序无所谓，浏览器都能识别。"""
    n = 0
    for p in sorted(SUPP.glob("*.html")):
        txt = read(p)
        added = []

        if not RE_HEAD_OPEN.search(txt):
            # 个别页面连 <head> 都没写，补一个最小的
            if "<html" in txt:
                txt = re.sub(r"(<html\b[^>]*>)", r"\1\n<head></head>", txt, count=1)
            else:
                txt = "<head></head>\n" + txt

        inject = ""
        if not RE_HAS_CHARSET.search(txt):
            inject += '    <meta charset="utf-8" />\n'
            added.append("charset")
        if not RE_HAS_VIEWPORT.search(txt):
            inject += '    <meta name="viewport" content="width=device-width, initial-scale=1" />\n'
            added.append("viewport")
        if inject:
            txt = RE_HEAD_OPEN.sub(lambda m: m.group(0) + "\n" + inject.rstrip("\n"), txt, count=1)
            write(p, txt)
            n += 1
            print(f"  · {p.name}：补 {', '.join(added)}")
    return n


# ===========================================================================
# 三、回站浮标
# ===========================================================================
# 用「右下角浮标」而不是顶部横条：这些页面的作者各自写了 body{margin:0} + flex 布局，
# 顶部插一条会把它们的首屏挤变形。浮标是 position:fixed，不参与布局，零风险。

DEMOBAR_ID = "wb-demobar"

DEMOBAR = f"""
<!-- wb-demobar: 由 tools/build_supp.py 注入，给独立 demo 一个回站入口 -->
<style id="{DEMOBAR_ID}-style">
  .{DEMOBAR_ID} {{
    position: fixed; right: 14px; bottom: 14px; z-index: 2147483000;
    display: flex; gap: 2px; align-items: center;
    font: 12px/1.4 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    background: rgba(20, 24, 33, .86); color: #e8edf5;
    border: 1px solid rgba(255, 255, 255, .14);
    border-radius: 999px; padding: 5px 6px 5px 12px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, .28);
    backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
  }}
  .{DEMOBAR_ID} span {{ opacity: .68; margin-right: 4px; }}
  .{DEMOBAR_ID} a {{
    color: #e8edf5; text-decoration: none; padding: 3px 9px; border-radius: 999px;
    transition: background .15s;
  }}
  .{DEMOBAR_ID} a:hover, .{DEMOBAR_ID} a:focus-visible {{ background: rgba(255, 255, 255, .16); }}
  @media print {{ .{DEMOBAR_ID} {{ display: none; }} }}
</style>
<div class="{DEMOBAR_ID}" role="navigation" aria-label="返回课程">
  <span>可视化导论</span>
  {{links}}
</div>
"""


def demobar_links(prefix: str, chapter: str | None = None) -> str:
    items = [(f"{prefix}", "课程门户"), (f"{prefix}glossary.html", "术语表")]
    if chapter:
        items.insert(0, (f"{prefix}lesson-{chapter}/", f"第 {int(chapter)} 章"))
    return "\n  ".join(f'<a href="{h}">{t}</a>' for h, t in items)


def inject_demobar(path: Path, prefix: str, chapter: str | None = None) -> bool:
    """给独立 demo 注入站点级的小配件。幂等：已经在的不重复加。

    两件事各自独立判断，因为它们的引入时间不同：
      1. favicon —— 这些页面都没写 <link rel="icon">，浏览器会自己去请求
         站点根的 /favicon.ico，在 /vis/ 子路径部署下必然 404。
         补一个指向站点 favicon.svg 的声明，消掉那条 404 并带上品牌标记。
      2. 回站浮标 —— 打开 demo 的学生需要一个明确的回站入口。
    """
    txt = read(path)
    changed = False

    if not re.search(r"<link[^>]+rel=[\"'](?:icon|shortcut icon)", txt, re.I):
        tag = f'    <link rel="icon" href="{prefix}favicon.svg" type="image/svg+xml" />\n'
        if RE_HEAD_OPEN.search(txt):
            txt = RE_HEAD_OPEN.sub(lambda m: m.group(0) + "\n" + tag.rstrip("\n"), txt, count=1)
        else:
            txt = tag + txt
        changed = True

    if DEMOBAR_ID not in txt:
        bar = (DEMOBAR
               .replace("{DEMOBAR_ID}", DEMOBAR_ID)
               .replace("{links}", demobar_links(prefix, chapter))
               .replace("{{", "{").replace("}}", "}"))
        txt = txt.replace("</body>", bar + "</body>", 1) if "</body>" in txt else txt + bar
        changed = True

    if changed:
        write(path, txt)
    return changed


# ===========================================================================
# 四、回归示例：从「空白页」变成真会画
# ===========================================================================

REGRESSION_HTML = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>d3-regression 最小示例 · 线性拟合</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <!-- 顺序不能反。实测两个 UMD 包的挂载方式不一样：
         d3 v7          ->  window.d3 = window.d3 || {}        （叠加，安全）
         d3-regression  ->  window.d3 = {}                      （无条件覆盖！）
       所以如果 d3 先加载，随后会被 d3-regression 整个抹掉，
       页面报 "d3.scaleLinear is not a function"。
       正确顺序：先插件，再本体。 -->
  <script src="https://unpkg.com/d3-regression@1.3.10/dist/d3-regression.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/d3@7"></script>
  <style>
    :root { --ink:#1b2330; --muted:#6b7686; --grid:#e3e8ef; --bg:#fff; --accent:#3d4bc0; }
    @media (prefers-color-scheme: dark) {
      :root { --ink:#e6ebf3; --muted:#9aa5b4; --grid:#2a3140; --bg:#141924; --accent:#8fa0ff; }
    }
    body { margin:0; padding:28px; background:var(--bg); color:var(--ink);
           font:14px/1.7 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
    h1 { font-size:18px; margin:0 0 4px; }
    p.lead { color:var(--muted); margin:0 0 20px; max-width:62ch; }
    figure { margin:0; }
    figcaption { color:var(--muted); font-size:13px; margin-top:10px; }
    .grid-line { stroke:var(--grid); stroke-width:1; }
    .axis text { fill:var(--muted); font-size:11px; }
    .axis path, .axis line { stroke:var(--grid); }
    .dot { fill:var(--accent); fill-opacity:.75; }
    .fit { stroke:#d1495b; stroke-width:2.5; fill:none; }
    .fit-label { fill:#d1495b; font-size:12px; font-weight:600; }
  </style>
</head>
<body>
  <h1>d3-regression 最小示例</h1>
  <p class="lead">
    这个页面的作用是「只留回归本身」：10 个点、一条最小二乘直线，
    方便和 <a href="crime1985.html">crime1985.html</a> 里那套完整散点图对照着看。
    重构前的版本算出了回归对象却没有把它画出来，页面是全白的。
  </p>
  <figure>
    <div id="chart"></div>
    <figcaption>数据点固定写死在源码里，改数值刷新即可看到直线跟着变。</figcaption>
  </figure>

  <script>
    const data = [
      {x: 8, y: 3}, {x: 2, y: 10}, {x: 11, y: 3}, {x: 6, y: 6}, {x: 5, y: 8},
      {x: 4, y: 12}, {x: 12, y: 1}, {x: 9, y: 4}, {x: 6, y: 9}, {x: 1, y: 14}
    ];

    const W = 560, H = 340, M = { top: 20, right: 24, bottom: 44, left: 52 };
    const iw = W - M.left - M.right, ih = H - M.top - M.bottom;

    const x = d3.scaleLinear().domain([0, 13]).range([0, iw]);
    const y = d3.scaleLinear().domain([0, 15]).range([ih, 0]);

    const svg = d3.select("#chart").append("svg")
      .attr("viewBox", `0 0 ${W} ${H}`)
      .attr("width", "100%").attr("style", "max-width:640px;height:auto")
      .attr("role", "img")
      .attr("aria-label", "10 个散点与一条最小二乘拟合直线");

    const g = svg.append("g").attr("transform", `translate(${M.left},${M.top})`);

    // 网格
    g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(5).tickSize(-iw).tickFormat(""));
    g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`)
      .call(d3.axisBottom(x).ticks(6).tickSize(-ih).tickFormat(""));

    // 真实刻度
    g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(5));
    g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).ticks(6));

    // 点
    g.selectAll("circle").data(data).join("circle")
      .attr("class", "dot")
      .attr("cx", d => x(d.x)).attr("cy", d => y(d.y)).attr("r", 5);

    // 最小二乘拟合 —— d3.regressionLinear() 返回 {a, b, predict}
    const fit = d3.regressionLinear().x(d => d.x).y(d => d.y)(data);

    g.append("line").attr("class", "fit")
      .attr("x1", x(0)).attr("y1", y(fit.predict(0)))
      .attr("x2", x(13)).attr("y2", y(fit.predict(13)));

    // 斜率与截距：a 是斜率，b 是截距
    g.append("text").attr("class", "fit-label")
      .attr("x", x(0.5)).attr("y", y(fit.predict(0.5)) - 10)
      .text(`y = ${fit.a.toFixed(3)}x + ${fit.b.toFixed(3)}`);
  </script>
</body>
</html>
"""


# ===========================================================================
# 五、补上缺失的 yearcalendar.html（van Wijk 日历热图）
# ===========================================================================
# 原索引里点名了这个文件，但仓库里从来没有。本次按描述把它做出来：
# 「带日分割线的横纵转置热力图日历（van Wijk 风格）」——
# 即 van Wijk & van Selow (1999) 的 Calendar View：一行一年、一列一周中的一天，
# 让「年 → 月 → 周 → 日」四个尺度能在一张图里同时读出来。
# 数据用仓库里现成的 calendar_data_modified.csv（2022-01-01 ~ 2025-12-31，1461 天）。

YEARCALENDAR_HTML = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>van Wijk 日历热图 · 2022–2025</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <script src="https://cdn.jsdelivr.net/npm/d3@7"></script>
  <style>
    :root {
      --bg:#fff; --ink:#1a2230; --muted:#6b7686; --panel:#f7f9fc; --line:#e2e8f0;
      --line-strong:#c3ccd9; --tip-bg:#141924; --tip-ink:#e8edf5;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg:#111621; --ink:#e6ebf3; --muted:#939eae; --panel:#171d29; --line:#262e3d;
        --line-strong:#3b4559; --tip-bg:#0a0e16; --tip-ink:#e8edf5;
      }
    }
    * { box-sizing:border-box; }
    body {
      margin:0; padding:26px 22px 60px; background:var(--bg); color:var(--ink);
      font:14px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
    }
    header { max-width:1440px; margin:0 auto 18px; }
    h1 { font-size:19px; margin:0 0 6px; letter-spacing:.2px; }
    .lead { color:var(--muted); margin:0; max-width:70ch; }
    .lead b { color:var(--ink); font-weight:600; }
    .wrap { max-width:1440px; margin:0 auto; background:var(--panel);
            border:1px solid var(--line); border-radius:14px; padding:18px 18px 12px; }
    #chart { overflow-x:auto; }
    svg { display:block; }
    .cell { shape-rendering:crispEdges; }
    .wk { stroke:var(--line-strong); stroke-width:.8; }
    .mon { stroke:var(--muted); stroke-width:1.1; }
    .row-label { fill:var(--ink); font-size:12px; font-weight:600; }
    .mon-label { fill:var(--muted); font-size:10px; }
    .dow-label { fill:var(--muted); font-size:11px; }
    .legend { display:flex; align-items:center; gap:10px; margin:14px 2px 2px;
              color:var(--muted); font-size:12px; flex-wrap:wrap; }
    .legend .ramp { display:flex; }
    .legend .ramp i { width:22px; height:11px; display:block; }
    .tip {
      position:fixed; pointer-events:none; opacity:0; z-index:50;
      background:var(--tip-bg); color:var(--tip-ink); border-radius:8px;
      padding:6px 9px; font-size:12px; line-height:1.5; white-space:nowrap;
      box-shadow:0 8px 22px rgba(0,0,0,.3); transform:translate(-50%,-140%);
      transition:opacity .12s;
    }
    .note { color:var(--muted); font-size:12.5px; max-width:1440px; margin:16px auto 0; }
    .note a { color:inherit; }
  </style>
</head>
<body>
  <header>
    <h1>van Wijk 日历热图 · 2022–2025</h1>
    <p class="lead">
      <b>一行一年，一格一天</b>，366 格横向排开。每 7 格画一条<b>周分割线</b>，
      月份边界用更重的线加月份标签标出 —— 这样「年 / 月 / 周 / 日」四个尺度
      可以在一张图里同时读出来：纵向比年份，横向看季节，
      而等距的竖线让「周节律」直接显形。
      这就是 van Wijk &amp; van Selow (1999) 提出的 Calendar View。
    </p>
  </header>

  <div class="wrap">
    <div id="chart"></div>
    <div class="legend">
      <span>低</span><span class="ramp" id="ramp"></span><span>高</span>
      <span id="range" style="margin-left:8px"></span>
    </div>
  </div>

  <p class="note">
    数据：<code>data/calendar_data_modified.csv</code>，共 4 年 1461 天的日值。
    与 <a href="calendar.html">calendar.html</a>（螺旋时间轴）对照着看：
    同一个数据集，换成日历排布之后「周节律」会立刻显形，而螺旋排布更适合看「年周期」。
  </p>

  <div class="tip" id="tip"></div>

  <script>
  (function () {
    const CSV = "data/calendar_data_modified.csv";

    /* 画法说明（van Wijk & van Selow 1999 的 Calendar View）：
         · 一行 = 一年；
         · 一年里横向排 366 个格子，一个格子 = 一天，颜色编码当天的值；
         · 每 7 格画一条竖线，把「周」这一层从颜色里拎出来；
         · 月份边界用更重的线 + 月份标签标出。
       所以格子是「窄而高」的：宽 2.4px、高 14px。
       第一版把格子做成正方形，还让 y 随星期递增，结果每一天都往右下斜一格，
       整张图看起来是一串斜线 —— 那不是日历，是坐标系没用对。 */
    const BAR_W = 2.4;          // 每天的横向宽度
    const BAR_H = 14;           // 每天的高度 = 一年那一行的厚度
    const COL = 3;              // 每天占的横向步长（含缝）
    const YEAR_GAP = 9;         // 年与年之间的空隙
    const PAD_L = 52, PAD_T = 26, PAD_R = 10, PAD_B = 10;
    const DAYS = 366;           // 闰年上限

    const dark = matchMedia("(prefers-color-scheme: dark)");
    // 两套色带：浅色底用「浅 -> 深蓝」，深色底用「深 -> 亮青」
    const RAMP_LIGHT = ["#eef3f9", "#cfe0f5", "#9dc0e6", "#5f95d3", "#2f68ae", "#163f74"];
    const RAMP_DARK  = ["#1b2233", "#25406b", "#2f66a8", "#3f96d4", "#67c6ee", "#b6ecff"];
    const ramp = () => d3.interpolateRgbBasis(dark.matches ? RAMP_DARK : RAMP_LIGHT);

    const tip = document.getElementById("tip");

    /* 日期自己解析，不用 new Date(字符串)。
       数据里写的是 "2022/1/1"，月份和日期没有补零，
       new Date("2022-1-1") 在 Chrome 里直接得到 Invalid Date ——
       各浏览器对这种非标准格式的宽容度不同，不该依赖。 */
    function parseDate(s) {
      const p = String(s).trim().split(/[\/\-.]/).map(Number);
      return p.length === 3 ? new Date(p[0], p[1] - 1, p[2]) : new Date(NaN);
    }

    const dayOfYear = d => Math.round((d - new Date(d.getFullYear(), 0, 1)) / 864e5);
    const firstDow = y => (new Date(y, 0, 1).getDay() + 6) % 7;   // 周一记 0
    const DOW = ["一", "二", "三", "四", "五", "六", "日"];

    d3.csv(CSV, d => ({ date: parseDate(d.date), value: +String(d.value).trim() }))
      .then(function (raw) {
        const data = raw.filter(d => !isNaN(d.date) && !isNaN(d.value));
        if (!data.length) throw new Error("没有可用数据");

        const years = d3.range(d3.min(data, d => d.date.getFullYear()),
                               d3.max(data, d => d.date.getFullYear()) + 1);
        const [lo, hi] = d3.extent(data, d => d.value);
        const color = d3.scaleSequential(ramp()).domain([lo, hi]);

        const W = PAD_L + DAYS * COL + PAD_R;
        const H = PAD_T + years.length * (BAR_H + YEAR_GAP) + PAD_B;

        const svg = d3.select("#chart").append("svg")
          .attr("viewBox", `0 0 ${W} ${H}`)
          .attr("width", W).attr("height", H)
          .attr("role", "img")
          .attr("aria-label",
            `日历热图：${years[0]} 至 ${years[years.length - 1]} 年每日数值，` +
            `每行一年、每格一天，颜色由低到高取 ${lo} 到 ${hi}`);

        const g = svg.append("g").attr("transform", `translate(${PAD_L},${PAD_T})`);

        data.forEach(function (d) {
          d.day = dayOfYear(d.date);
        });

        years.forEach(function (year, yi) {
          const y0 = yi * (BAR_H + YEAR_GAP);
          const row = g.append("g").attr("transform", `translate(0,${y0})`);
          const cells = data.filter(d => d.date.getFullYear() === year);

          row.append("text").attr("class", "row-label")
            .attr("x", -12).attr("text-anchor", "end").attr("y", BAR_H - 3)
            .text(year);

          // 底板：把整年的范围画出来，空数据的日子也有底
          row.append("rect")
            .attr("x", -1).attr("y", -1)
            .attr("width", DAYS * COL + 2).attr("height", BAR_H + 2)
            .attr("rx", 2).attr("fill", "none").attr("stroke", "var(--line)");

          row.selectAll("rect.cell").data(cells).join("rect")
            .attr("class", "cell")
            .attr("x", d => d.day * COL)
            .attr("y", 0)
            .attr("width", BAR_W).attr("height", BAR_H)
            .attr("fill", d => color(d.value))
            .on("mouseenter", function (ev, d) {
              d3.select(this).attr("stroke", "var(--ink)").attr("stroke-width", 1.2);
              tip.style.opacity = 1;
              tip.innerHTML = d3.timeFormat("%Y-%m-%d")(d.date) +
                "（周" + DOW[(d.date.getDay() + 6) % 7] + "）<br>数值 " + d.value;
              tip.style.left = ev.clientX + "px";
              tip.style.top = ev.clientY + "px";
            })
            .on("mousemove", ev => {
              tip.style.left = ev.clientX + "px";
              tip.style.top = ev.clientY + "px";
            })
            .on("mouseleave", function () {
              d3.select(this).attr("stroke", null);
              tip.style.opacity = 0;
            });

          // 周分割线：每 7 天一条，让「周节律」从色块里显出来
          row.append("g").selectAll("line.wk")
            .data(d3.range(0, DAYS + 1, 7)).join("line")
            .attr("class", "wk")
            .attr("x1", d => d * COL - COL / 2).attr("x2", d => d * COL - COL / 2)
            .attr("y1", -3).attr("y2", BAR_H + 3);

          // 月份边界 + 标签：按该年第 1 天是周几来对齐真实的月首
          const monthStarts = d3.range(12).map(m => new Date(year, m, 1));
          row.append("g").selectAll("line.mon").data(monthStarts).join("line")
            .attr("class", "mon")
            .attr("x1", d => dayOfYear(d) * COL - COL / 2)
            .attr("x2", d => dayOfYear(d) * COL - COL / 2)
            .attr("y1", -8).attr("y2", BAR_H + 3);

          row.append("g").selectAll("text.mon-label").data(monthStarts).join("text")
            .attr("class", "mon-label")
            .attr("x", d => dayOfYear(d) * COL + 2)
            .attr("y", -11)
            .text(d => (d.getMonth() === 0 || dayOfYear(d) > 14) ? (d.getMonth() + 1) + "月" : "");
        });

        // 图例色阶
        const rampEl = document.getElementById("ramp");
        d3.range(24).forEach(i => {
          const el = document.createElement("i");
          el.style.background = color(lo + (hi - lo) * (i / 23));
          rampEl.appendChild(el);
        });
        document.getElementById("range").textContent =
          `数值范围 ${lo} ~ ${hi}` + (dark.matches ? "（深色模式配色）" : "");

        // 系统主题变了就重画：颜色带是按主题选的，不能只靠 CSS
        dark.addEventListener("change", function () { location.reload(); });
      }).catch(function (err) {
        d3.select("#chart").html(
          '<p style="color:#d1495b">数据没能加载：' + err.message +
          '<br>请通过本地静态服务器打开本页（直接双击 file:// 打开会被 CORS 拦住）。</p>');
      });
  })();
  </script>
</body>
</html>
"""


def build_yearcalendar() -> bool:
    """生成 yearcalendar.html。

    和 build.py 里那几页一样，这是**生成文件**：改模板就得重跑管道，
    否则模板和产物会漂移。所以这里不做「存在就跳过」的优化。
    """
    p = SUPP / "yearcalendar.html"
    write(p, YEARCALENDAR_HTML)
    return True


# ===========================================================================
# 六、第 1 章独立演示：去残留 + 加回站浮标
# ===========================================================================

RE_NODE_ID = re.compile(r"\s+data-page-node-id=\"[^\"]*\"")


def clean_lesson01_demos() -> int:
    """清掉页面编辑器残留。

    `lesson-01/demo/` 是原站里唯一没被编辑器污染的一批页面之外的例外：
    它自己有 296 个 data-page-node-id。这些属性对渲染没有任何作用，
    只会让 HTML 变胖、让 diff 变吵，而且其中 3 处还造成了非法重复属性。
    """
    n_files = n_attrs = 0
    for p in sorted(DEMO01.rglob("*.html")) + sorted(DEMO01.rglob("*.js")):
        txt = read(p)
        hits = len(RE_NODE_ID.findall(txt))
        if not hits:
            continue
        write(p, RE_NODE_ID.sub("", txt))
        n_files += 1
        n_attrs += hits
    if n_files:
        print(f"  · lesson-01/demo：{n_files} 个文件清掉 {n_attrs} 处 data-page-node-id")
    return n_attrs


RE_TH_NO_SCOPE = re.compile(r"<th(?![^>]*\bscope=)([^>]*)>")


def fix_demo_a11y() -> tuple[int, int]:
    """第 1 章 5 个独立实验页的无障碍补齐。

    这批页面来自原站、自成一体（每页有自己的样式和脚本），不走内容管道，
    所以 build.py 里的表格 scope 与标题层级修正在它们身上不生效。
    审计把它们单独报了出来：13 个 <th> 缺 scope，1 页 h1 后面直接 h3。

    标题的处理是「整页没有 h2 时，把 h3 提为 h2」—— 只在确实跳级时才动，
    否则会把本来正确的三级标题也一起抬上来。
    """
    n_th = n_page = 0
    for p in sorted(DEMO01.rglob("index.html")):
        txt = read(p)
        orig = txt
        txt = RE_TH_NO_SCOPE.sub(r'<th scope="col"\1>', txt)
        if "<h2" not in txt and "<h3" in txt:
            txt = re.sub(r"<h3(\s|>)", r"<h2\1", txt)
            txt = txt.replace("</h3>", "</h2>")
        if txt != orig:
            write(p, txt)
            n_page += 1
            n_th += len(RE_TH_NO_SCOPE.findall(orig))
    if n_page:
        print(f"  · lesson-01/demo：{n_page} 个页面补齐表头 scope 与标题层级")
    return n_page, n_th


def demobar_lesson01() -> int:
    """给独立演示加回站浮标。层级是 lesson-01/demo/XX/ 或 lesson-01/demo/。"""
    n = 0
    for p in sorted(DEMO01.rglob("*.html")):
        depth = len(p.relative_to(ROOT).parts) - 1   # lesson-01/demo/xx/index.html -> 3
        prefix = "../" * depth
        if inject_demobar(p, prefix, "01"):
            n += 1
    if n:
        print(f"  · lesson-01/demo：{n} 个页面加入回站浮标")
    return n


# ===========================================================================
# 七、补充页统一加浮标（index.html 除外，它本身就属于新外壳）
# ===========================================================================

def demobar_supplementary() -> int:
    n = 0
    for p in sorted(SUPP.glob("*.html")):
        if p.name == "index.html":
            continue
        # 这些页面都在 supplementary/ 下，回站前缀就是 ../
        if inject_demobar(p, "../"):
            n += 1
    if n:
        print(f"  · supplementary：{n} 个页面加入回站浮标")
    return n


# ===========================================================================
# 入口
# ===========================================================================

def main() -> None:
    print("\n[补] 修复补充 Demo 与第 1 章独立演示")
    n = apply_patches()
    n += ensure_meta()

    build_yearcalendar()
    print("  · yearcalendar.html：重建（原索引引用但仓库里从来没有这个文件）")

    rp = SUPP / "regression.html"
    if rp.is_file():
        write(rp, REGRESSION_HTML)
        print("  · regression.html：重建（原本算完回归却没画，是张白页）")

    clean_lesson01_demos()
    fix_demo_a11y()
    demobar_lesson01()
    demobar_supplementary()

    print(f"  · 精确修复 {n} 处")


if __name__ == "__main__":
    main()
