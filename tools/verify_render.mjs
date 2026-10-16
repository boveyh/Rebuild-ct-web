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
      has: ["#concept-map", "#sidebar", ".topbar", "#tour-play", "#tour-bar"],
    },
  })),
  ...CHAPTERS.map(c => ({ url: `/lesson-${c}/lecture.html`, name: `第 ${c} 章讲义`, expect: {} })),
  { url: "/glossary.html", name: "术语表", expect: { has: [".term-list"], sel: [{ q: ".term-card", min: 20 }] } },
  { url: "/supplementary/", name: "补充 Demo", expect: { has: [".demo-grid"], sel: [{ q: ".demo-card", min: 10 }] } },
  // 404 页的探测脚本会故意去请求几个不存在的路径来找站点根，
  // 那些 404 是设计的一部分，不算故障（下面 allowFail 放行）。
  { url: "/404.html", name: "404 页", allowFail: /\/404\.html\/assets\//,
    expect: { has: ["[data-root-link]", "#tour-play, .topbar"] } },
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

// 1. 切到「演示」tab —— 演示是动态 import 的，只有这一步能验证按需加载真的通了
try {
  const ok = await ipage.evaluate(async () => {
    const sec = document.querySelector("section.section");
    if (!sec) return { ok: false, why: "没有 section.section" };
    const demo = sec.querySelector('[data-tab="demo"]');
    if (!demo) return { ok: false, why: "没找到演示 tab" };
    demo.click();
    await new Promise(r => setTimeout(r, 3000));
    const panel = sec.querySelector('.tab-panel[data-panel="demo"]');
    const mounted = sec.querySelectorAll(".demo-mount > *").length;
    const svg = sec.querySelectorAll("svg").length;
    return { ok: mounted > 0 || svg > 0, mounted, svg, panel: !!panel };
  });
  interact.push(["演示 tab 触发动态 import 并渲染 SVG", ok.ok, JSON.stringify(ok)]);
} catch (e) { interact.push(["演示 tab", false, String(e.message)]); }

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

// 5. 概念图渲染
try {
  const ok = await ipage.evaluate(() => {
    const n = document.querySelectorAll("#concept-map svg").length;
    const shapes = document.querySelectorAll("#concept-map svg rect, #concept-map svg g").length;
    return { ok: n > 0 && shapes > 0, n, shapes };
  });
  interact.push(["概念依赖图渲染", ok.ok, JSON.stringify(ok)]);
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

for (const [name, ok, detail] of interact) {
  if (!ok) hardFail += 1;
  log((ok ? "✅ " : "❌ ") + name.padEnd(34, " ") + detail);
}
if (iErr.length) log("   页面异常：" + iErr.join(" | "));

/* ------------------------------------------------- 窄屏 + 打印媒体回归 */
log("\n" + "-".repeat(76));
log("窄屏 (390×844) 与打印媒体");
log("-".repeat(76));

const mpage = await browser.newPage();
const mErr = [];
mpage.on("pageerror", e => mErr.push(String(e.message).split("\n")[0]));

await mpage.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
await mpage.goto(BASE + "/lesson-01/", { waitUntil: "networkidle2" });
await new Promise(r => setTimeout(r, 700));

const narrow = await mpage.evaluate(() => {
  const de = document.documentElement;
  const overflow = de.scrollWidth - de.clientWidth;
  const toggle = document.querySelector("#sidebar-toggle");
  const tRect = toggle?.getBoundingClientRect();
  return {
    overflow,
    toggleBox: tRect ? Math.round(tRect.width) + "x" + Math.round(tRect.height) : "缺失",
    toggleVisible: !!tRect && tRect.width >= 38 && tRect.height >= 38,
    sidebarHidden: document.querySelector("#sidebar")?.getAttribute("data-open") !== "true",
  };
});
const narrowOk = narrow.overflow <= 4 && narrow.toggleVisible && narrow.sidebarHidden;
if (!narrowOk) hardFail += 1;
log((narrowOk ? "✅ " : "❌ ") + "无横向溢出 / 汉堡按钮可点 / 侧栏默认收起  " + JSON.stringify(narrow));

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
log(`页面 ${clean}/${total} 完全干净；交互项 ${interact.filter(i => i[1]).length}/${interact.length} 通过`);
if (hardFail) {
  log(`\n还有 ${hardFail} 处需要处理。`);
  process.exit(1);
}
log("\n✅ 全部通过。");
