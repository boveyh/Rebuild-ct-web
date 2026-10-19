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
      return {
        mounts: mounts.length,
        ready: mounts.filter(m => m.getAttribute("data-ready") === "1").length,
        empty: mounts.filter(m => m.children.length === 0).map(m => m.dataset.demo),
        svg: mounts.reduce((n, m) => n + m.querySelectorAll("svg").length, 0),
        state: mounts.map(m => m.getAttribute("data-state") || "-").join(","),
      };
    });
    const ok = res.mounts > 0 && res.ready === res.mounts && res.empty.length === 0 && fails.length === 0;
    interact.push([
      `第 ${cid} 章演示全部渲染（${res.mounts} 个）`,
      ok,
      JSON.stringify({ ...res, fails: fails.slice(0, 3) }),
    ]);
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
  const box = await gp.evaluate(() => {
    const g = document.querySelector("#concept-map g.cm-node");
    const r = g.getBoundingClientRect();
    // 记住 id：拖动时节点会被提到最上层，DOM 顺序会变，不能靠「第一个 g」找它
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, id: g.dataset.node };
  });
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

/*    学习路径：门户上三条路线要真的排开、每个步骤都要落到存在的章节页。
    只数 .route 的个数会被"有容器没内容"骗过去，所以同时检查步数与链接。 */
try {
  await ipage.goto(BASE + "/", { waitUntil: "networkidle2", timeout: 30000 });
  const routes = await ipage.evaluate(() => {
    const links = [...document.querySelectorAll(".route__link")].map(a => a.getAttribute("href"));
    const cols = new Set([...document.querySelectorAll(".route")].map(r => Math.round(r.getBoundingClientRect().left)));
    return {
      routes: document.querySelectorAll(".route").length,
      steps: links.length,
      cols: cols.size,
      linksOk: links.every(h => /^lesson-0[1-5]\/$/.test(h)),
      art: !!document.querySelector(".portal-hero__art"),
    };
  });
  interact.push([
    "门户三条学习路径排开且链接有效",
    routes.routes === 3 && routes.steps === 11 && routes.cols === 3 && routes.linksOk,
    JSON.stringify(routes),
  ]);
} catch (e) { interact.push(["学习路径", false, String(e.message)]); }

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
  const rmNodes = [...document.querySelectorAll("#roadmap svg g")];
  const rmCols = [...new Set(rmNodes.map(g => Math.round(g.getBoundingClientRect().left)))];
  return {
    chapterGrid: columns(".chapter-grid"),
    stats: columns(".portal-stats"),
    howto: columns(".howto-grid"),
    motifs: document.querySelectorAll(".chapter-card__motif").length,
    motifShapes: document.querySelectorAll(
      ".chapter-card__motif rect, .chapter-card__motif circle, .chapter-card__motif path"
    ).length,
    motifBox: r ? Math.round(r.width) + "x" + Math.round(r.height) : "缺失",
    roadmapCols: rmCols.length,
    roadmapNodes: rmNodes.length,
  };
});

const layoutOk =
  layout.chapterGrid.cols >= 3 &&
  // 统计条从 5 项减到 4 项（去掉了「预计总时长」），阈值跟着降到 4
  layout.stats.cols >= 4 &&
  layout.howto.cols >= 4 &&
  layout.motifs === 5 &&
  layout.motifShapes >= 20;
if (!layoutOk) hardFail += 1;
log((layoutOk ? "✅ " : "❌ ") + "章节网格 / 统计条 / 使用说明真的排开了  " + JSON.stringify(layout));

/* 主线图曾经是「一章一列」——五章排成一条直线，读者会以为必须按顺序一路学完，
   而 03/04/05 其实是挂在 02 下面的并列支线。这里只要「列数少于节点数」就能
   抓住退化成直线的情况，不必把 3 这个数字写死（章节数将来可能变）。 */
const roadmapOk = layout.roadmapNodes >= 3 && layout.roadmapCols >= 2 &&
                  layout.roadmapCols < layout.roadmapNodes;
if (!roadmapOk) hardFail += 1;
log((roadmapOk ? "✅ " : "❌ ") + "课程主线按依赖分层（不是一章一列）  " +
    JSON.stringify({ cols: layout.roadmapCols, nodes: layout.roadmapNodes }));

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
// 等过渡走完：切媒体类型时 opacity 从 0 过渡到 1，立刻读会拿到 0.46 这种中间值
await new Promise(r => setTimeout(r, 700));
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
        // 概念图 / 主线图曾经在窄屏上要横向滚动才看得全，而横滚没有任何提示，
        // 读者看到头两个节点就以为图到此为止。容器内滚动量必须为 0。
        mapScroll: [...document.querySelectorAll("#roadmap, #concept-map")]
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
log(`页面 ${clean}/${total} 完全干净；交互项 ${interact.filter(i => i[1]).length}/${interact.length} 通过`);
if (hardFail) {
  log(`\n还有 ${hardFail} 处需要处理。`);
  process.exit(1);
}
log("\n✅ 全部通过。");
