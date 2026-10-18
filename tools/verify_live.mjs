/**
 * 线上部署验证：确认 404 页在「子路径 + 深层缺失路径」下仍能正确加载样式与脚本。
 *
 * 为什么需要它：本地预览时站点根是 `/`，GitHub Pages 上是 `/<仓库名>/`。
 * 404 页的「站点根探测」只在真实部署下才可能出错，本地怎么测都测不出来。
 * 这个脚本就是抓到该问题的那一次 —— 当时回站链接都改对了，但 favicon 与
 * CSS/JS 全部按缺失路径去请求（页面上写的 assets/css/tokens.css 被解析成
 * /a/b/c/assets/css/tokens.css），结果是一张没有样式的裸页。
 *
 * 用法：
 *   node tools/verify_live.mjs
 *   BASE=https://user.github.io/repo/ node tools/verify_live.mjs
 *   PROXY=http://127.0.0.1:7890 node tools/verify_live.mjs   # 需要走代理时
 *
 * 退出码：0 全通过 / 1 有断言失败 / 2 环境不满足
 */

import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const puppeteer = require("puppeteer-core");

const BASE = (process.env.BASE || "https://boveyh.github.io/Rebuild-ct-web/").replace(/\/+$/, "") + "/";
const PROXY = process.env.PROXY || "";

const CHROME_CANDIDATES = [
  process.env.CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].filter(Boolean);

const chrome = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!chrome) {
  console.error("找不到 Chrome / Edge，可用 CHROME=<可执行文件路径> 指定");
  process.exit(2);
}

// 故意挑一个「多层深路径」，让相对地址解析错得最明显
const MISSING = BASE + "does-not-exist/deep/path/";

const args = ["--no-sandbox"];
if (PROXY) args.push(`--proxy-server=${PROXY}`);

const browser = await puppeteer.launch({ executablePath: chrome, headless: "new", args });
const page = await browser.newPage();

const uncaught = [];
page.on("pageerror", (e) => uncaught.push(e.message));

const resp = await page.goto(MISSING, { waitUntil: "networkidle2", timeout: 45000 });

const probe = await page.evaluate(() => {
  const abs = (u) => {
    try { return new URL(u, document.baseURI).href; } catch { return null; }
  };
  const sheets = [...document.querySelectorAll("link[rel=stylesheet]")];
  const scripts = [...document.querySelectorAll("script[src]")];
  return {
    title: document.title,
    baseHref: document.baseURI,
    hasBaseTag: !!document.querySelector("base"),
    // 样式表是否真的装上了：能读到 cssRules 才算加载成功（跨域会抛，这里同源）
    cssLoaded: sheets.filter((l) => {
      try { return [...document.styleSheets].some((s) => s.href === l.href && s.cssRules.length > 0); }
      catch { return false; }
    }).length,
    cssTotal: sheets.length,
    cssHrefs: sheets.map((l) => abs(l.getAttribute("href"))),
    jsHrefs: scripts.map((s) => abs(s.getAttribute("src"))),
    favicon: abs(document.querySelector('link[rel="icon"]')?.getAttribute("href") || ""),
    bodyFont: getComputedStyle(document.body).fontFamily,
    // 用 .href 这个 property 取解析后的绝对地址；getAttribute 拿到的是原始值，
    // 站点里写的是 "/Rebuild-ct-web/…" 这种绝对路径，拿它去和完整 URL 比会误报。
    rootLinks: [...document.querySelectorAll("[data-root-link]")].map((el) => el.href),
    // "#main" 这类片段链接必须留在当前文档，不能被 <base> 带去站点根
    fragLinks: [...document.querySelectorAll('a[href*="#"]')]
      .map((a) => a.getAttribute("href"))
      .filter((h) => h && h.includes("#")),
  };
});

/* --------------------------------- 首页：样式与布局 --------------------------------- */
/* 加这一段的来由，和上面 404 页是同一类问题：门户页曾漏引 portal.css，首页塌成
   一列纯文字。它不报 404（页面根本没请求这个文件）、不报错、元素也都在，所以
   「探测资源能不能取到」查不出它 —— 得直接量「排开了几列」才算数。 */
const home = await browser.newPage();
const homeErr = [];
home.on("pageerror", (e) => homeErr.push(e.message));

// 必须显式设视口：puppeteer 默认 800×600，那个宽度下章节网格本来就只排 2 列
await home.setViewport({ width: 1440, height: 900 });
await home.goto(BASE, { waitUntil: "networkidle2", timeout: 45000 });
await new Promise((r) => setTimeout(r, 600));

const homeProbe = await home.evaluate(() => {
  const sheets = [...document.querySelectorAll("link[rel=stylesheet]")];
  // 数一个容器里出现了多少个互不相同的左边界 = 它实际排成了几列
  const cols = (sel) => {
    const host = document.querySelector(sel);
    if (!host) return 0;
    const xs = [...host.children]
      .filter((el) => {
        const s = getComputedStyle(el);
        return s.display !== "none" && s.position !== "absolute";
      })
      .map((el) => Math.round(el.getBoundingClientRect().left));
    return new Set(xs).size;
  };
  return {
    cssLoaded: sheets.filter((l) => {
      try {
        return [...document.styleSheets].some((s) => s.href === l.href && s.cssRules.length > 0);
      } catch {
        return false;
      }
    }).length,
    cssTotal: sheets.length,
    cssNames: sheets.map((l) => (l.getAttribute("href") || "").split("/").pop()).join(","),
    chapterCols: cols(".chapter-grid"),
    statsCols: cols(".portal-stats"),
    motifs: document.querySelectorAll(".chapter-card__motif").length,
  };
});

/* --------------------------------- 章节页：演示真的能渲染 --------------------------------- */
/* 再加一段的理由还是同一类：页面不报错、不 404、元素都在，但演示区一片「加载失败」。
   演示模块是动态 import 的，路径拼错或模块解析失败都只在真正点开时才暴露，
   而「资源可达性」探测完全看不见。所以这里真的点一遍、等它渲染。 */
const demoProbe = [];
for (const cid of ["01", "02", "03", "04", "05"]) {
  const dp = await browser.newPage();
  const bad = [];
  dp.on("response", (r) => {
    if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`);
  });
  try {
    await dp.goto(`${BASE}lesson-${cid}/`, { waitUntil: "networkidle2", timeout: 45000 });
    const res = await dp.evaluate(async () => {
      document.querySelectorAll('button[data-tab="demo"]').forEach((b) => b.click());
      // 轮询到全部就绪（或明确报错）为止，不用固定 sleep：演示要等 d3 从 CDN
      // 下载、有的还要再取 CSV，固定等 3.5 秒在慢网络下会误报成「没渲染」。
      // 条件里必须带上「已经画出东西」：data-ready 是在调用演示函数之前就置位的，
      // 而第 2 章的演示是 async 的（先 await d3.csv 再写 DOM），只看 ready 会在
      // 内容还没落地时就判定完成，于是误报「空挂载点」。
      const deadline = Date.now() + 30000;
      let mounts = [...document.querySelectorAll(".demo-mount[data-demo]")];
      while (Date.now() < deadline) {
        mounts = [...document.querySelectorAll(".demo-mount[data-demo]")];
        const done = mounts.filter(
          (m) =>
            m.getAttribute("data-state") === "error" ||
            (m.getAttribute("data-ready") === "1" && m.children.length > 0)
        );
        if (mounts.length > 0 && done.length === mounts.length) break;
        await new Promise((r) => setTimeout(r, 300));
      }
      return {
        mounts: mounts.length,
        ready: mounts.filter((m) => m.getAttribute("data-ready") === "1").length,
        empty: mounts.filter((m) => m.children.length === 0).map((m) => m.dataset.demo),
        pending: mounts
          .filter((m) => m.getAttribute("data-ready") !== "1")
          .map((m) => `${m.dataset.demo}:${m.getAttribute("data-state") || "-"}`),
        legacy: document.querySelectorAll(".demo-mount:not([data-demo])").length,
      };
    });
    demoProbe.push({ cid, ...res, bad: bad.slice(0, 2) });
  } catch (e) {
    demoProbe.push({ cid, error: String(e.message).slice(0, 120) });
  }
  await dp.close();
}

await browser.close();

const checks = [];
const push = (ok, label, detail) => checks.push({ ok, label, detail });

// 1) 缺失路径应当返回 404，且落到我们自己的 404 页
push(resp.status() === 404, "缺失路径返回 404", "HTTP " + resp.status());
push(probe.title.includes("页面不存在"), "加载的是自定义 404 页", probe.title);

// 2) 站点根探测是否生效
push(probe.hasBaseTag, "写入了 <base>", probe.baseHref);
push(probe.baseHref.startsWith(BASE), "站点根探测正确", `${probe.baseHref}  <- 期望 ${BASE}`);

// 3) 关键：样式与脚本必须都在站点根之下（这正是当初漏掉的一点）
const under = (u) => typeof u === "string" && u.startsWith(BASE);
const cssBad = probe.cssHrefs.filter((u) => !under(u));
const jsBad = probe.jsHrefs.filter((u) => !under(u));
push(probe.cssTotal > 0 && cssBad.length === 0, "CSS 路径全部落到站点根", cssBad.join(", ") || `${probe.cssTotal} 个`);
push(jsBad.length === 0, "JS 路径全部落到站点根", jsBad.join(", ") || `${probe.jsHrefs.length} 个`);
push(under(probe.favicon), "favicon 路径落到站点根", probe.favicon);
push(probe.cssLoaded === probe.cssTotal && probe.cssTotal > 0,
     "样式表真的加载成功", `${probe.cssLoaded}/${probe.cssTotal}`);

// 4) 回站链接与片段链接
const linkBad = probe.rootLinks.filter((u) => !under(u));
push(probe.rootLinks.length > 0 && linkBad.length === 0, "回站链接全部落到站点根",
     linkBad.join(", ") || `${probe.rootLinks.length} 个`);
const fragOk = probe.fragLinks.every((h) => h.startsWith(MISSING.split("#")[0]));
push(fragOk, "片段链接仍指向当前文档", probe.fragLinks.join(", ") || "（无）");

push(uncaught.length === 0, "无未捕获异常", uncaught.join(" | ") || "0 个");

// 5) 首页：样式真的装上、栅格真的排开
push(homeProbe.cssLoaded === homeProbe.cssTotal && homeProbe.cssTotal > 0,
     "首页样式表全部加载", `${homeProbe.cssLoaded}/${homeProbe.cssTotal}  ${homeProbe.cssNames}`);
push(homeProbe.cssNames.includes("portal.css"), "portal.css 已被引用", homeProbe.cssNames);
push(homeProbe.chapterCols >= 3, "首页章节网格排开了", `${homeProbe.chapterCols} 列`);
push(homeProbe.statsCols >= 5, "首页统计条排开了", `${homeProbe.statsCols} 列`);
push(homeProbe.motifs === 5, "5 枚章节微缩图都在", `${homeProbe.motifs} 枚`);
push(homeErr.length === 0, "首页无未捕获异常", homeErr.join(" | ") || "0 个");

// 6) 章节页演示：5 章逐个点开，必须全部 ready、无空框、无残留占位
const demoTotal = demoProbe.reduce((n, d) => n + (d.mounts || 0), 0);
const demoReady = demoProbe.reduce((n, d) => n + (d.ready || 0), 0);
const demoEmpty = demoProbe.flatMap((d) => d.empty || []);
const demoBad = demoProbe.flatMap((d) => d.bad || []);
const demoLegacy = demoProbe.reduce((n, d) => n + (d.legacy || 0), 0);
const demoErr = demoProbe.filter((d) => d.error).map((d) => `ch${d.cid}: ${d.error}`);
const demoPending = demoProbe.flatMap((d) => (d.pending || []).map((p) => `ch${d.cid}/${p}`));
push(demoErr.length === 0 && demoTotal > 0 && demoReady === demoTotal,
     "5 章演示全部渲染",
     demoErr[0] || (demoPending.length ? demoPending.join(", ") : `${demoReady}/${demoTotal} 个挂载点 ready`));
push(demoEmpty.length === 0, "没有空挂载点", demoEmpty.join(", ") || "0 个");
push(demoLegacy === 0, "没有遗留占位块", `${demoLegacy} 个`);
push(demoBad.length === 0, "演示无失败请求", demoBad.join(" | ") || "0 个");

// 输出
console.log("=".repeat(70));
console.log("线上部署验证");
console.log("=".repeat(70));
console.log("404 探测  " + MISSING);
console.log("首页探测  " + BASE);
console.log("浏览器    " + chrome);
if (PROXY) console.log("代理      " + PROXY);
console.log();

for (const c of checks) {
  console.log(`  ${c.ok ? "✅" : "❌"} ${c.label.padEnd(22, "　")} ${c.detail}`);
}

const failed = checks.filter((c) => !c.ok);
console.log();
console.log(failed.length === 0
  ? `✅ ${checks.length}/${checks.length} 全部通过 —— 子路径部署下 404 页正常`
  : `❌ ${failed.length}/${checks.length} 项失败`);

process.exit(failed.length === 0 ? 0 : 1);
