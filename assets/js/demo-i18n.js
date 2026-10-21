/* ============================================================================
   demo-i18n.js —— 演示区双语层
   ----------------------------------------------------------------------------
   演示模块（assets/js/demos/ch0X.js）是 build.py 从原站快照里**抽取**出来的，
   每次构建都会重写，所以译文不能改在演示代码里。这里换个思路：
   演示照原样渲染中文，脚本把「渲染出来的中文文本」按词典换成英文，
   切回中文时再从 WeakMap 里还原。

   为什么不用 data-lang 双 DOM 方案：演示里有大量 d3 的 .text() 和 SVG <text>，
   往里面塞 <span> 是非法的；而且演示是运行时才生成的，构建期无法预知节点。
   文本节点替换对 HTML / SVG / textContent 都成立，也不改演示代码。

   词典来源：tools/data/demo-i18n.json（build.py 生成 assets/js/demos/i18n.js）。
   数字会先抹成占位符再匹配，所以「阈值：0.42」这种动态值也能命中。
   ========================================================================= */

const CJK = /[\u4e00-\u9fff]/;
const NUM = /\d+(?:[.,]\d+)?/g;
const PH = "\u0000";

let dict = null;        // 原始词典 zh -> en
let prefixRules = [];   // 「答案：+ 动态名称」这类前缀
let maskedIndex = null; // 抹掉数字后的键 -> [enTemplate, 数字占位位置]
let loading = null;     // 词典加载中的 Promise
const originals = new WeakMap(); // text node / element -> {orig, last}
const attrOriginals = [];        // [{el, attr, value}]
const missed = new Set();        // 没命中的文本，供校验脚本读取

function norm(s) {
  return s.replace(/\s+/g, " ").trim();
}

function mask(s) {
  return s.replace(NUM, PH);
}

function buildIndex() {
  maskedIndex = Object.create(null);
  for (const zh in dict) {
    // 建索引时也要先折叠空白：查询侧是 norm 过的，
    // 词典里「a  →  b」这种双空格的键若不归一，就永远匹配不上（踩过一次）。
    const key = mask(norm(zh));
    if (!(key in maskedIndex)) maskedIndex[key] = [];
    maskedIndex[key].push(zh);
  }
}

function load() {
  if (dict) return Promise.resolve(dict);
  if (loading) return loading;
  loading = import("./demos/i18n.js").then(function (m) {
    dict = (m && m.default) || {};
    prefixRules = Object.keys((m && m.prefixes) || {})
      .sort(function (a, b) { return b.length - a.length; })
      .map(function (k) { return [k, m.prefixes[k]]; });
    buildIndex();
    return dict;
  }).catch(function (err) {
    if (window.console) console.warn("[demo-i18n] 词典加载失败", err);
    dict = {};
    buildIndex();
    return dict;
  });
  return loading;
}

// 返回译文；匹配不到返回 null
function lookupRaw(key) {
  if (!key) return null;
  if (dict[key]) return dict[key];

  // 动态数值：把键里的数字抹成占位符后比对，命中的话把数字按顺序填回去
  const list = maskedIndex[mask(key)];
  if (!list) return null;
  for (const zh of list) {
    const digits = key.match(NUM);
    const enDigits = dict[zh].match(NUM);
    if (!digits || !enDigits || digits.length !== enDigits.length) continue;
    let i = 0;
    return dict[zh].replace(NUM, function () { return digits[i++]; });
  }
  return null;
}

const DECOR = /^[\s—–\-·•*>›]+/;

function lookup(text) {
  const key = norm(text);
  if (!key) return null;
  let hit = lookupRaw(key);
  if (hit !== null) return hit;

  // 「—— 按班级聚合（每班人数）」这类前缀装饰不在词典里，剥掉再查
  const stripped = key.replace(DECOR, "");
  if (stripped !== key) {
    hit = lookupRaw(stripped);
    if (hit !== null) return hit;
  }

  // 树节点与分组标签爱把计数拼在名称后面（「软件工程 (40)」），
  // 单独为每种计数建词条不现实，翻名称、保留后缀。
  const m = key.match(/^(.+?)\s*[（(](\d+)[）)]$/);
  if (m) {
    const head = lookupRaw(m[1]);
    if (head !== null) return head + " (" + m[2] + ")";
  }

  // 「↗ 有序性」这类带图标前缀的小标题：剥掉前面的符号再查，查到了把符号接回去。
  const sym = key.match(/^([^\p{L}\p{N}]+)(.+)$/u);
  if (sym) {
    const rest = lookupRaw(sym[2]);
    if (rest !== null) return sym[1] + rest;
  }

  // 「答案：A：彩虹谱 Jet」这类前缀 + 动态内容：翻前缀，剩下部分再查一次
  for (const rule of prefixRules) {
    if (!key.startsWith(rule[0])) continue;
    const rest = key.slice(rule[0].length).trim();
    const tail = rest ? lookupRaw(rest) : null;
    if (rest && tail === null) {
      // 剩下那半截没词条就整串不翻，避免译出来一半中文一半英文
      if (CJK.test(rest)) continue;
    }
    return rule[1] + (tail !== null ? tail : rest);
  }
  return null;
}

// 记原文。演示会反复改写同一个节点（控制台用 textContent += 追加日志），
// 所以不能只存第一次的原文 —— 存「上次写进去的译文」，下次发现节点被演示
// 改过（当前值 ≠ 上次译文）就刷新原文，切回中文才不会拿到过期的那一版。
function remember(node, raw, next) {
  const prev = originals.get(node);
  if (!prev) originals.set(node, { orig: raw, last: next });
  else {
    if (prev.last !== raw) prev.orig = raw;
    prev.last = next;
  }
}

function applyText(node) {
  const raw = node.nodeValue;
  if (!CJK.test(raw)) return;

  // 多行文本（控制台输出、代码块）：先整块试一次 —— 模板串里为了排版
  // 换行、但整段其实是一句话的情况很常见；整块命不中再逐行翻。
  // 逐行翻时命不中的行原样留着，所以代码里的中文注释、数据 JSON 不会被误伤。
  if (/\n/.test(raw)) {
    const whole = lookup(raw);
    if (whole !== null) {
      const next = /\s$/.test(raw) ? whole + raw.match(/\s*$/)[0] : whole;
      if (node.nodeValue !== next) {
        remember(node, raw, next);
        node.nodeValue = next;
      }
      return;
    }
    let changed = false;
    const next = raw.split("\n").map(function (line) {
      if (!CJK.test(line)) return line;
      const hit = lookup(line);
      if (hit === null) return line;
      changed = true;
      return line.replace(line.trim(), hit);
    }).join("\n");
    if (changed && node.nodeValue !== next) {
      remember(node, raw, next);
      node.nodeValue = next;
    }
    return;
  }

  const hit = lookup(raw);
  if (hit === null) {
    if (norm(raw)) missed.add(norm(raw));
    return;
  }
  const lead = (raw.match(/^\s*/) || [""])[0];
  const tail = (raw.match(/\s*$/) || [""])[0];
  const next = lead + hit + tail;
  if (node.nodeValue !== next) {
    remember(node, raw, next);
    node.nodeValue = next;
  }
}

function applyAttrs(root) {
  const sel = "[title], [aria-label], [alt], [placeholder]";
  const list = root.querySelectorAll ? root.querySelectorAll(sel) : [];
  for (const el of list) {
    for (const attr of ["title", "aria-label", "alt", "placeholder"]) {
      const v = el.getAttribute(attr);
      if (!v || !CJK.test(v)) continue;
      const hit = lookup(v);
      if (hit === null) continue;
      if (!el.__wbI18n) el.__wbI18n = {};
      if (!(attr in el.__wbI18n)) {
        el.__wbI18n[attr] = v;
        attrOriginals.push({ el: el, attr: attr, value: v });
      }
      if (v !== hit) el.setAttribute(attr, hit);
    }
  }
}

export function applyTo(root) {
  if (!root) return Promise.resolve();
  return load().then(function () {
    if (!dict) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const batch = [];
    let n;
    while ((n = walker.nextNode())) batch.push(n);
    // 先收集再改：TreeWalker 边改边遍历在部分浏览器上会漏节点
    batch.forEach(applyText);
    applyAttrs(root);
  });
}

export function restore(root) {
  if (!root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  const batch = [];
  let n;
  while ((n = walker.nextNode())) batch.push(n);
  batch.forEach(function (node) {
    const it = originals.get(node);
    if (it) node.nodeValue = it.orig;
  });
  for (let i = attrOriginals.length - 1; i >= 0; i--) {
    const it = attrOriginals[i];
    if (!root.contains(it.el)) continue;
    it.el.setAttribute(it.attr, it.value);
    if (it.el.__wbI18n) delete it.el.__wbI18n[it.attr];
    attrOriginals.splice(i, 1);
  }
}

const timers = new WeakMap();

// 演示会在 hover / 拖滑块 / resize 后重画，重画出来的新节点也要跟着翻
export function observe(root) {
  if (!root || root.__wbI18nObserved) return;
  root.__wbI18nObserved = true;
  const mo = new MutationObserver(function () {
    if (document.documentElement.getAttribute("data-locale") !== "en") return;
    clearTimeout(timers.get(root));
    timers.set(root, setTimeout(function () { applyTo(root); }, 60));
  });
  mo.observe(root, { childList: true, subtree: true, characterData: true });
}

export function setLocale(lang) {
  const mounts = document.querySelectorAll(".demo-mount[data-ready]");
  mounts.forEach(function (m) {
    if (lang === "en") applyTo(m);
    else restore(m);
  });
}

// 校验脚本用：读走并清空未命中的文本
export function takeMisses() {
  const out = Array.from(missed);
  missed.clear();
  return out;
}

if (typeof window !== "undefined") {
  window.WBDemoI18n = { applyTo: applyTo, restore: restore, observe: observe, setLocale: setLocale, takeMisses: takeMisses, lookup: lookup };
}
