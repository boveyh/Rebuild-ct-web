/* ============================================================================
 * verify_render.mjs —— 用真实浏览器跑一遍全站
 * ----------------------------------------------------------------------------
 * 静态审计（tools/audit.py）只能证明「文件都在」，证明不了「页面能跑」。
 * 这份脚本补上后半段：无头浏览器逐页打开，抓四类只有运行时才会暴露的问题：
 *
 *   1. 控制台报错 / 未捕获异常   —— 语法错误、找不到 DOM、第三方脚本冲突
 *   2. 请求失败                  —— 404、CORS、被墙的 CDN
 *   3. DOM 断言                  —— 该出现的东西真的出现了（小节数、概念图、演示区）
 *   4. 交互断言                  —— tab 能切、搜索能出结果、demo 真的挂载出 SVG
 *
 * 用法：
 *   node tools/verify_render.mjs              # 全部检查
 *   node tools/verify_render.mjs --shots      # 同时输出截图
 *   BASE=http://127.0.0.1:8099 node tools/verify_render.mjs
 * ========================================================================== */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const puppeteer = require("puppeteer-core");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.BASE || "http://127.0.0.1:8099";
const SHOTS = process.argv.includes("--shots");
const SHOT_DIR = path.join(ROOT, "tools", "screenshots");

const CHROME_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];

const EX = CHROME_CANDIDATES.find(p => fs.existsSync(p));
if (!EX) {
  console.error("找不到 Chrome / Edge 可执行文件，无法做渲染验证。");
  process.exit(2);
}

/* --------------------------------------------------------------- 页面清单 */

const CHAPTERS = ["01", "02", "03", "04", "05"];

const PAGES = [
  { url: "/", name: "门户",
    expect: { minSections: 5, has: [".chapter-card"], sel: [{ q: ".chapter-card", min: 5 }] } },
  ...CHAPTERS.map(c => ({
    url: `/lesson-${c}/`,
    name: `第 ${c} 章`,
    expect: {
      sel: [{ q: "section.section", min: 4 }, { q: "[data-tab]", min: 3 }],
      has: ["#concept-map", "#sidebar", ".topbar", "[data-tour-start]", "#tour-bar"],
    },
  })),
  ...CHAPTERS.map(c => ({ url: `/lesson-${c}/lecture.html`, name: `第 ${c} 章讲义`, expect: {} })),
  { url: "/glossary.html", name: "术语表", expect: { has: [".term-list"], sel: [{ q: ".term-card", min: 20 }] } },
  { url: "/supplementary/", name: "补充 Demo", expect: { has: [".demo-grid"], sel: [{ q: ".demo-card", min: 10 }] } },
  // 404 页的探测脚本会故意去请求几个不存在的路径来找站点根，
  // 那些 404 是设计的一部分，不算故障（下面 allowFail 放行）。
  { url: "/404.html", name: "404 页", allowFail: /\/404\.html\/assets\//,
    expect: { has: ["[data-root-link]", "[data-tour-start], .topbar"] } },
  { url: "/lesson-01/demo/", name: "第 1 章实验目录",
    expect: { has: ["a[href*='01-data-loader']"], sel: [{ q: "a[href$='index.html']", min: 5 }] } },
  // 这 5 个实验里有的是纯表格/文本演示，不一定会画 SVG，
  // 所以只断言「页面有实质内容 + 回站浮标在」。
  ...["01-data-loader", "02-dikw-pyramid", "03-attribute-types", "04-d3-array-ops", "05-selectors"]
    .map(d => ({ url: `/lesson-01/demo/${d}/index.html`, name: `实验 ${d}`,
                 expect: { has: ["body", ".wb-demobar"] } })),
  // 只断言「有 svg」是不够的：第一版日历把画布宽度算错，格子全画在画布外，
  // 页面依然有一个空 svg。所以这里数格子。
  { url: "/supplementary/yearcalendar.html", name: "van Wijk 日历热图",
    expect: { has: ["#chart svg"], sel: [{ q: "#chart rect.cell", min: 1400 },
                                          { q: "#chart line.wk", min: 200 }] } },
  { url: "/supplementary/regression.html", name: "回归示例", expect: { has: ["#chart svg"] } },
  { url: "/supplementary/calendar.html", name: "螺旋日历", expect: { has: ["svg"] } },
  { url: "/supplementary/calendar1.html", name: "螺旋日历 v1", expect: { has: ["svg"] } },
  { url: "/supplementary/calendar3.html", name: "螺旋日历 v3", expect: { has: ["svg"] } },
  { url: "/supplementary/tableshow.html", name: "表格展示", expect: {} },
  { url: "/supplementary/newstudent.html", name: "新生饼图", expect: { has: ["svg"] } },
  // treelist 是纯 DOM 树（div 折叠），本来就不画 SVG，
  // 断言「渲染出了节点」而不是「有 svg」。
  { url: "/supplementary/treelist.html", name: "树形列表",
    expect: { has: ["body"], sel: [{ q: "[class*='node'], [class*='tree']", min: 3 }] } },
  { url: "/supplementary/nssystem.html", name: "管理系统", expect: {} },
  { url: "/supplementary/crime1985.html", name: "1985 犯罪散点", expect: { has: ["svg"] } },
  { url: "/supplementary/sex_compare.html", name: "性别对比", expect: { has: ["svg"] } },
  { url: "/supplementary/colormap.html", name: "colormap", expect: { has: ["svg"] } },
  { url: "/supplementary/mark.html", name: "标记法", expect: { has: ["svg"] } },
  { url: "/supplementary/contour.html", name: "等值线", expect: { has: ["svg"] } },
  { url: "/supplementary/contourd3.html", name: "d3-contour", expect: { has: ["svg"] } },
];

/* 已知噪声：这些第三方脚本在自己的页面里会打日志/报错，与被测站点无关 */
const IGNORE = [
  /favicon\.ico/i,
  /Download the React DevTools/i,
  /\[D3\]/i,
];

const results = [];
let hardFail = 0;
/* 有几条断言必须按顺序在同一个标签页上操作（滚到某块、读高亮），没法塞进
   interact 那个「先收集、后统一打印」的数组，否则会打两遍。这里单独计数，
   结尾和 interact 一起汇总 —— 否则尾行的「N/N」会永远停留在旧的数字上。 */
let sideChecks = 0;
let sidePass = 0;

function log(s) { process.stdout.write(s + "\n"); }

/* --------------------------------------------------------------- 主流程 */

const browser = await puppeteer.launch({
  executablePath: EX,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars"],
  defaultViewport: { width: 1440, height: 960, deviceScaleFactor: 1 },
});

if (SHOTS) fs.mkdirSync(SHOT_DIR, { recursive: true });

log("=".repeat(76));
log("浏览器渲染验证  " + BASE);
log("内核：" + EX);
log("=".repeat(76));

for (const spec of PAGES) {
  const page = await browser.newPage();
  const errors = [];
  const failed = [];

  page.on("console", m => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (IGNORE.some(r => r.test(t))) return;
    errors.push(t.split("\n")[0].slice(0, 180));
  });
  page.on("pageerror", e => {
    const t = String(e && e.message || e);
    if (IGNORE.some(r => r.test(t))) return;
    errors.push("未捕获：" + t.split("\n")[0].slice(0, 180));
  });
  page.on("requestfailed", r => {
    const u = r.url();
    if (IGNORE.some(x => x.test(u))) return;
    failed.push(`${u.replace(BASE, "")} (${r.failure()?.errorText || "?"})`);
  });
  page.on("response", r => {
    if (r.status() >= 400 && !IGNORE.some(x => x.test(r.url()))) {
      failed.push(`${r.url().replace(BASE, "")} -> HTTP ${r.status()}`);
    }
  });

  let domIssues = [];
  try {
    const resp = await page.goto(BASE + spec.url, { waitUntil: "networkidle2", timeout: 25000 });
    if (!resp || resp.status() >= 400) domIssues.push(`页面本身 HTTP ${resp ? resp.status() : "?"}`);
    await new Promise(r => setTimeout(r, 900));

    const e = spec.expect || {};
    for (const sel of (e.has || [])) {
      if (!(await page.$(sel))) domIssues.push(`缺少选择器 ${sel}`);
    }
    for (const s of (e.sel || [])) {
      const n = (await page.$$(s.q)).length;
      if (n < s.min) domIssues.push(`${s.q} 只有 ${n} 个（期望 ≥ ${s.min}）`);
    }
    if (e.minSections) {
      const n = (await page.$$("a[href^='/lesson-'], a[href^='lesson-'], a[href*='lesson-0']")).length;
      if (n < e.minSections) domIssues.push(`门户章节入口只有 ${n} 个`);
    }

    if (SHOTS) {
      const f = spec.url === "/" ? "portal" : spec.url.replace(/^\/|\/$/g, "").replace(/\//g, "__");
      await page.screenshot({ path: path.join(SHOT_DIR, `${f}.png`), fullPage: false });
    }
  } catch (err) {
    domIssues.push("导航失败：" + String(err.message).split("\n")[0]);
  }

  const allowFail = spec.allowFail;
  const failedReal = allowFail ? failed.filter(u => !allowFail.test(u)) : failed;

  const bad = errors.length + failedReal.length + domIssues.length;
  if (bad) hardFail += 1;

  results.push({ ...spec, errors, failed: failedReal, domIssues });
  log(
    (bad ? "❌ " : "✅ ") + spec.name.padEnd(16, " ") + spec.url
  );
  for (const x of domIssues) log("      · DOM  " + x);
  for (const x of [...new Set(errors)]) log("      · 控制台 " + x);
  for (const x of [...new Set(failedReal)]) log("      · 请求   " + x);

  await page.close();
}

/* ------------------------------------------------ 交互：tab / 搜索 / 主题 */
log("\n" + "-".repeat(76));
log("交互验证");
log("-".repeat(76));

const ipage = await browser.newPage();
const iErr = [];
ipage.on("pageerror", e => iErr.push(String(e.message).split("\n")[0]));
await ipage.goto(BASE + "/lesson-03/", { waitUntil: "networkidle2", timeout: 25000 });
await new Promise(r => setTimeout(r, 800));

const interact = [];

// 1. 演示 tab —— 5 章逐章验证
//    这条断言不能只看「有没有子元素」：加载中/失败时也会插入一个 .demo-state 的
//    <p>，于是「挂载了 1 个元素」恒成立。第一版就是这么写的，结果演示模块 5 章
//    全部 404，这条断言照样是绿的。现在只认 data-ready="1"、挂载点非空、无失败请求。
//    另外必须逐章跑：第 2 章曾因「const DEMOS 重复声明」整章解析失败，而第 3 章
//    是好的 —— 只抽查一章就会漏掉。
for (const cid of ["01", "02", "03", "04", "05"]) {
  const dp = await browser.newPage();
  const fails = [];
  dp.on("response", r => { if (r.status() >= 400) fails.push(`${r.status()} ${r.url()}`); });
  try {
    await dp.goto(`${BASE}/lesson-${cid}/`, { waitUntil: "networkidle2", timeout: 30000 });
    const res = await dp.evaluate(async () => {
      document.querySelectorAll('button[data-tab="demo"]').forEach(b => b.click());
      // 轮询而不是固定 sleep：data-ready 在调用演示函数前就置位，而第 2 章
      // 的演示是 async 的（先 await d3.csv 再写 DOM），只看 ready 会在内容
      // 还没落地时就判定完成，误报「空挂载点」。
      const deadline = Date.now() + 20000;
      let mounts = [...document.querySelectorAll(".demo-mount[data-demo]")];
      while (Date.now() < deadline) {
        mounts = [...document.querySelectorAll(".demo-mount[data-demo]")];
        const done = mounts.filter(
          m => m.getAttribute("data-state") === "error" ||
               (m.getAttribute("data-ready") === "1" && m.children.length > 0)
        );
        if (mounts.length > 0 && done.length === mounts.length) break;
        await new Promise(r => setTimeout(r, 300));
      }
      // 画布越界：内容画到 <svg> 框外就是被裁掉（浏览器默认裁剪 viewBox 外的东西）。
      // 之前有 7 处这样的 bug：第 3 章 CVD 缩略图只剩左上角、第 2 章树标签两侧被切、
      // 第 1 章金字塔底座少一截 —— 全都「看起来没问题」，因为裁掉的部分不会报错。
      const clip = [];
      mounts.forEach(m => {
        m.querySelectorAll("svg").forEach((s, i) => {
          const box = s.getBoundingClientRect();
          if (!box.width || !box.height) return;
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
          s.querySelectorAll("*").forEach(c => {
            const r = c.getBoundingClientRect();
            if (!r.width && !r.height) return;
            x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top);
            x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom);
          });
          if (!isFinite(x0)) return;
          if (x1 - box.right > 2 || y1 - box.bottom > 2 || box.left - x0 > 2 || box.top - y0 > 2)
            clip.push(m.dataset.demo + "#" + i);
        });
      });
      // 日历热图：一年 366 格，如果只有一两种颜色，说明「按日期查温度」根本没查着
      const cal = mounts.find(m => m.dataset.demo === "d-5-3");
      const calColors = cal
        ? new Set([...cal.querySelectorAll("svg rect.cell")].map(r => r.getAttribute("fill"))).size
        : -1;
      return {
        mounts: mounts.length,
        ready: mounts.filter(m => m.getAttribute("data-ready") === "1").length,
        empty: mounts.filter(m => m.children.length === 0).map(m => m.dataset.demo),
        svg: mounts.reduce((n, m) => n + m.querySelectorAll("svg").length, 0),
        state: mounts.map(m => m.getAttribute("data-state") || "-").join(","),
        clip: clip.slice(0, 6),
        nClip: clip.length,
        calColors,
      };
    });
    const ok = res.mounts > 0 && res.ready === res.mounts && res.empty.length === 0 && fails.length === 0;
    interact.push([
      `第 ${cid} 章演示全部渲染（${res.mounts} 个）`,
      ok,
      JSON.stringify({ ...res, fails: fails.slice(0, 3) }),
    ]);
    interact.push([
      `第 ${cid} 章演示的画布没有内容溢出（被裁掉）`,
      res.nClip === 0,
      JSON.stringify({ clip: res.clip }),
    ]);
    if (cid === "05") {
      interact.push([
        "日历热图按温度上色（不是一种颜色）",
        res.calColors >= 30,
        JSON.stringify({ colors: res.calColors }),
      ]);
    }
  } catch (e) {
    interact.push([`第 ${cid} 章演示`, false, String(e.message)]);
  }
  await dp.close();
}

// 2. 命令面板搜索
try {
  const ok = await ipage.evaluate(async () => {
    const btn = document.querySelector("[data-search-open]");
    if (!btn) return { ok: false, why: "没有搜索按钮" };
    btn.click();
    await new Promise(r => setTimeout(r, 600));
    const input = document.querySelector("#search-input");
    if (!input) return { ok: false, why: "面板没打开" };
    input.value = "色";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise(r => setTimeout(r, 900));
    const items = document.querySelectorAll(".search-result").length;
    const empty = document.querySelector(".search-panel__empty");
    return { ok: items > 0, items, msg: empty ? empty.textContent.slice(0, 40) : "" };
  });
  interact.push(["搜索面板能出结果", ok.ok, JSON.stringify(ok)]);
} catch (e) { interact.push(["搜索", false, String(e.message)]); }

/* 3b. 索引覆盖面：搜一个只在术语表里出现的词，必须能落到术语表。
   索引曾经只收录 5 章正文，搜「视觉通道」「色觉缺陷」全是「没有匹配」——
   而术语表本来就是拿来查的。这条断言盯的就是「索引别又漏了某类页面」。 */
try {
  const ok = await ipage.evaluate(async () => {
    const input = document.querySelector("#search-input");
    if (!input) return { ok: false, why: "面板没打开" };
    input.value = "色觉缺陷";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise(r => setTimeout(r, 900));
    const rows = [...document.querySelectorAll(".search-result")];
    const hit = rows.find(r => /术语表/.test(r.textContent));
    return { ok: !!hit, rows: rows.length,
             top: hit ? hit.textContent.replace(/\s+/g, " ").slice(0, 46) : "无术语表命中" };
  });
  interact.push(["搜术语能落到术语表", ok.ok, JSON.stringify({ rows: ok.rows, top: ok.top })]);
} catch (e) { interact.push(["搜术语", false, String(e.message)]); }

// 3. 深色模式
try {
  const ok = await ipage.evaluate(async () => {
    document.querySelector("#theme-toggle")?.click();
    await new Promise(r => setTimeout(r, 350));
    const t = document.documentElement.getAttribute("data-theme");
    return { ok: t === "dark" || t === "light", theme: t };
  });
  interact.push(["主题切换生效", ok.ok, JSON.stringify(ok)]);
} catch (e) { interact.push(["主题", false, String(e.message)]); }

// 4. 英文切换：中英双 DOM 的关键回归点
try {
  const ok = await ipage.evaluate(async () => {
    document.querySelector("[data-lang-btn='en']")?.click();
    await new Promise(r => setTimeout(r, 400));
    const loc = document.documentElement.getAttribute("data-locale");
    const enVisible = [...document.querySelectorAll("[data-lang='en']")]
      .some(el => getComputedStyle(el).display !== "none");
    const zhHidden = [...document.querySelectorAll("[data-lang='zh']")]
      .every(el => getComputedStyle(el).display === "none");
    document.querySelector("[data-lang-btn='zh']")?.click();
    return { ok: loc === "en" && enVisible && zhHidden, loc, enVisible, zhHidden };
  });
  interact.push(["中英双 DOM 切换正确", ok.ok, JSON.stringify(ok)]);
} catch (e) { interact.push(["语言切换", false, String(e.message)]); }

// 5. 概念图渲染 + 每条边都有流动虚线 + 悬停能聚焦邻居
try {
  const ok = await ipage.evaluate(() => {
    const host = document.querySelector("#concept-map");
    if (!host) return { ok: false, reason: "no host" };
    const edges = host.querySelectorAll("g.cm-edge");
    const flows = host.querySelectorAll(".cm-flow");
    const bases = host.querySelectorAll("path[marker-end]");
    const anim = flows[0] ? getComputedStyle(flows[0]).animationName : "";
    const node = host.querySelector("g.cm-node");
    node.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
    const dim = host.querySelectorAll(".is-dim").length;
    const hi = host.querySelectorAll(".is-hi").length;
    node.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse" }));
    const cleared = host.querySelectorAll(".is-dim, .is-hi").length;
    return {
      edges: edges.length, flows: flows.length, bases: bases.length,
      anim, dim, hi, cleared,
      ok: edges.length > 0 && edges.length === flows.length &&
          edges.length === bases.length && anim === "cm-flow" &&
          dim > 0 && hi > 0 && cleared === 0,
    };
  });
  interact.push(["概念图连线在流动、悬停能聚焦", ok.ok, JSON.stringify(ok)]);
} catch (e) { interact.push(["概念图", false, String(e.message)]); }

// 6. 进度记录：标记一节已读后刷新，看是否还在
try {
  const ok = await ipage.evaluate(async () => {
    // 「读完」的判据是「小节底边越过视口 60% 线」，所以必须真的往下滚。
    // 只把某一节滚到视口顶部是不够的 —— 那一节才刚开始。
    const key = document.querySelector("[data-progress-key]")?.getAttribute("data-progress-key");
    const step = Math.round(window.innerHeight * 0.8);
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise(r => setTimeout(r, 220));
    }
    window.scrollTo(0, document.documentElement.scrollHeight);
    await new Promise(r => setTimeout(r, 900));
    const stored = JSON.parse(localStorage.getItem("wb.progress") || "{}");
    // 只看本章（第 3 章）那一项：侧栏里还有「全部章节」的其他 4 章，
    // 它们本来就是 0%，拿第一个匹配值会误判。
    const own = document.querySelector('[data-progress-scope="c03s"]');
    const pct = own?.getAttribute("data-progress-value");
    const ok = Object.keys(stored).length > 0 && pct === "100";
    return { ok, key, stored: Object.keys(stored).length, 本章进度: pct };
  });
  interact.push(["阅读进度写入 localStorage", ok.ok, JSON.stringify(ok)]);
} catch (e) { interact.push(["进度", false, String(e.message)]); }

// 7. 首次访问时，每一节都必须有一个可见面板
//
// 这一条专门补一个「自己撞不见」的 bug：原来的逻辑是「有 tab 记忆才恢复选择」，
// 于是第一次来的读者（localStorage 里没有 wb.tab）一个面板都没被选中，
// 而 CSS 里 .tab-panel 默认 display:none —— 整章 24 个面板全部不可见，
// 页面只剩一行行小节标题，正文从约 2 万字掉到 1208 字。
// 我们自己的测试一直是绿的，因为前面几步点过 tab、留下了记忆。
// 所以这里必须清掉记忆再新开一个页面，模拟真正的首访。
try {
  const fresh = await browser.newPage();
  const fErr = [];
  fresh.on("pageerror", e => fErr.push(String(e.message).split("\n")[0]));
  await fresh.setViewport({ width: 1440, height: 900 });
  await fresh.goto(BASE + "/lesson-03/", { waitUntil: "networkidle2" });
  await fresh.evaluate(() => localStorage.removeItem("wb.tab"));
  await fresh.reload({ waitUntil: "networkidle2" });
  await new Promise(r => setTimeout(r, 700));
  const ok = await fresh.evaluate(() => {
    const secs = [...document.querySelectorAll("section.section")];
    const empty = secs.filter(s =>
      ![...s.querySelectorAll(".tab-panel")].some(p => p.getClientRects().length));
    const chars = document.body.innerText.replace(/\s+/g, " ").trim().length;
    return {
      ok: secs.length > 0 && empty.length === 0 && chars > 3000,
      secs: secs.length, empty: empty.map(s => s.getAttribute("data-section-id")), chars,
    };
  });
  if (fErr.length) ok.ok = false;
  interact.push(["首访每节都有可见面板", ok.ok, JSON.stringify(ok)]);
  await fresh.close();
} catch (e) { interact.push(["首访可见性", false, String(e.message)]); }

// 8. 图片点击放大
//    课程里不少图本身就是内容（第 2 章那张 Mackinlay 通道排序图 1205×779，
//    正文里最宽 920px）。放大层要能开、要大过正文、要有关闭途径。
try {
  await ipage.goto(BASE + "/lesson-02/", { waitUntil: "networkidle2", timeout: 30000 });
  const ok = await ipage.evaluate(async () => {
    const img = [...document.querySelectorAll(".content img.is-zoomable")].find(i => i.getClientRects().length);
    if (!img) return { ok: false, why: "没有可放大的图" };
    const before = img.getBoundingClientRect().width;
    img.click();
    await new Promise(r => setTimeout(r, 900));
    const d = document.querySelector("dialog.img-zoom");
    const big = d?.querySelector("img");
    const after = big?.getBoundingClientRect().width || 0;
    const open = !!d?.open;
    d?.close();
    await new Promise(r => setTimeout(r, 200));
    const closed = !document.querySelector("dialog.img-zoom")?.open;
    return { ok: open && after > before && closed,
             before: Math.round(before), after: Math.round(after), open, closed };
  });
  interact.push(["图片可点击放大", ok.ok, JSON.stringify(ok)]);
} catch (e) { interact.push(["图片放大", false, String(e.message)]); }

// 9. 章节卡右上角的进度环
//
//    「80%」从一行字换成了一个环形表盘。这里最大的风险不是画不出来，而是
//    被写坏：shell.js 原来对 [data-progress-out] 整块写 textContent，会把
//    <svg> 一起铲掉，只剩一个数字 —— 页面上不报错、不缺元素，只是环没了。
//    所以三件事一起盯：环还在、弧长等于剩余比例、环心数字与卡片属性一致。
try {
  const p = await browser.newPage();
  const pErr = [];
  p.on("pageerror", e => pErr.push(String(e.message).split("\n")[0]));
  await p.setViewport({ width: 1440, height: 950 });
  await p.goto(BASE + "/", { waitUntil: "networkidle2" });
  await p.evaluate(() => {
    const m = {};
    for (let i = 1; i <= 4; i++) m["c01s" + i] = 1;   // 第 1 章 4/5 → 80%
    for (let i = 1; i <= 4; i++) m["c02s" + i] = 1;   // 第 2 章 4/4 → 100%
    localStorage.setItem("wb.progress", JSON.stringify(m));
  });
  await p.reload({ waitUntil: "networkidle2" });
  const ok = await p.evaluate(async () => {
    // 环的入场动画由 IntersectionObserver 触发，必须让每张卡真的进过视口，
    // 否则后半段卡片停在初始的「空环」上，读到的 offset 是空字符串。
    document.documentElement.style.scrollBehavior = "auto";
    const step = Math.round(window.innerHeight * 0.7);
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise(r => setTimeout(r, 180));
    }
    await new Promise(r => setTimeout(r, 1300));   // 填充过渡 900ms
    const rows = [...document.querySelectorAll(".chapter-card")].map(c => {
      const fill = c.querySelector(".chapter-card__ring-fill");
      const num = c.querySelector("[data-progress-num]");
      const pct = Number(c.getAttribute("data-progress-value"));
      return {
        pct,
        num: num ? num.textContent.trim() : null,
        // 内联值是动画的目标值；computed 读到的是插值中间态，不能拿来判断
        offset: fill ? Number(fill.style.strokeDashoffset) : null,
      };
    });
    const ok = rows.length >= 5 &&
      rows.every(r => r.num === r.pct + "%" && r.offset === 100 - r.pct);
    return { ok, 第一张: rows[0], 比例: rows.map(r => r.pct) };
  });
  if (pErr.length) ok.ok = false;
  interact.push(["章节卡进度环与百分比一致", ok.ok, JSON.stringify(ok)]);
  await p.close();
} catch (e) { interact.push(["进度环", false, String(e.message)]); }

//    章末自测：答对与答错都要给出解析，正确项必须被标出来，
//    回查链接必须指向真实存在的小节（否则读者点了个寂寞）。
try {
  await ipage.goto(BASE + "/lesson-03/", { waitUntil: "networkidle2", timeout: 30000 });
  const ok = await ipage.evaluate(async () => {
    const items = [...document.querySelectorAll(".quiz__item")];
    if (!items.length) return { ok: false, why: "没有自测题" };
    const right = items[0], wrong = items[1];
    right.querySelector(`.quiz__opt[data-i="${right.dataset.answer}"]`).click();
    const bad = wrong.dataset.answer === "0" ? "1" : "0";
    wrong.querySelector(`.quiz__opt[data-i="${bad}"]`).click();
    await new Promise(r => setTimeout(r, 100));
    const ref = right.querySelector(".quiz__ref");
    const target = ref && document.querySelector(ref.getAttribute("href"));
    return {
      ok: !!target && /答对了/.test(right.querySelector("[data-quiz-verdict]").textContent) &&
          /不对/.test(wrong.querySelector("[data-quiz-verdict]").textContent) &&
          wrong.querySelector(`.quiz__opt[data-i="${wrong.dataset.answer}"]`).dataset.state === "ok",
      n: items.length,
      refOk: !!target,
      score: document.querySelector("[data-quiz-score]").textContent,
    };
  });
  interact.push(["章末自测判分且有回查链接", ok.ok, JSON.stringify(ok)]);
} catch (e) { interact.push(["章末自测", false, String(e.message)]); }

//    术语互链：正文里点术语要能落到术语表对应词条，且不被筛选器藏起来。
try {
  await ipage.goto(BASE + "/lesson-05/", { waitUntil: "networkidle2", timeout: 30000 });
  const href = await ipage.evaluate(() => document.querySelector(".term-link")?.getAttribute("href"));
  let ok = { ok: false, why: "没有术语链接" };
  if (href) {
    await ipage.goto(BASE + href.replace("../", "/"), { waitUntil: "networkidle2", timeout: 30000 });
    await new Promise(r => setTimeout(r, 400));
    ok = await ipage.evaluate(() => {
      const id = decodeURIComponent(location.hash.slice(1));
      const el = document.getElementById(id);
      const box = el?.getBoundingClientRect();
      return { ok: !!box && box.height > 0 && box.top >= 0 && box.top < innerHeight,
               target: id, top: box ? Math.round(box.top) : null };
    });
  } else ok.href = href;
  interact.push(["正文术语能跳到术语表词条", ok.ok, JSON.stringify(ok)]);
} catch (e) { interact.push(["术语互链", false, String(e.message)]); }

/*    演示不得依赖第三方 CDN。
    d3 原先从 jsDelivr 的 +esm 入口取，那个入口不打包 —— 浏览器实际要发 40 多个
    模块请求，网络受限时（和部分公司网络）整块演示区就停在「正在加载演示…」。
    这条断言盯两件事：③ 加载演示期间没有任何站外请求；④ 本地 vendor 包确实被命中。
    只查 ③ 不够：把 import 改错路径时请求会全部落在站内（404 也在站内）。 */
try {
  const dp = await browser.newPage();
  const external = [];
  dp.on("request", r => {
    const u = r.url();
    if (!u.startsWith(BASE) && !/^(data|blob|about):/.test(u)) external.push(u.slice(0, 90));
  });
  await dp.goto(BASE + "/lesson-03/", { waitUntil: "networkidle2", timeout: 30000 });
  await dp.evaluate(() => document.querySelectorAll('button[data-tab="demo"]').forEach(b => b.click()));
  await new Promise(r => setTimeout(r, 3000));
  const seen = await dp.evaluate(() => {
    const res = performance.getEntriesByType("resource").map(e => e.name);
    return {
      vendor: res.filter(u => /vendor\/d3\.esm\.js/.test(u)).length,
      cdn: res.filter(u => !u.startsWith(location.origin)).length,
      ready: document.querySelectorAll('.demo-mount[data-ready="1"]').length,
    };
  });
  await dp.close();
  interact.push([
    "演示不依赖站外 CDN（d3 走本地）",
    external.length === 0 && seen.vendor === 1 && seen.cdn === 0 && seen.ready > 0,
    JSON.stringify({ 站外请求: external.slice(0, 3), ...seen }),
  ]);
} catch (e) { interact.push(["演示依赖", false, String(e.message)]); }

/*    色板切换：这不只是"按钮能点"，而是色带真的换了颜色、判语也跟着翻。
    之前 #seq-bar 把归一化后的 t 喂给了 domain 为 [0,350] 的 scaleSequential，
    整条带子全部落在 t≈0 那端 —— 一色到底，看上去就像"数据没差异"。
    所以这里量「不同颜色数」，而不是"有没有子元素"。 */
try {
  await ipage.goto(BASE + "/lesson-03/", { waitUntil: "networkidle2", timeout: 30000 });
  const ok = await ipage.evaluate(async () => {
    document.querySelectorAll('button[data-tab="demo"]').forEach(b => b.click());
    await new Promise(r => setTimeout(r, 2600));
    const bar = document.querySelector("#switch-bar");
    const seqBar = document.querySelector("#seq-bar");
    if (!bar || !seqBar) return { ok: false, why: "演示没挂载" };
    const grab = (el) => [...el.children].map(c => c.style.background);
    const before = grab(bar);
    const seq = grab(seqBar);
    document.querySelector('[data-pal="turbo"]')?.click();
    await new Promise(r => setTimeout(r, 250));
    const after = grab(bar);
    const note = document.querySelector("#switch-note");
    return {
      ok: seq.length >= 40 && new Set(seq).size >= 25 &&
          before.length === after.length && before[0] !== after[0] &&
          note?.dataset.tone === "bad",
      cells: seq.length,
      seqColors: new Set(seq).size,
      switchColors: new Set(before).size,
      tone: note?.dataset.tone,
    };
  });
  interact.push(["色板切换真的换了颜色", ok.ok, JSON.stringify(ok)]);
} catch (e) { interact.push(["色板切换", false, String(e.message)]); }

/*    减弱动效偏好下，段落不该先隐藏再淡入 —— 对前庭敏感的读者来说，
    淡入本身就是要避开的东西。切到 reduce 后 .reveal 应当一个都不剩。 */
try {
  const rp = await browser.newPage();
  await rp.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await rp.goto(BASE + "/lesson-03/", { waitUntil: "networkidle2", timeout: 30000 });
  await new Promise(r => setTimeout(r, 600));
  const res = await rp.evaluate(() => ({
    reveal: document.querySelectorAll(".reveal").length,
    motion: document.documentElement.getAttribute("data-motion"),
    chars: document.body.innerText.replace(/\s+/g, "").length,
  }));
  await rp.close();
  interact.push([
    "减弱动效时不隐藏任何段落",
    res.reveal === 0 && res.motion === null && res.chars > 3000,
    JSON.stringify(res),
  ]);
} catch (e) { interact.push(["减弱动效", false, String(e.message)]); }

/*    知识图谱可拖动，且拖完算数。
    拖动本身好做，难的是「切主题 / 切语言会整图重绘」之后位置还在 ——
    第一版就是重绘时把偏移读丢了，节点悄悄弹回原位，肉眼几乎看不出，
    因为重绘只发生在切主题的一瞬间。所以这里拖完先切主题再量。 */
try {
  const gp = await browser.newPage();
  await gp.setViewport({ width: 1440, height: 900 });
  await gp.goto(BASE + "/lesson-03/", { waitUntil: "networkidle2", timeout: 30000 });
  await gp.evaluate(() => document.getElementById("concept-map").scrollIntoView({ block: "center" }));
  await new Promise(r => setTimeout(r, 500));
  /* 等节点停下来再量坐标。概念图有入场动画（节点从位移 0 飞到位），
     动画途中量到的坐标和松手时的差着几十像素，鼠标就会按在空处 ——
     单独跑能过、整套连跑十几页时偶发失败，就是栽在这里。 */
  let box = null;
  for (let i = 0; i < 20; i++) {
    const now = await gp.evaluate(() => {
      const g = document.querySelector("#concept-map g.cm-node");
      const r = g.getBoundingClientRect();
      // 记住 id：拖动时节点会被提到最上层，DOM 顺序会变，不能靠「第一个 g」找它
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), id: g.dataset.node };
    });
    if (box && now.x === box.x && now.y === box.y) { box = now; break; }
    box = now;
    await new Promise(r => setTimeout(r, 90));
  }
  await gp.mouse.move(box.x, box.y);
  await gp.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await gp.mouse.move(box.x + i * 10, box.y + i * 5);
    await new Promise(r => setTimeout(r, 16));
  }
  await gp.mouse.up();
  await new Promise(r => setTimeout(r, 220));

  const read = () => gp.evaluate((id) => {
    const host = document.getElementById("concept-map");
    return {
      tr: host.querySelector(`g.cm-node[data-node="${id}"]`).getAttribute("transform"),
      edge: host.querySelector("path[marker-end]").getAttribute("d").slice(0, 24),
      resetHidden: host.closest("figure").querySelector(".cm-reset")?.hidden,
    };
  }, box.id);
  const dragged = await read();
  await gp.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await new Promise(r => setTimeout(r, 420));
  const afterTheme = await read();
  await gp.evaluate(() => document.querySelector(".cm-reset").click());
  await new Promise(r => setTimeout(r, 320));
  const afterReset = await read();
  await gp.close();

  const num = (tr) => {
    const m = /translate\((-?[\d.]+),(-?[\d.]+)\)/.exec(tr || "");
    return m ? Math.hypot(+m[1], +m[2]) : 0;
  };
  interact.push([
    "知识图谱节点可拖动且重绘后不弹回",
    num(dragged.tr) > 40 && num(afterTheme.tr) === num(dragged.tr) &&
      !dragged.resetHidden && num(afterReset.tr) === 0 && afterReset.resetHidden,
    JSON.stringify({ 拖后: Math.round(num(dragged.tr)), 切主题后: Math.round(num(afterTheme.tr)),
                     复位后: Math.round(num(afterReset.tr)), 边上跟着变: dragged.edge }),
  ]);
} catch (e) { interact.push(["知识图谱拖动", false, String(e.message)]); }

/*    学习路径：三条路线各画成一条关卡路径。光数容器会被「有卡片没连线」
    骗过去 —— 连线是脚本按站点位置现画的，一个 dot 都量不到就整块消失，
    所以同时检查线段数（每条路线 = 站点数 - 1）与流动层（每条路线一层）。
    链接不再挂在站点上（站点是按钮，点了先看右侧说明），改查数据里的 href。 */
try {
  await ipage.goto(BASE + "/", { waitUntil: "networkidle2", timeout: 30000 });
  const routes = await ipage.evaluate(() => {
    const data = JSON.parse(document.getElementById("path-data").textContent);
    const hrefs = data.worlds.flatMap(w => w.steps.map(s => s.href));
    return {
      worlds: document.querySelectorAll(".world").length,
      stops: document.querySelectorAll(".stop").length,
      segs: document.querySelectorAll(".pathmap__seg").length,
      flows: document.querySelectorAll(".pathmap__flow").length,
      hrefs: hrefs.length,
      linksOk: hrefs.every(h => /^lesson-0[1-5]\/$/.test(h)),
      cta: document.querySelector(".paths__cta")?.getAttribute("href"),
      title: document.querySelector(".paths__title")?.textContent.trim(),
    };
  });
  interact.push([
    "三条路径画成关卡图（11 站 / 连线按站数生成 / 链接有效）",
    routes.worlds === 3 && routes.stops === 11 && routes.segs === 8 &&
      routes.flows === 3 && routes.hrefs === 11 && routes.linksOk &&
      routes.cta === "lesson-01/" && routes.title === "数据",
    JSON.stringify(routes),
  ]);
} catch (e) { interact.push(["学习路径", false, String(e.message)]); }

/*    关卡详情面板：站点是按钮，点/悬停都要换面板内容。只验「有面板」不够 ——
    面板一开始就有静态内容（第一条路线第 1 站），换不动也照样是满的。
    所以点第 2 条路线的第 3 站，要求标题与 CTA 都换成那一章的。 */
try {
  const panel = await (async () => {
    const stop = '.world[data-world="1"] .stop[data-i="2"] .stop__btn';
    await ipage.hover(stop);
    await new Promise(r => setTimeout(r, 220));
    const a = await ipage.evaluate(() => ({
      title: document.querySelector(".paths__title")?.textContent.trim(),
      cta: document.querySelector(".paths__cta")?.getAttribute("href"),
      active: [...document.querySelectorAll(".stop.is-active")].map(s => s.dataset.ch),
      eyebrow: document.querySelector(".paths__eyebrow")?.textContent.trim(),
    }));
    await ipage.click(stop);
    await new Promise(r => setTimeout(r, 220));
    const b = await ipage.evaluate(() => ({
      active: [...document.querySelectorAll(".stop.is-active")].map(s => s.dataset.ch),
    }));
    return { hover: a, click: b };
  })();
  interact.push([
    "点关卡换右侧详情（标题 / 入口 / 选中态跟着走）",
    panel.hover.title === "低维数据可视化" && panel.hover.cta === "lesson-04/" &&
      panel.hover.active.join() === "04" && /PATH 02/.test(panel.hover.eyebrow) &&
      /第 3 站/.test(panel.hover.eyebrow) && panel.click.active.join() === "04",
    JSON.stringify(panel),
  ]);
} catch (e) { interact.push(["关卡详情面板", false, String(e.message)]); }

/*    首屏工作台：底边必须停在统计条上方 —— 数字浮在图表上会像排版事故；
    右边缘不能伸出视口，1024 那档最容易把右侧「关系」面板切掉一半。
    同时确认连线上的光点真的在动（animationName 被 CSS 覆盖掉就静了）。 */
try {
  const rows = [];
  for (const w of [1440, 1200, 1024, 1000]) {
    await ipage.setViewport({ width: w, height: 900 });
    await ipage.goto(BASE + "/", { waitUntil: "networkidle2", timeout: 30000 });
    const r = await ipage.evaluate(() => {
      const art = document.querySelector(".portal-hero__art");
      const stats = document.querySelector(".portal-stats");
      const a = art.getBoundingClientRect();
      const s = stats.getBoundingClientRect();
      const flows = [...document.querySelectorAll(".hero-flow")];
      return {
        shown: a.width > 0,
        right: Math.round(a.right), bottom: Math.round(a.bottom),
        statsTop: Math.round(s.top), vw: innerWidth,
        flows: flows.length,
        anim: flows[0] ? getComputedStyle(flows[0]).animationName : "",
      };
    });
    rows.push({ w, ...r });
  }
  await ipage.setViewport({ width: 1440, height: 900 });
  const wide = rows.filter(r => r.w > 1020);
  const narrow = rows.filter(r => r.w <= 1020);
  const ok =
    wide.every(r => r.shown && r.right <= r.vw && r.bottom <= r.statsTop &&
                    r.flows >= 10 && r.anim === "hero-flow") &&
    narrow.every(r => !r.shown);
  interact.push(["首屏工作台不压统计条、不出视口、连线在流动", ok, JSON.stringify(rows)]);
} catch (e) { interact.push(["首屏工作台", false, String(e.message)]); }

/*    切英文之后正文里不该再留中文。
    这条是用户报的原始问题：首页点 EN「像没反应」—— 语言状态确实切了，
    可标题、副标题、统计条全是硬编码中文。所以断言不看 lang 属性，
    直接数「可见的中文文本节点」。教师姓名是专有名词，允许留着。 */
try {
  const langs = [];
  for (const path of ["/", "/lesson-03/", "/lesson-03/lecture.html", "/glossary.html"]) {
    await ipage.goto(BASE + path, { waitUntil: "networkidle2", timeout: 30000 });
    const r = await ipage.evaluate(async () => {
      const btn = document.querySelector("[data-lang-btn='en']");
      if (!btn || btn.disabled) return { skipped: true };
      btn.click();
      await new Promise(r => setTimeout(r, 420));
      const walker = document.createTreeWalker(document.querySelector("main"), NodeFilter.SHOW_TEXT);
      const hits = [];
      const demoHits = [];
      let n;
      while ((n = walker.nextNode())) {
        const t = n.nodeValue.trim();
        if (!t || !/[\u4e00-\u9fa5]/.test(t)) continue;
        const el = n.parentElement;
        if (!el || !el.getClientRects().length) continue;
        if (el.tagName === "A" && t === "李昕") continue;   // 人名保留中文
        // 演示区里的解说目前只有中文（27 个演示的文案没做双语），
        // 单独计数、只报不判 —— 但它必须是可见的「已知缺口」而不是悄悄放过。
        if (el.closest(".demo-mount")) { demoHits.push(t.slice(0, 12)); continue; }
        hits.push(t.slice(0, 20));
      }
      return { count: hits.length, demoLeft: demoHits.length, sample: hits.slice(0, 4), lang: document.documentElement.dataset.locale };
    });
    langs.push({ path, ...r });
  }
  const bad = langs.filter(l => l.skipped || l.count > 0);
  interact.push([
    "切英文后正文无中文残留（演示区除外）",
    bad.length === 0,
    JSON.stringify(bad.length ? bad : langs.map(l => l.path + ":" + l.lang + (l.demoLeft ? ` / 演示内中文 ${l.demoLeft} 处` : ""))),
  ]);
} catch (e) { interact.push(["英文模式", false, String(e.message)]); }

/*    讲义英文版：正文能切，且侧栏目录在英文下的锚点确实指向英文正文
    （英文锚点带 -en 后缀，否则会跳到被隐藏的中文标题上）。 */
try {
  await ipage.goto(BASE + "/lesson-03/lecture.html", { waitUntil: "networkidle2", timeout: 30000 });
  const lec = await ipage.evaluate(async () => {
    document.querySelector("[data-lang-btn='en']").click();
    await new Promise(r => setTimeout(r, 420));
    const link = document.querySelector('.sidebar__link[data-lang="en"]');
    const href = link && link.getAttribute("href");
    const target = href && document.querySelector(href);
    return {
      href,
      targetVisible: !!target && target.getClientRects().length > 0,
      enVisible: [...document.querySelectorAll('.lecture [data-lang="en"]')].filter(e => e.getClientRects().length).length,
      zhVisible: [...document.querySelectorAll('.lecture [data-lang="zh"]')].filter(e => e.getClientRects().length).length,
    };
  });
  interact.push([
    "讲义可切英文且目录锚点指向英文正文",
    lec.href?.endsWith("-en") && lec.targetVisible && lec.enVisible > 0 && lec.zhVisible === 0,
    JSON.stringify(lec),
  ]);
} catch (e) { interact.push(["讲义英文版", false, String(e.message)]); }

await ipage.goto(BASE + "/lesson-03/", { waitUntil: "networkidle2", timeout: 30000 });

for (const [name, ok, detail] of interact) {
  if (!ok) hardFail += 1;
  log((ok ? "✅ " : "❌ ") + name.padEnd(34, " ") + detail);
}
if (iErr.length) log("   页面异常：" + iErr.join(" | "));

/* ------------------------------------------------- 布局成型检查 */
/* 这一段是有来由的：门户页的 head 里曾漏掉 portal.css，于是 .chapter-grid、
   .portal-stats 这些容器一个样式都没有，首页塌成一列纯文字。
   而当时所有检查都是"绿"的 —— 元素都在、没有报错、没有 404。
   所以这里不看元素在不在，只量它「排开了没有」：
   数一个容器里出现了多少个不同的左边界，就是它实际排出的列数。 */
log("\n" + "-".repeat(76));
log("布局成型（门户页在 1440 宽下是否真的排开了）");
log("-".repeat(76));

const lpage = await browser.newPage();
const lErr = [];
lpage.on("pageerror", e => lErr.push(String(e.message).split("\n")[0]));

await lpage.setViewport({ width: 1440, height: 900 });
await lpage.goto(BASE + "/", { waitUntil: "networkidle2" });
await new Promise(r => setTimeout(r, 700));

const layout = await lpage.evaluate(() => {
  function columns(sel) {
    const host = document.querySelector(sel);
    if (!host) return { sel, cols: 0 };
    const xs = [...host.children]
      .filter(el => {
        const s = getComputedStyle(el);
        // 绝对定位的装饰元素（如卡片右上角的 glow）不参与栅格，排除掉
        return s.display !== "none" && s.position !== "absolute";
      })
      .map(el => Math.round(el.getBoundingClientRect().left));
    return { sel, cols: [...new Set(xs)].length };
  }
  const motif = document.querySelector(".chapter-card__motif");
  const r = motif?.getBoundingClientRect();
  const kg = document.getElementById("kg-app");
  return {
    chapterGrid: columns(".chapter-grid"),
    stats: columns(".portal-stats"),
    howto: columns(".howto-grid"),
    motifs: document.querySelectorAll(".chapter-card__motif").length,
    motifShapes: document.querySelectorAll(
      ".chapter-card__motif rect, .chapter-card__motif circle, .chapter-card__motif path"
    ).length,
    motifBox: r ? Math.round(r.width) + "x" + Math.round(r.height) : "缺失",
    kgShell: !!kg && !!kg.querySelector(".kg__canvas") && !!kg.querySelector(".kg__panel"),
  };
});

const layoutOk =
  layout.chapterGrid.cols >= 3 &&
  // 统计条从 5 项减到 4 项（去掉了「预计总时长」），阈值跟着降到 4
  layout.stats.cols >= 4 &&
  layout.howto.cols >= 4 &&
  layout.motifs === 5 &&
  layout.motifShapes >= 20 &&
  layout.kgShell;
if (!layoutOk) hardFail += 1;
log((layoutOk ? "✅ " : "❌ ") + "章节网格 / 统计条 / 使用说明真的排开了  " + JSON.stringify(layout));

/* ------------------------------------------------------------ 门户的信息架构 */
/* 门户是一张长页，四块内容彼此没有横向联系，读者只能靠往下滚来发现它们。
   顶栏那排导航是唯一的「往哪去」提示，因此两件事必须成立：
     1. 导航项的顺序 = 版块在页面里的顺序（对不上，点一次就会觉得被骗）；
     2. 滚到某一块时导航要亮起来（否则读者不知道自己在哪，也不知道还能去哪）。

   这条断言同时守住「学习路径」不再被挤到后面 —— 它曾经排在知识图谱之后，
   而知识图谱有近一屏高，于是学习路径被推到第三屏，看起来像被删掉了。 */
const NAV_TARGETS = ["paths", "kg", "chapters", "howto"];
const ia = await lpage.evaluate(() => ({
  ids: [...document.querySelectorAll(".portal-section")].map(s => s.id).filter(Boolean),
  nav: [...document.querySelectorAll(".topnav__link")].map(a => a.getAttribute("data-nav-target")),
  brand: document.querySelector(".topbar__brand") !== null,
  toggle: document.querySelector("#sidebar-toggle") !== null,
}));
const iaOrderOk =
  ia.ids.join(",") === NAV_TARGETS.join(",") &&
  ia.nav.join(",") === NAV_TARGETS.join(",") &&
  // 门户没有侧栏，就不该有开侧栏的按钮
  ia.brand && !ia.toggle;
sideChecks += 1;
if (iaOrderOk) sidePass += 1; else hardFail += 1;
log((iaOrderOk ? "✅ " : "❌ ") + "板块顺序与顶栏导航一致（学习路径在知识图谱之前）  " + JSON.stringify(ia));

await lpage.evaluate(() => document.getElementById("kg-app").scrollIntoView({ block: "center" }));
await new Promise(r => setTimeout(r, 550));
const iaSpy = await lpage.evaluate(() => ({
  current: [...document.querySelectorAll(".topnav__link")]
    .filter(a => a.getAttribute("aria-current") === "true")
    .map(a => a.getAttribute("data-nav-target")),
}));
const spyOk = iaSpy.current.length === 1 && iaSpy.current[0] === "kg";
sideChecks += 1;
if (spyOk) sidePass += 1; else hardFail += 1;
log((spyOk ? "✅ " : "❌ ") + "滚到知识图谱时顶栏高亮跟着走  " + JSON.stringify(iaSpy));

/* ------------------------------------------------------------ 学习路径的进度 */
/* 步骤序号上的对勾由 shell.js 统一写 data-progress-value，但它只在 100% 时
   才有视觉差异 —— 刚读了两章的人看到的是一条完全静止的路径。所以卡片上另有
   一行「已读 m / n 章」。两件事一起验：
     1. 一章没读时这行不出现（写「已读 0 / 5」只会让人觉得落后）；
     2. 读完之后出现，且对勾数量与已读完的章数一致。 */
let routeFail = 0;
const rp = await browser.newPage();
await rp.setViewport({ width: 1440, height: 900 });
await rp.evaluateOnNewDocument(() => {
  try { localStorage.setItem("wb.theme", "light"); localStorage.setItem("wb.locale", "zh"); } catch (e) {}
});
await rp.goto(BASE + "/", { waitUntil: "networkidle2" });
await rp.evaluate(() => localStorage.removeItem("wb.progress"));
await rp.reload({ waitUntil: "networkidle2" });
await new Promise(r => setTimeout(r, 700));
const routeFresh = await rp.evaluate(() => ({
  shown: [...document.querySelectorAll("[data-route-meter]")].filter(m => !m.hidden).length,
  total: document.querySelectorAll("[data-route-meter]").length,
}));
const freshOk = routeFresh.total === 3 && routeFresh.shown === 0;
sideChecks += 1;
if (freshOk) sidePass += 1;
if (!freshOk) routeFail += 1;
log((freshOk ? "✅ " : "❌ ") + "没读过时路径不显示进度  " + JSON.stringify(routeFresh));

await rp.evaluate(() => {
  // 第 1 章 5 节全部读完，第 2 章只读 2 节
  localStorage.setItem("wb.progress", JSON.stringify({
    c01s1: 1, c01s2: 1, c01s3: 1, c01s4: 1, c01s5: 1, c02s1: 1, c02s2: 1,
  }));
});
await rp.reload({ waitUntil: "networkidle2" });
await new Promise(r => setTimeout(r, 900));
const routeProg = await rp.evaluate(() => ({
  meters: [...document.querySelectorAll("[data-route-meter]")].filter(m => !m.hidden)
    .map(m => ({ text: m.textContent.trim(), state: m.getAttribute("data-state") })),
  ticks: [...document.querySelectorAll(".stop")]
    .filter(s => s.getAttribute("data-progress-value") === "100").length,
  // 站点上的文字状态：读完的写「已读完」，中途的写「读到 x / y」
  states: [...document.querySelectorAll("[data-stop-state]")].map(s => s.textContent),
  done: [...document.querySelectorAll('.stop[data-done="1"]')].length,
}));
const progOk = routeProg.meters.length === 3 &&
               routeProg.meters.every(m => /已读 1 \/ \d+ 章/.test(m.text)) &&
               routeProg.meters[0].state === "partial" &&
               routeProg.ticks === 3 &&
               routeProg.done === 3 &&
               routeProg.states.filter(x => x === "已读完").length === 3 &&
               // 第 2 章只在两条路线里（第三条是 01/03/05），所以是 2 而不是 3
               routeProg.states.filter(x => /^读到 2 \//.test(x)).length === 2;
sideChecks += 1;
if (progOk) sidePass += 1;
if (!progOk) routeFail += 1;
log((progOk ? "✅ " : "❌ ") + "读过之后显示「已读 m / n 章」并给章节打勾  " + JSON.stringify(routeProg));
await rp.close();
if (routeFail) hardFail += routeFail;

/* ------------------------------------------------------------ 演示区的双语层 */
/* 演示模块是从原站快照重抽的，译文只能落在运行时（assets/js/demo-i18n.js）。
   这条断言守两件事：
     1. 切到英文后，演示区不该再出现中文解说（代码块里的注释与程序输出除外）；
     2. 切回中文要能还原 —— 单向替换最容易留下「一半英文一半中文」的残页。
   顺带撞两个原站老 bug：函数演示选 reduce 会抛错、投票点错选项毫无反应。 */
{
  const dp = await browser.newPage();
  await dp.setViewport({ width: 1440, height: 1000 });
  const dpErrs = [];
  dp.on("pageerror", e => dpErrs.push(e.message));
  await dp.evaluateOnNewDocument(() => {
    try { localStorage.setItem("wbThemeless", "1"); localStorage.setItem("wb.locale", "zh"); } catch (e) {}
  });
  await dp.goto(BASE + "/lesson-01/", { waitUntil: "networkidle2" });
  const zhFirst = await dp.evaluate(async () => {
    const m = document.querySelector('.demo-mount[data-demo="d-3-1"]');
    window.WBLesson.runDemo(m);
    for (let i = 0; i < 30 && !m.querySelector("table"); i++) {
      await new Promise(r => setTimeout(r, 150));
    }
    return m.innerText.replace(/\s+/g, " ").slice(0, 40);
  });

  // 函数演示：切到 reduce（返回标量，原站这里 [...out] 直接抛 out is not iterable）
  const reduceOut = await dp.evaluate(async () => {
    const m = document.querySelector('.demo-mount[data-demo="d-3-4"]');
    window.WBLesson.runDemo(m);
    for (let i = 0; i < 20 && !m.querySelector("select"); i++) await new Promise(r => setTimeout(r, 150));
    const sel = m.querySelector("select");
    sel.value = "reduce";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise(r => setTimeout(r, 500));
    return m.innerText.replace(/\s+/g, " ");
  });

  await dp.evaluate(() => {
    const b = document.querySelector('[data-lang-btn="en"]');
    if (b && !b.disabled) b.click();
  });
  await new Promise(r => setTimeout(r, 700));
  const enState = await dp.evaluate(() => {
    const cjk = /[\u4e00-\u9fff]/;
    const left = [];
    document.querySelectorAll(".demo-mount[data-ready]").forEach(m => {
      const w = document.createTreeWalker(m, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = w.nextNode())) {
        const s = n.nodeValue.replace(/\s+/g, " ").trim();
        if (!s || !cjk.test(s)) continue;
        if (n.parentElement.closest("pre, code, .console")) continue;
        left.push(s.slice(0, 40));
      }
    });
    return {
      locale: document.documentElement.getAttribute("data-locale"),
      left: left.slice(0, 5),
      nLeft: left.length,
      sample: (document.querySelector('.demo-mount[data-demo="d-3-1"]').innerText || "").replace(/\s+/g, " "),
    };
  });

  await dp.evaluate(() => document.querySelector('[data-lang-btn="zh"]').click());
  await new Promise(r => setTimeout(r, 500));
  const backZh = await dp.evaluate(() =>
    (document.querySelector('.demo-mount[data-demo="d-3-1"]').innerText || "").replace(/\s+/g, " "));

  const biOk = enState.locale === "en" && enState.nLeft === 0 &&
               /Converted data/.test(enState.sample) && !/转换后数据/.test(enState.sample);
  sideChecks += 1;
  if (biOk) sidePass += 1; else hardFail += 1;
  log((biOk ? "✅ " : "❌ ") + "切到英文后演示区没有中文解说  " +
      JSON.stringify({ locale: enState.locale, nLeft: enState.nLeft, left: enState.left,
                       head: enState.sample.slice(0, 60), zhHead: zhFirst.slice(0, 40) }));

  const backOk = /转换后数据/.test(backZh);
  sideChecks += 1;
  if (backOk) sidePass += 1; else hardFail += 1;
  log((backOk ? "✅ " : "❌ ") + "切回中文后演示区还原成原文  " +
      JSON.stringify({ head: backZh.slice(0, 40) }));

  // 两个原站 bug 的回归断言：有输出、无异常
  const reduceOk = /10/.test(reduceOut) && dpErrs.length === 0;
  sideChecks += 1;
  if (reduceOk) sidePass += 1; else hardFail += 1;
  log((reduceOk ? "✅ " : "❌ ") + "函数演示切到 reduce 有输出且不抛错  " +
      JSON.stringify({ has10: /10/.test(reduceOut), errs: dpErrs.slice(0, 3) }));
  await dp.close();
}

/* ------------------------------------------------------------ 投票卡的判定 */
/* 原站这句 `cc.classList.add(c.type === "correct" ? "wrong" : "")` 在投错票时
   给 classList 传空串，直接抛 DOMTokenList 异常 —— 表现是「点错了什么也不发生」。
   修好之后：投错只标错这一张，投对才把其余三张标错。 */
{
  const vp = await browser.newPage();
  await vp.setViewport({ width: 1440, height: 1000 });
  const vErrs = [];
  vp.on("pageerror", e => vErrs.push(e.message));
  await vp.goto(BASE + "/lesson-03/", { waitUntil: "networkidle2" });
  const vote = await vp.evaluate(async () => {
    const m = document.querySelector('.demo-mount[data-demo="d-3-6"]');
    window.WBLesson.runDemo(m);
    for (let i = 0; i < 25 && m.querySelectorAll(".quiz-card").length < 4; i++) {
      await new Promise(r => setTimeout(r, 150));
    }
    const cards = m.querySelectorAll(".quiz-card");
    // 第 2 张是「B：红绿对比」，属于错误方案
    cards[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise(r => setTimeout(r, 400));
    const wrongAfterWrong = m.querySelectorAll(".quiz-card.wrong").length;
    // 再投一次正确的（第 4 张 D：Wong）
    cards[3].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise(r => setTimeout(r, 400));
    return {
      wrongAfterWrong,
      correctAfterRight: m.querySelectorAll(".quiz-card.correct").length,
      wrongAfterRight: m.querySelectorAll(".quiz-card.wrong").length,
      hasResult: !!m.querySelector(".quiz-result"),
    };
  });
  const voteOk = vote.wrongAfterWrong === 1 && vote.correctAfterRight === 1 &&
                 vote.wrongAfterRight === 3 && vote.hasResult && vErrs.length === 0;
  sideChecks += 1;
  if (voteOk) sidePass += 1; else hardFail += 1;
  log((voteOk ? "✅ " : "❌ ") + "投票卡投错只标错一张、投对则其余标错  " +
      JSON.stringify({ ...vote, errs: vErrs.slice(0, 3) }));
  await vp.close();
}

/* ------------------------------------------------------------ 术语表的英文 */
/* 中文写满、英文只写半句的术语页，切到 EN 的读者拿到的是打折的内容，
   而页面上看不出任何异常。这里按「英文释义不短于中文」兜底。 */
{
  const gp = await browser.newPage();
  await gp.setViewport({ width: 1440, height: 1000 });
  await gp.evaluateOnNewDocument(() => {
    try { localStorage.setItem("wb.locale", "zh"); } catch (e) {}
  });
  await gp.goto(BASE + "/glossary.html", { waitUntil: "networkidle2" });
  const gl = await gp.evaluate(() => {
    const cards = [...document.querySelectorAll(".term-card")];
    const lens = cards.map(c => {
      const zh = c.querySelector('[data-lang="zh"].term-card__def, .term-card__def [data-lang="zh"], [data-lang="zh"].def');
      const en = c.querySelector('[data-lang="en"].term-card__def, .term-card__def [data-lang="en"], [data-lang="en"].def');
      return { zh: (zh ? zh.textContent : "").trim().length, en: (en ? en.textContent : "").trim().length };
    }).filter(x => x.zh > 0);
    return { n: cards.length, short: lens.filter(x => x.en < x.zh).length, min: lens.length ? Math.min(...lens.map(x => x.en)) : 0 };
  });
  await gp.evaluate(() => { const b = document.querySelector('[data-lang-btn="en"]'); if (b && !b.disabled) b.click(); });
  await new Promise(r => setTimeout(r, 400));
  const glEn = await gp.evaluate(() => {
    const visibleZh = [...document.querySelectorAll(".term-card [data-lang='zh']")]
      .filter(el => el.offsetParent !== null).length;
    const enDefs = [...document.querySelectorAll(".term-card [data-lang='en']")]
      .filter(el => el.offsetParent !== null).length;
    return { visibleZh, enDefs };
  });
  const glOk = gl.n >= 25 && gl.short === 0 && glEn.visibleZh === 0 && glEn.enDefs >= 50;
  sideChecks += 1;
  if (glOk) sidePass += 1; else hardFail += 1;
  log((glOk ? "✅ " : "❌ ") + "术语表英文释义不比中文短、切 EN 后中文全部让位  " +
      JSON.stringify({ ...gl, ...glEn }));
  await gp.close();
}


/* ------------------------------------------------------------ 知识图谱 */
/* 图谱是懒加载的：滚进视口才动态 import d3，再跑力导向。所以这里必须先
   滚过去、等它装完，否则量到的是一块空 SVG ——「元素在但没画」正是这类
   检查最容易放过的情况。 */
log("\n" + "-".repeat(76));
log("知识图谱（装配 / 展开 / 详情 / 不越界）");
log("-".repeat(76));

let kgFail = 0;
try {
  await lpage.evaluate(() => document.getElementById("kg-app")?.scrollIntoView({ block: "center" }));
  await new Promise(r => setTimeout(r, 3200));

  const kgInit = await lpage.evaluate(() => {
    const kg = document.getElementById("kg-app");
    const nodes = [...kg.querySelectorAll("g.kg-node")];
    return {
      ready: kg.classList.contains("is-ready"),
      nodes: nodes.length,
      concepts: nodes.filter(n => n.classList.contains("kg-node--concept")).length,
      links: kg.querySelectorAll("g.kg-link").length,
      title: (kg.querySelector(".kg__panel-title")?.textContent || "").trim(),
      descLen: (kg.querySelector(".kg__panel-desc")?.textContent || "").trim().length,
      stats: [...kg.querySelectorAll(".kg__stats dd")].map(d => d.textContent),
      count: (kg.querySelector("[data-kg-count]")?.textContent || "").trim(),
    };
  });
  /* 默认就要展开一章：如果一张「知识图谱」打开只有五个章节方块，
     它还是课程目录。所以这里要求概念节点至少 4 颗已就位。 */
  const initOk = kgInit.ready && kgInit.nodes >= 10 && kgInit.concepts >= 4 &&
                 kgInit.links >= 8 && kgInit.title.length > 0 && kgInit.descLen > 20 &&
                 kgInit.stats.length === 4;
  if (!initOk) kgFail += 1;
  log((initOk ? "✅ " : "❌ ") + "装配完成且默认展开一章  " + JSON.stringify(kgInit));

  const kgClick = await lpage.evaluate(async () => {
    const kg = document.getElementById("kg-app");
    const before = (kg.querySelector(".kg__panel-title")?.textContent || "").trim();
    // 点一颗知识点（不是章节）：详情要跟着换，统计要从章级的 6 变成 1
    const target = [...kg.querySelectorAll("g.kg-node--concept")][1];
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise(r => setTimeout(r, 380));
    return {
      before,
      after: (kg.querySelector(".kg__panel-title")?.textContent || "").trim(),
      nodes: [...kg.querySelectorAll(".kg__stats dd")].map(d => d.textContent),
      crumb: (kg.querySelector("[data-kg-crumb]")?.textContent || "").trim(),
      href: kg.querySelector(".kg__panel-acts a")?.getAttribute("href") || "",
    };
  });
  const clickOk = kgClick.after && kgClick.after !== kgClick.before &&
                  kgClick.nodes[0] === "1" && /#ch-\d+-\d+$/.test(kgClick.href);
  if (!clickOk) kgFail += 1;
  log((clickOk ? "✅ " : "❌ ") + "点知识点换详情并给出小节锚点  " + JSON.stringify(kgClick));

  const kgAll = await lpage.evaluate(async () => {
    const kg = document.getElementById("kg-app");
    kg.querySelector("[data-kg-all]").click();
    await new Promise(r => setTimeout(r, 2600));
    const box = kg.querySelector(".kg__svg").getBoundingClientRect();
    const off = [...kg.querySelectorAll("g.kg-node")].filter(g => {
      const c = g.querySelector(".kg-node__dot").getBoundingClientRect();
      const cx = c.x + c.width / 2, cy = c.y + c.height / 2;
      return cx < box.left - 2 || cx > box.right + 2 || cy < box.top - 2 || cy > box.bottom + 2;
    }).length;
    const t = kg.querySelector(".kg-view")?.getAttribute("transform") || "";
    const k = (/scale\(([\d.]+)\)/.exec(t) || [])[1];
    return {
      nodes: kg.querySelectorAll("g.kg-node").length,
      off,
      k: k ? +k : 1,
      far: kg.querySelector(".kg-view")?.classList.contains("is-far") === true,
      labels: [...kg.querySelectorAll(".kg-node__label")]
        .filter(el => getComputedStyle(el).opacity !== "0").length,
    };
  });
  /* 全部展开时 32 个点必须都在画布内（fitView 生效），
     同时标签要让位给章节名 —— 32 个标签叠在一起等于没有标签。 */
  const allOk = kgAll.nodes >= 28 && kgAll.off === 0 && kgAll.far &&
                kgAll.labels > 0 && kgAll.labels <= 12 && kgAll.k >= 0.5;
  if (!allOk) kgFail += 1;
  log((allOk ? "✅ " : "❌ ") + "全部展开后不越界、标签自动让位  " + JSON.stringify(kgAll));
} catch (e) {
  kgFail += 1;
  log("❌ 知识图谱检查失败：" + String(e.message).split("\n")[0]);
}
if (kgFail) hardFail += 1;

if (lErr.length) { hardFail += 1; log("❌ 门户页异常：" + lErr.join(" | ")); }

/* ------------------------------------------------- 动效不得吃掉内容 */
/* 「进入视野才浮现」最容易出的两个事故：
   ① 跳到页尾时，中间的段落从来没和视口相交，IO 不会为它们触发 → 永久隐形；
   ② 打印时没有滚动这回事，没滚到的段落直接印成白纸。
   两条都量一下，别只测"动画看起来挺顺"。 */
log("\n" + "-".repeat(76));
log("动效（不应以任何方式影响内容可见性）");
log("-".repeat(76));

const apage = await browser.newPage();
const aErr = [];
apage.on("pageerror", e => aErr.push(String(e.message).split("\n")[0]));
await apage.setViewport({ width: 1440, height: 900 });
await apage.goto(BASE + "/lesson-03/", { waitUntil: "networkidle2" });
await new Promise(r => setTimeout(r, 700));

const beforeScroll = await apage.evaluate(() => {
  const items = [...document.querySelectorAll(".reveal")];
  const last = items[items.length - 1];
  return { total: items.length, lastOpacity: last ? getComputedStyle(last).opacity : "n/a" };
});

await apage.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" }));
await new Promise(r => setTimeout(r, 1200));
const afterJump = await apage.evaluate(() => ({
  hidden: document.querySelectorAll(".reveal:not(.is-in)").length,
  total: document.querySelectorAll(".reveal").length,
}));

// 重新加载后直接切打印媒体，避免上一步的滚动已经把它们放出来
await apage.goto(BASE + "/lesson-03/", { waitUntil: "networkidle2" });
await new Promise(r => setTimeout(r, 500));
await apage.emulateMediaType("print");
/* 等过渡走完：切媒体类型时 opacity 从 0 过渡到 1，立刻读会拿到 0.46 这种中间值。
   这个等待要留足 —— 脚本连跑十几个页面之后 CPU 是紧的，700ms 会偶发读不到 1，
   表现成「打印丢段落」的假警报（同一段单独跑永远是通过的）。 */
await new Promise(r => setTimeout(r, 1500));
const printCheck = await apage.evaluate(() => {
  const items = [...document.querySelectorAll(".reveal")];
  const hidden = items.filter(el => Number(getComputedStyle(el).opacity) < 0.99).length;
  return { total: items.length, hiddenInPrint: hidden };
});

const motionOk = beforeScroll.total > 0 && afterJump.hidden === 0 && printCheck.hiddenInPrint === 0;
if (!motionOk) hardFail += 1;
log((motionOk ? "✅ " : "❌ ") + "跳转滚动后无隐形段落 / 打印时全部可见  " +
    JSON.stringify({ ...beforeScroll, ...afterJump, ...printCheck }));
if (aErr.length) { hardFail += 1; log("❌ 动效页面异常：" + aErr.join(" | ")); }
await apage.close();

/* ------------------------------------------------- 窄屏 + 打印媒体回归 */
log("\n" + "-".repeat(76));
log("窄屏 (390×844) 与打印媒体");
log("-".repeat(76));

const mpage = await browser.newPage();
const mErr = [];
mpage.on("pageerror", e => mErr.push(String(e.message).split("\n")[0]));

/* 只量一个页面是不够的。第一版只量了 /lesson-01/，于是讲义页那个「表格往右多出 4px」
   的横向滚动条一直没被发现 —— 讲义页的版式和章节页不同（没有 tab、正文更长、
   表格更多），要逐类页面各量一次才算数。 */
const NARROW_PAGES = ["/", "/lesson-01/", "/lesson-02/", "/lesson-02/lecture.html", "/glossary.html", "/supplementary/"];
const NARROW_WIDTHS = [390, 360, 320];

const narrowBad = [];
for (const np of NARROW_PAGES) {
  for (const w of NARROW_WIDTHS) {
    await mpage.setViewport({ width: w, height: 844, isMobile: true, hasTouch: true });
    await mpage.goto(BASE + np, { waitUntil: "networkidle2" });
    await new Promise(r => setTimeout(r, 500));
    const r = await mpage.evaluate(() => {
      const de = document.documentElement;
      return {
        overflow: de.scrollWidth - de.clientWidth,
        // 概念图 / 知识图谱曾经在窄屏上要横向滚动才看得全，而横滚没有任何提示，
        // 读者看到头两个节点就以为图到此为止。容器内滚动量必须为 0。
        mapScroll: [...document.querySelectorAll("#kg, #concept-map, #paths")]
          .map(h => Math.round(h.scrollWidth - h.clientWidth)),
        culprit: (() => {
          // 找不到是谁撑出去的，等于没说 —— 顺手把最右边那个元素也带出来
          const vw = de.clientWidth;
          let worst = null;
          document.querySelectorAll("body *").forEach(el => {
            const b = el.getBoundingClientRect();
            if (!b.width || !b.height) return;
            if (getComputedStyle(el).position === "fixed") return;
            if (el.closest(".sidebar")) return;         // 收起的侧栏是负坐标，不算溢出
            if (b.right <= vw + 0.5) return;
            if (!worst || b.right > worst.right) {
              worst = { right: Math.round(b.right),
                        tag: el.tagName.toLowerCase() + "." + String(el.className || "").slice(0, 40) };
            }
          });
          return worst ? worst.tag + " 右边缘 " + worst.right : "";
        })(),
      };
    });
    if (r.overflow > 0) narrowBad.push(`${np}@${w} +${r.overflow}px (${r.culprit})`);
    if (r.mapScroll.some(v => v > 0)) {
      narrowBad.push(`${np}@${w} 关系图容器内横滚 ${r.mapScroll.join("/")}px`);
    }
  }
}

/* 阈值必须卡在 0。原来写 <= 4 是想容忍亚像素舍入，结果正好把上面那个真 bug
   （每边多 4px）一并容掉了 —— 有容差的断言等于没有断言。 */
if (narrowBad.length) { hardFail += 1; log("❌ 窄屏出现横向滚动  " + narrowBad.join(" | ")); }
else log("✅ 六类页面 × 三档窄屏无横向滚动（含关系图容器内不横滚）  " + NARROW_PAGES.length + "×" + NARROW_WIDTHS.length + " 组合");

/* 汉堡按钮与侧栏状态在章节页上验收 */
await mpage.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
await mpage.goto(BASE + "/lesson-01/", { waitUntil: "networkidle2" });
await new Promise(r => setTimeout(r, 700));

const narrow = await mpage.evaluate(() => {
  const toggle = document.querySelector("#sidebar-toggle");
  const tRect = toggle?.getBoundingClientRect();
  return {
    toggleBox: tRect ? Math.round(tRect.width) + "x" + Math.round(tRect.height) : "缺失",
    toggleVisible: !!tRect && tRect.width >= 38 && tRect.height >= 38,
    sidebarHidden: document.querySelector("#sidebar")?.getAttribute("data-open") !== "true",
  };
});
const narrowOk = narrow.toggleVisible && narrow.sidebarHidden;
if (!narrowOk) hardFail += 1;
log((narrowOk ? "✅ " : "❌ ") + "汉堡按钮可点 / 侧栏默认收起  " + JSON.stringify(narrow));

await mpage.emulateMediaType("print");
const printOk = await mpage.evaluate(() => {
  const panels = [...document.querySelectorAll("[data-panel]")];
  const hidden = panels.filter(p => getComputedStyle(p).display === "none").length;
  return { panels: panels.length, hidden };
});
const prOk = printOk.panels === 0 || printOk.hidden === 0;
if (!prOk) hardFail += 1;
log((prOk ? "✅ " : "❌ ") + "打印时三个 tab 全部展开（讲义可完整打印）  " + JSON.stringify(printOk));

if (mErr.length) { hardFail += 1; log("❌ 窄屏页面异常：" + mErr.join(" | ")); }

await browser.close();

/* ------------------------------------------------------------------ 汇总 */
log("\n" + "=".repeat(76));
const total = results.length;
const clean = results.filter(r => !r.errors.length && !r.failed.length && !r.domIssues.length).length;
const passN = interact.filter(i => i[1]).length + sidePass;
const allN = interact.length + sideChecks;
log(`页面 ${clean}/${total} 完全干净；交互与布局断言 ${passN}/${allN} 通过`);
if (hardFail) {
  log(`\n还有 ${hardFail} 处需要处理。`);
  process.exit(1);
}
log("\n✅ 全部通过。");
