#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build.py —— 课程网站内容管道
==============================================================================

为什么要有这一步
------------------------------------------------------------------------
原站是 5 个 40–90 KB 的手写 HTML，里面混着三类东西：

  1. 正文内容          作者的劳动成果，必须一字不改地保留
  2. 页面编辑器残留    550+ 个 data-page-node-id、3 处重复属性
  3. 每页各自一套的外壳  顶栏 / 侧栏 / tab / 分页，重复了 5 遍，且已经互相漂移

手工改这 30 万字符既慢又必然引入漏改。所以把「内容」和「外壳」分开：
本脚本从 tools/origin/ 下抓来的原站快照里**只抽取内容**，
再用统一的外壳模板重新装配，输出到站点根目录。

这样做的三个好处：
  · 内容零改写 —— 原作者写的每一段讲解、每一个 ⭐ 关键点都原样保留；
  · 外壳只有一份 —— 改导航 / 改配色 / 加深色模式只改一处；
  · 可复现、可 diff —— 重跑一次就得到同样的结果，改了什么一目了然。

用法
------------------------------------------------------------------------
    python tools/build.py            # 构建全站
    python tools/build.py --check    # 只做一致性检查，不写文件
"""

import json
import os
import re
import struct
import sys
from html import escape as html_escape
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ORIGIN = ROOT / "tools" / "origin"
DATA = ROOT / "tools" / "data"

# 站点对外地址。canonical / og:url 要用绝对地址，而构建时并不联网，
# 只能从配置里取。换部署位置时改这一处，或用环境变量覆盖。
# 注意 GitHub Pages 是子路径部署，末尾不要带斜杠。
SITE_URL = (
    os.environ.get("WB_SITE_URL")
    or "https://boveyh.github.io/Rebuild-ct-web"
).rstrip("/")

CHECK_ONLY = "--check" in sys.argv

# ============================================================ 基础工具

def read(p):
    return Path(p).read_text(encoding="utf-8")


def write(p, s):
    p = Path(p)
    if CHECK_ONLY:
        print(f"  [check] 将写入 {p.relative_to(ROOT)}  ({len(s.encode('utf-8'))} B)")
        return
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(s, encoding="utf-8")


RE_NODE_ID = re.compile(r'\s*data-page-node-id="[^"]*"')
RE_DUP_ATTR = re.compile(r'(\s[\w:-]+="[^"]*")(?:\1)+')
RE_BLANK = re.compile(r"\n[ \t]*\n[ \t]*\n+")


def clean_html(s: str) -> str:
    """剥掉页面编辑器残留，并把双语文档统一成 data-lang="zh" / "en"。"""
    s = RE_NODE_ID.sub("", s)
    s = RE_DUP_ATTR.sub(r"\1", s)
    # 统一语言标记（原站两种写法并存：data-lang 与 data-i18n）
    s = s.replace('data-lang="zh-CN"', 'data-lang="zh"')
    s = s.replace('data-lang="en-US"', 'data-lang="en"')
    # 语言显隐改由 CSS 负责，hidden 属性反而会和 shell.js 打架
    s = re.sub(r'(data-lang="(?:zh|en)")\s+hidden(?=[\s>])', r"\1", s)
    s = re.sub(r'hidden\s+(data-lang="(?:zh|en)")', r"\1", s)
    # 这几个 key 现在由外壳提供文案，留在正文里会覆盖不了还多一层耦合
    s = re.sub(
        r'\s*data-i18n="(?:tab\.(?:explain|code|demo)|common\.loading|common\.your-case)"',
        "", s,
    )
    # 原站用 ⭐ 同时当「装饰」和「语义标记」，这里让语义靠 class 承担
    s = RE_BLANK.sub("\n\n", s)
    s = re.sub(r"[ \t]+\n", "\n", s)
    return s.strip()


def indent(s: str, n: int) -> str:
    pad = " " * n
    return "\n".join(pad + line if line.strip() else line for line in s.split("\n"))


# ---------------------------------------------------- JS 感知的括号匹配
def js_match_brace(src: str, open_idx: int) -> int:
    """返回与 src[open_idx]（'{'）匹配的 '}' 的下标。

    必须避开字符串、模板串、正则和注释里的花括号 —— 演示代码里
    这三类都大量出现，用朴素的正则一定会切错。
    """
    assert src[open_idx] == "{"
    i = open_idx
    depth = 0
    n = len(src)
    while i < n:
        c = src[i]
        nxt = src[i + 1] if i + 1 < n else ""
        if c == "/" and nxt == "/":
            j = src.find("\n", i)
            i = n if j < 0 else j
            continue
        if c == "/" and nxt == "*":
            j = src.find("*/", i + 2)
            i = n if j < 0 else j + 2
            continue
        if c in "'\"`":
            quote = c
            i += 1
            while i < n:
                if src[i] == "\\":
                    i += 2
                    continue
                if src[i] == quote:
                    break
                # 模板串里的 ${ } 需要递归跳过
                if quote == "`" and src[i] == "$" and i + 1 < n and src[i + 1] == "{":
                    end = js_match_brace(src, i + 1)
                    i = end + 1
                    continue
                i += 1
            i += 1
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    raise ValueError("unbalanced braces")


def strip_js_functions(src: str, names) -> str:
    """删掉指定的顶层 function 声明（含其函数体）。"""
    for name in names:
        pat = re.compile(r"^function\s+" + re.escape(name) + r"\s*\([^)]*\)\s*\{", re.M)
        while True:
            m = pat.search(src)
            if not m:
                break
            open_idx = src.index("{", m.end() - 1)
            close_idx = js_match_brace(src, open_idx)
            # 连同前面的空行一起吃掉
            start = m.start()
            while start > 0 and src[start - 1] in " \t":
                start -= 1
            src = src[:start] + src[close_idx + 1:]
    return src


# ============================================================ 载入数据

I18N = json.loads(read(ORIGIN / "i18n.json"))
ZH, EN = I18N["zh-CN"], I18N["en-US"]
META = json.loads(read(DATA / "chapters.json"))
SITE = META["site"]
CHAPTERS = META["chapters"]
GLOSSARY_TERMS = json.loads(read(DATA / "glossary.json"))["terms"]
QUIZ = json.loads(read(DATA / "quiz.json"))["chapters"]

RESOURCE_DIR = ROOT / "supplementary"


def t(pair, lang="zh"):
    if isinstance(pair, dict):
        return pair.get(lang) or pair.get("zh") or ""
    return pair or ""


def L(zh, en):
    """面包屑、翻页这类由 Python 拼出来的短标签，直接出双语文案。
    只传一个字符串的话，切到英文后这几个位置会突兀地留中文。"""
    return f'<span data-lang="zh">{zh}</span><span data-lang="en">{en}</span>'


# ============================================================ 正文抽取

RE_ARTICLE = re.compile(
    r'<article class="chapter[^"]*"[^>]*id="(?P<id>ch-\d+-\d+)"[^>]*>(?P<body>.*?)</article>',
    re.S,
)
RE_H2 = re.compile(r'<h2[^>]*data-i18n="(?P<key>sec-[\d-]+\.title)"[^>]*>(?P<text>.*?)</h2>', re.S)
RE_SUB = re.compile(r'<p class="chapter-subtitle"[^>]*data-lang="(?P<lang>zh|en)"[^>]*>(?P<text>.*?)</p>', re.S)
RE_PANEL_OPEN = re.compile(r'<div class="tab-panel[^"]*"\s*data-panel="(?P<name>explain|code|demo)"[^>]*>')


def find_matching_div(s: str, open_idx: int) -> int:
    """返回与 s[open_idx]（'<div'）匹配的 '</div>' 之后的下标。"""
    depth = 0
    i = open_idx
    pat = re.compile(r"<div\b|</div>")
    while True:
        m = pat.search(s, i)
        if not m:
            raise ValueError("unbalanced div")
        if m.group(0) == "</div>":
            depth -= 1
            if depth == 0:
                return m.end()
        else:
            depth += 1
        i = m.end()


def split_num(title: str):
    """'1.1 数据生成' → ('1.1', '数据生成')"""
    m = re.match(r"^\s*([\d]+(?:\.[\d]+)*)\s*[·.、]?\s*(.*)$", title)
    if m and m.group(2):
        return m.group(1), m.group(2)
    return "", title


RE_TAG = re.compile(r"<(/?)([a-zA-Z][\w-]*)([^>]*)>")
VOID_TAGS = {
    "br", "img", "input", "hr", "meta", "link", "source", "col", "area", "base",
    "embed", "param", "track", "wbr",
}


def count_stars(code_html: str) -> int:
    """数「必须掌握的编程点」。

    原作者统一用 ⭐ 标记关键点，但中英两版各有一份，直接全页计数会翻倍。
    这里做一个很小的标签扫描：维护一层「当前语言」栈，只在不在 en 子树里
    才计入。比起用正则去删 en 片段，这种方式不会被嵌套标签骗到。
    """
    count = 0
    stack = []          # 每个元素的语言（None 表示没写 data-lang，继承父级）
    pos = 0

    for m in RE_TAG.finditer(code_html):
        cur = stack[-1] if stack else None
        if cur != "en":
            count += code_html[pos:m.start()].count("⭐")
        pos = m.end()

        closing, tag, attrs = m.group(1), m.group(2).lower(), m.group(3)
        if tag in VOID_TAGS:
            continue
        if closing:
            if stack:
                stack.pop()
            continue
        if attrs.rstrip().endswith("/"):
            continue
        lm = re.search(r'data-lang="([a-z]+)"', attrs)
        inherited = stack[-1] if stack else None
        stack.append(lm.group(1) if lm else inherited)

    if not (stack and stack[-1] == "en"):
        count += code_html[pos:].count("⭐")
    return count


def extract_sections(html: str):
    """从一章的原站 HTML 里抽出全部小节。"""
    body_m = re.search(r'<section class="chapter-content"[^>]*>(?P<body>.*)', html, re.S)
    if not body_m:
        raise ValueError("找不到 chapter-content")
    body = body_m.group("body")

    sections = []
    for m in RE_ARTICLE.finditer(body):
        sid = m.group("id")
        art = m.group("body")

        h2 = RE_H2.search(art)
        # 正则里捕获的 key 已经是完整的 "sec-01-1.title"，不能再拼一次后缀 ——
        # 拼了就是 sec-01-1.title.title，两边都取不到，英文标题一直悄悄退回中文。
        key = h2.group("key") if h2 else None
        zh_title = ZH.get(key) if key else None
        en_title = EN.get(key) if key else None
        if not zh_title and h2:
            zh_title = re.sub(r"<[^>]+>", "", h2.group("text")).strip()
        if not en_title:
            en_title = zh_title

        subs = {}
        for sm in RE_SUB.finditer(art):
            subs[sm.group("lang")] = re.sub(r"<[^>]+>", "", sm.group("text")).strip()

        panels = {}
        for pm in RE_PANEL_OPEN.finditer(art):
            open_idx = art.rindex("<div", 0, pm.end())
            end_idx = find_matching_div(art, open_idx)
            inner = art[pm.end():end_idx]
            inner = inner.rsplit("</div>", 1)[0]
            panels[pm.group("name")] = clean_html(inner)

        demo_key = None
        dm = re.search(r'data-demo="([^"]+)"', art) or re.search(r'id="demo-mount-([^"]+)"', art)
        if dm:
            demo_key = dm.group(1)

        num, name_zh = split_num(zh_title)
        _, name_en = split_num(en_title)

        sections.append({
            "id": sid,
            "num": num,
            "title": {"zh": name_zh, "en": name_en},
            "full": {"zh": zh_title, "en": en_title},
            "subtitle": {"zh": subs.get("zh", ""), "en": subs.get("en", "")},
            "panels": panels,
            "demo": demo_key,
            "stars": count_stars(panels.get("code", "")),
        })
    return sections


# ============================================================ 图标

ICONS = {
    "explain": '<svg class="tab-btn__icon" viewBox="0 0 24 24" aria-hidden="true">'
               '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H10a2 2 0 0 1 2 2v13a2 2 0 0 0-2-2H5.5A1.5 1.5 0 0 1 4 15.5z"/>'
               '<path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H14a2 2 0 0 0-2 2v13a2 2 0 0 1 2-2h4.5A1.5 1.5 0 0 0 20 15.5z"/></svg>',
    "code": '<svg class="tab-btn__icon" viewBox="0 0 24 24" aria-hidden="true">'
            '<path d="M9 8l-4 4 4 4M15 8l4 4-4 4"/></svg>',
    "demo": '<svg class="tab-btn__icon" viewBox="0 0 24 24" aria-hidden="true">'
            '<circle cx="12" cy="12" r="9"/><path d="M10 8.5l6 3.5-6 3.5z"/></svg>',
    "check": '<svg class="sidebar__check" viewBox="0 0 24 24" aria-hidden="true" style="fill:none;stroke:currentColor;stroke-width:3">'
             '<path d="M4 12.5l5 5L20 6.5"/></svg>',
    "up": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
}

BRAND_MARK = '<span class="brand-mark" aria-hidden="true">' + "".join(
    "<i></i>" for _ in range(9)
) + "</span>"

TAB_LABEL = {"explain": "讲解", "code": "关键代码", "demo": "演示"}
TAB_LABEL_EN = {"explain": "Explain", "code": "Key code", "demo": "Demo"}


# ============================================================ 页面外壳片段

def head(title, desc, depth, extra_css=(), extra_js=(), theme_color="#3d4bc0",
         root_probe=False, path=""):
    """depth = 相对站点根目录的层级，'../' 或 ''

    root_probe=True 只有 404 页用：把「站点根探测」脚本插到 head 最前面，
    这样紧跟其后的 favicon / CSS / JS 这些相对地址才会按正确基准解析。

    path = 本站内该页的绝对路径（'/lesson-03/'、'/glossary.html'）。
    用来拼 canonical 与 og:url。传 None 表示不输出 canonical ——
    404 页就属于这种：它是个错误页，让搜索引擎收录反而添乱。
    """
    probe = (ROOT_SCRIPT + "\n") if root_probe else ""
    up = depth

    # 绝对地址类的元信息。之前只有一个 og:title / og:description，
    # 分享到群里没有缩略图也没有规范地址，搜索引擎只能自己猜哪一版是正文。
    url = f"{SITE_URL}{path}" if path is not None else ""
    canonical = f'\n  <link rel="canonical" href="{url}" />' if url else ""
    og_url = (f'\n  <meta property="og:url" content="{url}" />'
              f'\n  <meta property="og:site_name" content="《可视化导论》" />'
              f'\n  <meta property="og:image" content="{SITE_URL}/assets/og-cover.png" />'
              f'\n  <meta property="og:image:width" content="1200" />'
              f'\n  <meta property="og:image:height" content="630" />'
              f'\n  <meta property="og:locale" content="zh_CN" />'
              f'\n  <meta name="twitter:card" content="summary_large_image" />') if url else ""
    css = "\n".join(
        f'  <link rel="stylesheet" href="{up}assets/css/{n}.css" />'
        for n in ("tokens", "base", "shell", "content")
    )
    for n in extra_css:
        css += f'\n  <link rel="stylesheet" href="{up}assets/css/{n}.css" />'
    js = "\n".join(
        f'  <script type="module" src="{up}assets/js/{n}.js"></script>' for n in ("shell", "enhance")
    )
    for n in extra_js:
        js += f'\n  <script type="module" src="{up}assets/js/{n}.js"></script>'
    return f"""<!DOCTYPE html>
<html lang="zh-CN" data-locale="zh" data-theme="light">
<head>
  <meta charset="UTF-8" />
{probe}  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>{title}</title>
  <meta name="description" content="{desc}" />
  <meta name="theme-color" content="{theme_color}" />
  <link rel="icon" href="{up}favicon.svg" type="image/svg+xml" />
  <meta property="og:title" content="{title}" />
  <meta property="og:description" content="{desc}" />
  <meta property="og:type" content="website" />{og_url}{canonical}
{css}
  <script>
    /* 主题要在首次绘制前定好，否则深色模式会闪一下白 */
    (function () {{
      try {{
        var s = localStorage.getItem("wb.theme");
        var d = window.matchMedia("(prefers-color-scheme: dark)").matches;
        document.documentElement.setAttribute("data-theme", s || (d ? "dark" : "light"));
        var l = localStorage.getItem("wb.locale");
        if (l) document.documentElement.setAttribute("data-locale", l === "en" ? "en" : "zh");
      }} catch (e) {{}}
    }})();
  </script>
{js}
</head>"""


def href_attr(href):
    """把 href 渲染成属性。以 `@` 开头 -> data-root-link（见 topbar 的说明）。"""
    if href.startswith("@"):
        return f'data-root-link="{href[1:]}"'
    return f'href="{href}"'


def topbar(depth, crumbs, current, lang_toggle=True):
    """顶栏：侧栏开关 + 品牌 + 面包屑 + 搜索 / 主题 / 语言

    href 以 `@` 开头表示「相对站点根」——只有 404 页需要：
    该页会被部署在站点根，但地址栏保留的是缺失路径，构建期算不出正确前缀，
    所以输出 `data-root-link` 交给运行时那段极小探测脚本补 href。
    """
    up = depth

    def link(href, label, cls=""):
        c = f' class="{cls}"' if cls else ""
        return f"<a{c} {href_attr(href)}>{label}</a>"

    crumb_html = []
    for i, (label, href) in enumerate(crumbs):
        last = i == len(crumbs) - 1
        if last or href is None:
            crumb_html.append(f'<li><span aria-current="page">{label}</span></li>')
        else:
            crumb_html.append(f"<li>{link(href, label)}</li>")
    lang = ""
    if lang_toggle:
        lang = """
        <div class="lang-switch" role="group" aria-label="切换语言 / Switch language">
          <button type="button" data-lang-btn="zh" aria-pressed="true" aria-label="中文">中</button>
          <button type="button" data-lang-btn="en" aria-pressed="false" aria-label="English">EN</button>
        </div>"""
    return f"""  <div class="progress-rail" aria-hidden="true"><div class="progress-rail__bar" id="progress-bar"></div></div>

  <header class="topbar">
    <div class="topbar__inner">
      <button class="icon-btn sidebar-toggle" id="sidebar-toggle" type="button"
              aria-controls="sidebar" aria-expanded="false">
        <span class="sr-only">打开目录</span>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
      </button>

      <a class="topbar__brand" {href_attr(up)}>
        {BRAND_MARK}<span class="brand-text"><span data-lang="zh">可视化导论</span><span data-lang="en">Visualization</span></span>
      </a>

      <span class="topbar__divider" aria-hidden="true"></span>

      <nav class="breadcrumb" aria-label="面包屑导航">
        <ol>{''.join(crumb_html)}</ol>
      </nav>

      <div class="topbar__actions">
        <button class="search-trigger" type="button" data-search-open data-i18n-aria="search.open">
          <svg class="search-trigger__icon" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>
          </svg>
          <span class="search-trigger__label" data-i18n="search.placeholder">搜索</span>
          <kbd>Ctrl K</kbd>
        </button>

        <button class="icon-btn" id="theme-toggle" type="button" data-i18n-aria="theme.toggle" aria-pressed="false">
          <span class="sr-only">切换主题</span>
          <svg class="icon-sun" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="4"/>
            <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4"/>
          </svg>
          <svg class="icon-moon" viewBox="0 0 24 24" aria-hidden="true" style="display:none">
            <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/>
          </svg>
        </button>
        {lang}
      </div>
    </div>
  </header>"""


def search_layer():
    return """  <div class="search-layer" id="search-layer" data-open="false" role="dialog"
       aria-modal="true" aria-label="全站搜索" aria-hidden="true">
    <div class="search-panel">
      <div class="search-panel__field">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/></svg>
        <input class="search-panel__input" id="search-input" type="search" autocomplete="off"
               spellcheck="false" data-i18n-placeholder="search.placeholder"
               placeholder="搜索知识点、代码、演示…" aria-label="搜索关键词" />
        <button class="icon-btn" type="button" data-search-close data-i18n-aria="search.close">
          <span class="sr-only">关闭</span>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      <div class="search-panel__results" id="search-results" role="listbox" aria-label="搜索结果"></div>
      <div class="search-panel__hint">
        <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
        <span><kbd>Enter</kbd> 打开</span>
        <span><kbd>Esc</kbd> 关闭</span>
        <span style="margin-left:auto"><kbd>/</kbd> 随时唤起</span>
      </div>
    </div>
  </div>"""


def sidebar(chapters, cur_slug, sections=None, resources=True):
    """左侧栏：本章目录 + 全部章节 + 配套资源 + 进度"""
    groups = []

    if sections:
        items = []
        for s in sections:
            items.append(
                f'        <li><a class="sidebar__link" href="#{s["id"]}" data-toc-link="{s["id"]}"'
                f' data-progress-key="c{cur_slug[-2:]}s{s["num"].split(".")[-1]}">'
                f'<span class="sidebar__num">{s["num"]}</span>'
                f'<span class="sidebar__text">'
                f'<span data-lang="zh">{s["title"]["zh"]}</span>'
                f'<span data-lang="en">{s["title"]["en"]}</span></span>'
                f'{ICONS["check"]}</a></li>'
            )
        groups.append(f"""    <nav class="sidebar__group" aria-labelledby="sb-toc">
      <div class="sidebar__title" id="sb-toc" data-i18n="sidebar.toc">本章目录</div>
      <ul class="sidebar__list">
{chr(10).join(items)}
      </ul>
    </nav>""")

    ch_items = []
    for c in chapters:
        cur = ' aria-current="page"' if c["slug"] == cur_slug else ""
        scope = f' data-progress-scope="c{c["id"]}s" data-progress-total="{c.get("_sections", 0)}"'
        ch_items.append(
            f'        <li><a class="sidebar__chapter" href="{"../" if cur_slug else ""}{c["slug"]}/"{cur}{scope}>'
            f'<span data-lang="zh">第 {c["num"]} 章 {c["title"]["zh"]}</span>'
            f'<span data-lang="en">Ch. {c["num"]} {c["title"]["en"]}</span>'
            f'<span class="sidebar__progress" data-progress-out>0%</span></a></li>'
        )
    groups.append(f"""    <nav class="sidebar__group" aria-labelledby="sb-all">
      <div class="sidebar__title" id="sb-all" data-i18n="sidebar.chapters">全部章节</div>
      <ul class="sidebar__list">
{chr(10).join(ch_items)}
      </ul>
    </nav>""")

    foot = ""
    if resources:
        foot = f"""    <div class="sidebar__foot">
      <div class="sidebar__title" data-i18n="sidebar.resources">配套资源</div>
      <ul class="sidebar__list">
        <li><a class="sidebar__link" href="{'../' if cur_slug else ''}supplementary/">
          <span class="sidebar__text" data-i18n="resource.demos">补充 demo 集合</span></a></li>
        <li><a class="sidebar__link" href="{'../' if cur_slug else ''}glossary.html">
          <span class="sidebar__text" data-i18n="resource.glossary">术语表</span></a></li>
        <li><a class="sidebar__link" href="#top" data-top>
          <span class="sidebar__text" data-i18n="nav.top">回到顶部</span></a></li>
      </ul>
    </div>"""

    return f"""    <aside class="sidebar" id="sidebar" data-open="false" aria-label="课程导航">
{chr(10).join(groups)}

{foot}
    </aside>
    <div class="sidebar-scrim" id="sidebar-scrim" data-open="false" aria-hidden="true"></div>"""


def site_footer(depth):
    up = depth
    return f"""  <footer class="site-footer">
    <div class="site-footer__inner">
      <div>
        <p>© {SITE['year']} 《可视化导论》 · {t(SITE['school'])} · 授课教师：
          <a href="{SITE['teacherUrl']}" target="_blank" rel="noopener">{SITE['teacher']}</a></p>
        <p class="site-footer__note">
          主要参考教材：{t(SITE['book'])}。本站为课程网站重构版本：内容沿用原课程，
          外壳、导航、检索与无障碍能力为重写。
        </p>
      </div>
      <div class="site-footer__tech">
        <span class="tech-chip">零依赖</span>
        <span class="tech-chip">D3.js v7</span>
        <span class="tech-chip">ES Modules</span>
        <span class="tech-chip">无构建</span>
      </div>
    </div>
  </footer>"""


def close_page(extra_js="", tour=False):
    """页面收尾。

    导览条有两种形态：
      · 折叠态（data-open="false"）—— 只露出一个「自动导览本章」的胶囊按钮，
        章节页默认就是这一态；
      · 展开态（data-open="true"）—— 显示步骤、解说与四个控制按钮。

    这里必须把启动按钮也放进来。此前它只写在门户页上，而章节页的 tour-bar
    里只有展开态的 DOM，于是：章节页既没有启动入口，shell.js 的 Tour.init
    在绑定 #tour-play 时还会因为取到 null 抛异常，把同一次 boot 里排在它后面的
    搜索、进度这些初始化全部带停。一个缺失的按钮，代价是三块功能静默失效。
    """
    tour_bar = ""
    if tour:
        tour_bar = """
  <div class="tour-bar" id="tour-bar" data-open="false" role="region" aria-label="自动导览">
    <button class="tour-bar__trigger" type="button" data-tour-start>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10-6.5z"/></svg>
      <span data-i18n="tour.play">自动导览本章</span>
      <span class="tour-bar__steps" id="tour-total"></span>
    </button>
    <div class="tour-bar__panel">
      <div class="tour-bar__head">
        <span class="tour-bar__count" id="tour-count">1 / 1</span>
        <strong class="tour-bar__title" id="tour-title"></strong>
      </div>
      <p class="tour-bar__say" id="tour-say"></p>
      <div class="tour-bar__actions">
        <button type="button" id="tour-prev" data-i18n="tour.prev">上一步</button>
        <button type="button" id="tour-toggle" data-i18n="tour.pause">暂停</button>
        <button type="button" id="tour-next" data-i18n="tour.next">下一步</button>
        <button type="button" id="tour-exit" data-i18n="tour.exit">退出导览</button>
      </div>
    </div>
  </div>"""
    return f"""{tour_bar}
</body>
</html>
"""


# ============================================================ 小节装配

# 原站快照里带着两种「旧的演示占位」，现在都由 panel_html 生成的
# 带 data-demo-chapter 的挂载点统一承载，旧的必须清掉：
#   ① <div class="demo-mount" data-demo="d-4-1"></div>       （第 1、2 章）
#      —— 没有 data-demo-chapter，runDemo() 直接 return，永远是个空框
#   ② <div id="demo-mount-d-3-1" class="demo-mount">加载中…</div>（第 3~5 章）
#      —— 演示内容现在写进新挂载点，它就永远停在「加载中…」
# 行尾写 `(?:\n|$)` 而不是 `\n`：这两种占位常常正好是面板内容的最后一行，
# 而 inner 先做过 .strip()，末行没有换行符，只认 \n 会整条漏掉。
RE_OLD_MOUNT = re.compile(
    r'^[ \t]*<div class="demo-mount" data-demo="[^"]*">\s*</div>[ \t]*(?:\n|$)',
    re.MULTILINE)
RE_OLD_PLACEHOLDER = re.compile(
    r'^[ \t]*<div id="demo-mount-[^"]*"[^>]*>[^<]*</div>[ \t]*(?:\n|$)',
    re.MULTILINE)


RE_TH_UNSCOPED = re.compile(r"<th(?![^>]*\bscope=)([^>]*)>")


def image_size(path):
    """读图片像素尺寸。只认 PNG / GIF / JPEG —— 站点里用到的就这三种。"""
    try:
        with open(path, "rb") as f:
            head = f.read(32)
    except OSError:
        return None

    if head[:8] == b"\x89PNG\r\n\x1a\n":
        return struct.unpack(">II", head[16:24])
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return struct.unpack("<HH", head[6:10])
    if head[:2] == b"\xff\xd8":  # JPEG：一路找 SOF 段
        try:
            with open(path, "rb") as f:
                f.read(2)
                while True:
                    marker = f.read(2)
                    if len(marker) < 2 or marker[0] != 0xFF:
                        return None
                    if marker[1] in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6,
                                     0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                        f.read(3)
                        h, w = struct.unpack(">HH", f.read(4))
                        return w, h
                    seg_len = struct.unpack(">H", f.read(2))[0]
                    f.seek(seg_len - 2, 1)
        except (OSError, struct.error):
            return None
    return None


RE_IMG = re.compile(r"<img\b([^>]*?)\s*/?>")


def add_img_dims(html: str, base_dir: Path) -> str:
    """给 <img> 补 width / height / loading。

    为什么值得做：没有尺寸时，浏览器在图片下载完之前不知道它要占多高，
    于是先按 0 高度排版、图到了再撑开 —— 这就是 CLS（布局偏移）。
    第 2 章有 5 张图、其中一张 444 KB，读着读着整段文字被顶下去会很烦。

    尺寸从文件头里读，不写死。CSS 里已有 `img { max-width:100%; height:auto }`，
    所以宽高属性只用于「占位」，不会被当成固定渲染尺寸，小屏依然自适应。
    """
    def one(m):
        attrs = m.group(1)
        if re.search(r"\bwidth=", attrs) and re.search(r"\bheight=", attrs):
            return m.group(0)
        src = re.search(r'\bsrc="([^"]+)"', attrs)
        if not src:
            return m.group(0)
        rel = src.group(1)
        if rel.startswith(("http:", "https:", "//", "data:")):
            return m.group(0)
        target = (base_dir / rel.lstrip("./")).resolve()
        dim = image_size(target) if target.is_file() else None
        if not dim:
            return m.group(0)
        w, h = dim
        extra = f' width="{w}" height="{h}"'
        if not re.search(r"\bloading=", attrs):
            extra += ' loading="lazy" decoding="async"'
        return f"<img{attrs.rstrip('/ ')}{extra} />"

    return RE_IMG.sub(one, html)


def fix_table_scope(html: str) -> str:
    """给表头补 scope="col"。

    读屏软件靠 scope 把单元格关联到表头；缺了它，一张 4 列表格会被从头
    念成一串「层 原文 回答的问题 数据 原始 离散的观察结果 …」，听的人无法
    知道某个值属于哪一列。HTML 规范里 th 的默认 scope 是 auto，浏览器能猜，
    但辅助技术未必跟着猜。

    原站这 14 张 theory-table 的 th 全部在 thead 内（是列标题，不是行标题），
    所以统一按 col 处理。
    """
    return re.sub(
        r"<table[\s\S]*?</table>",
        lambda m: RE_TH_UNSCOPED.sub(r'<th scope="col"\1>', m.group(0)),
        html,
    )


# --------------------------------------------------------- 术语互链
# 正文提到「视觉通道」「colormap」时，读者往往正需要定义；而术语表在
# 另一页、只能靠搜索找到。这里把每个术语在正文里的**首次出现**链过去，
# 术语表反向列出「出现在哪些小节」，两处连成一张网。

TERM_SKIP_TAGS = {"a", "code", "pre", "script", "style", "button",
                  "h1", "h2", "h3", "h4", "h5", "h6", "textarea", "svg"}
VOID_TAGS = {"br", "img", "hr", "input", "meta", "link", "source", "col",
             "area", "base", "embed", "param", "track", "wbr"}


def term_labels(term):
    """一个术语在正文里可能用的几种写法：中文名、英文名、别名。
    别名来自 glossary.json 的 alias 字段 —— 正文写「定序」而词条叫「序数尺度」，
    不补别名就永远匹配不上。"""
    labels = [term["zh"], term.get("en") or ""]
    labels += term.get("alias") or []
    return [x for x in labels if x and len(x) >= 2]


def _link_in_text(text: str, used: set, budget: list) -> str:
    """在一个纯文本片段里，给还没用过的术语各链一次。"""
    spans = []
    for term in GLOSSARY_TERMS:
        if term["id"] in used:
            continue
        for label in term_labels(term):
            if not label or len(label) < 2:
                continue
            pos = text.find(label)
            if pos >= 0:
                spans.append((pos, pos + len(label), term["id"]))
    if not spans:
        return text

    spans.sort(key=lambda s: (s[0], -(s[1] - s[0])))
    out, cursor = [], 0
    for start, end, tid in spans:
        if budget[0] <= 0:
            break
        if start < cursor or tid in used:
            continue
        out.append(text[cursor:start])
        out.append(f'<a class="term-link" href="../glossary.html#term-{tid}" '
                   f'title="查术语表">{text[start:end]}</a>')
        used.add(tid)
        budget[0] -= 1
        cursor = end
    out.append(text[cursor:])
    return "".join(out)


def link_terms(html: str, limit: int = 3) -> str:
    """只在文本节点上动手，代码块 / 已有链接 / 标题一律跳过。

    代码块尤其不能碰：把 `channel` 换成 `<a>channel</a>`，学生复制出来的
    就不再是能跑的代码了。每节最多链 limit 处 —— 满屏蓝字会把正文读成链接表。
    """
    if not html:
        return html
    used: set = set()
    budget = [limit]
    stack: list = []
    out = []
    for part in re.split(r"(<[^>]*>)", html):
        if part.startswith("<"):
            m = re.match(r"</?\s*([a-zA-Z0-9]+)", part)
            tag = (m.group(1).lower() if m else "")
            if part.startswith("</"):
                if tag in stack:
                    cut = len(stack) - 1 - stack[::-1].index(tag)
                    del stack[cut:]
            elif tag and not part.endswith("/>") and tag not in VOID_TAGS:
                stack.append(tag)
            out.append(part)
        elif not part.strip() or budget[0] <= 0 or any(t in TERM_SKIP_TAGS for t in stack):
            out.append(part)
        else:
            out.append(_link_in_text(part, used, budget))
    return "".join(out)


def term_usage(all_sections):
    """术语出现在哪些小节（术语表里做反向索引）。"""
    usage: dict = {}
    for ch in CHAPTERS:
        for sec in all_sections[ch["id"]]:
            text = re.sub(r"<[^>]+>", " ", sec["panels"].get("explain", ""))
            for term in GLOSSARY_TERMS:
                if any(label in text for label in term_labels(term)):
                    usage.setdefault(term["id"], []).append((ch, sec))
    return usage


def panel_html(section, name):
    sid = section["id"]
    pid = f"p-{sid}-{name}"
    inner = section["panels"].get(name, "").strip()
    if name == "explain":
        inner = link_terms(inner)
    if name == "demo":
        inner = RE_OLD_MOUNT.sub("", inner)
        inner = RE_OLD_PLACEHOLDER.sub("", inner)
        if section.get("demo"):
            # 这里必须补零：演示模块的文件名是 ch01.js … ch05.js，
            # 属性值会被 lesson.js 直接拼进 import 路径。原先写的是
            # sid 里的裸数字（"1"），拼出 ./demos/ch1.js —— 5 章演示全 404。
            # 属性值应当就是模块 id 本身，别让运行时去猜。
            chap = f'{int(sid.split("-")[1]):02d}'
            inner = (f'<div class="demo-mount" data-demo-chapter="{chap}" '
                     f'data-demo="{section["demo"]}"></div>\n' + inner)
        elif not inner:
            inner = ('<p class="demo-hint">本小节没有配套演示，请参考左侧「补充 demo 集合」里的'
                     '独立示例。</p>')
    return (f'        <div class="tab-panel" id="{pid}" data-panel="{name}" role="tabpanel"\n'
            f'             aria-labelledby="t-{sid}-{name}" data-active="false">\n'
            f'{indent(fix_table_scope(inner), 10)}\n        </div>')


def section_html(section, first):
    sid = section["id"]
    tabs = []
    for name in ("explain", "code", "demo"):
        tabs.append(
            f'          <button class="tab-btn" type="button" data-tab="{name}" role="tab"\n'
            f'                  id="t-{sid}-{name}" aria-controls="p-{sid}-{name}"\n'
            f'                  aria-selected="{"true" if first == name else "false"}">\n'
            f'            {ICONS[name]}\n'
            f'            <span data-lang="zh">{TAB_LABEL[name]}</span>\n'
            f'            <span data-lang="en">{TAB_LABEL_EN[name]}</span>\n'
            f'          </button>'
        )

    panels = "\n".join(panel_html(section, n) for n in ("explain", "code", "demo"))

    sub_zh = section["subtitle"]["zh"]
    sub_en = section["subtitle"]["en"]
    sub = ""
    if sub_zh or sub_en:
        sub = (f'\n          <p class="section__subtitle">'
               f'<span data-lang="zh">{sub_zh}</span>'
               f'<span data-lang="en">{sub_en or sub_zh}</span></p>')

    return f"""      <section class="section" data-section-id="{sid}" id="sec-{sid}"
               data-progress-key="c{int(sid.split('-')[1]):02d}s{section['num'].split('.')[-1]}"
               aria-labelledby="{sid}">
        <div class="section__head">
          <div class="section__eyebrow">
            <span class="section__num">{section['num']}</span>
          </div>
          <h2 class="section__title" id="{sid}"><span data-lang="zh">{section['title']['zh']}</span><span data-lang="en">{section['title']['en']}</span></h2>{sub}
        </div>
        <div class="tabs" role="tablist" aria-label="内容视图">
{chr(10).join(tabs)}
        </div>
        <div class="tab-panels">
{panels}
        </div>
      </section>"""


# 每章一个身份色，取自 Wong 色板（和图里的 --viz-* 同一套）。
# 章首的大号章号、小节编号、统计数字都用它 —— 不然五个章节页长得一模一样，
# 翻章时读者找不到"换了一章"的信号。
CHAPTER_ACCENT = {
    "01": "viz-1",
    "02": "viz-2",
    "03": "viz-3",
    "04": "viz-4",
    "05": "viz-5",
}

# 三条学习路线。五个章节的默认顺序面向"从头学"，但读者不是一类人：
# 有人只想快点把数据画成图，有人是补色彩与时序这两块专题。
# 与其让他们自己在卡片里挑，不如把"该走哪条、跳过什么"直接写出来。
LEARNING_ROUTES = [
    {
        "key": "scratch",
        "title": {"zh": "零基础，从头走一遍", "en": "From scratch, in order"},
        "why": {
            "zh": "没写过 JavaScript 也能跟上。每章都先讲「为什么」，再落到代码。",
            "en": "No JavaScript needed. Each chapter explains the why before the code.",
        },
        "steps": [
            ("01", {"zh": "分清楚名义、序数、区间尺度 —— 后面每一次选图都靠这个判断",
                    "en": "Nominal, ordinal, interval: every later chart choice follows from this"}),
            ("02", {"zh": "把「数据 → 变换 → 映射 → 渲染」整条链路走通",
                    "en": "Walk the whole data → transform → map → render pipeline"}),
            ("03", {"zh": "颜色不只是好看：三类 colormap 用错就是误导",
                    "en": "Colour is not decoration: the wrong colormap misleads"}),
            ("04", {"zh": "低维数据的取舍：散点、平行坐标、降维各自放弃了什么",
                    "en": "Low-dimensional trade-offs: what scatter, parallel coords and projection each give up"}),
            ("05", {"zh": "时间数据的三种形态：折线、日历热图、周期螺旋",
                    "en": "Three shapes of time: line, calendar heatmap, spiral"}),
        ],
    },
    {
        "key": "fast",
        "title": {"zh": "会写 JS，想尽快出图", "en": "Know JS, want charts fast"},
        "why": {
            "zh": "跳过色彩专题与时序，先把通用流程和低维图表拿下。缺的两块随时能回来补。",
            "en": "Skip colour and time for now; get the pipeline and low-dimensional charts first.",
        },
        "steps": [
            ("01", {"zh": "只需要看 1.3 数据属性，其余可略读",
                    "en": "Read 1.3 on attributes; skim the rest"}),
            ("02", {"zh": "整章必看，这是所有图共用的骨架",
                    "en": "Read all of it — this is the skeleton every chart shares"}),
            ("04", {"zh": "散点与坐标变换是日常用得最多的两块",
                    "en": "Scatter and axis transforms are the two you will use daily"}),
        ],
    },
    {
        "key": "topic",
        "title": {"zh": "只补色彩或时序", "en": "Just colour or time"},
        "why": {
            "zh": "两个独立专题。先花二十分钟过第 1 章的数据尺度，再直接跳过去。",
            "en": "Two standalone topics. Spend twenty minutes on data scales in chapter 1 first.",
        },
        "steps": [
            ("01", {"zh": "只看 1.2 与 1.3，知道数据有哪几种尺度就够",
                    "en": "Only 1.2 and 1.3 — you just need the data scales"}),
            ("03", {"zh": "色彩专题：模型、colormap、搭配规则、色觉缺陷",
                    "en": "Colour: models, colormaps, palettes, colour-vision deficiency"}),
            ("05", {"zh": "时序专题：时间属性、日历热图、周期螺旋",
                    "en": "Time: properties, calendar heatmaps, periodic spirals"}),
        ],
    },
]


def routes_html(section_counts):
    """门户的「学习路径」。每条路线是一条带连接线的步骤链，
    走过的章会在步骤上打勾（复用站内的阅读进度，不另存一份状态）。"""
    cards = []
    for r in LEARNING_ROUTES:
        steps = []
        for cid, note in r["steps"]:
            ch = next(c for c in CHAPTERS if c["id"] == cid)
            steps.append(f"""            <li class="route__step" data-progress-scope="c{cid}s"
                data-progress-total="{section_counts[cid]}">
              <a class="route__link" href="{ch['slug']}/">
                <span class="route__num">{cid}</span>
                <span class="route__body">
                  <span class="route__name">
                    <span data-lang="zh">{ch['short']['zh']}</span>
                    <span data-lang="en">{ch['short']['en']}</span>
                  </span>
                  <span class="route__note">
                    <span data-lang="zh">{note['zh']}</span>
                    <span data-lang="en">{note['en']}</span>
                  </span>
                </span>
              </a>
            </li>""")
        cards.append(f"""        <article class="route" data-route="{r['key']}">
          <h3 class="route__title">
            <span data-lang="zh">{r['title']['zh']}</span>
            <span data-lang="en">{r['title']['en']}</span>
          </h3>
          <p class="route__why">
            <span data-lang="zh">{r['why']['zh']}</span>
            <span data-lang="en">{r['why']['en']}</span>
          </p>
          <ol class="route__steps">
{chr(10).join(steps)}
          </ol>
        </article>""")
    return f"""    <section class="portal-section" aria-labelledby="routes-title">
      <h2 id="routes-title" class="portal-section__title">
        <span data-lang="zh">学习路径</span><span data-lang="en">Learning paths</span>
      </h2>
      <p class="portal-section__lead">
        <span data-lang="zh">五章不必都从头读到尾。按你的目标挑一条，跳过的章随时能回来补。</span>
        <span data-lang="en">You do not have to read all five in order. Pick the path that matches your goal; skipped chapters stay open.</span>
      </p>
      <div class="route-grid">
{chr(10).join(cards)}
      </div>
    </section>"""


def chapter_stats(ch):
    """章首的关键数字条。数字用等宽字体放大，单位跟在后面 —— 一屏之内就能
    判断"这章有多少内容、多少代码"，不用读完铅字段落。

    这里刻意不放「预计用时」：读者的阅读速度差好几倍，写出来的数字对谁都不准，
    反而会让人先打退堂鼓。要的量是「这一章有多少东西」，不是「你得花多久」。"""
    rows = [
        (ch["_sections"], "个小节", "sections"),
        (ch["_stars"], "处关键代码", "key snippets"),
        (len(ch["objectives"]["zh"]), "项学习目标", "objectives"),
    ]
    items = "\n".join(
        f'            <li><strong>{n}</strong>'
        f'<span data-lang="zh">{z}</span><span data-lang="en">{e}</span></li>'
        for n, z, e in rows
    )
    return f"""          <ul class="chapter-stats">
{items}
          </ul>
          <p class="page-head__source">
            <span data-lang="zh">来源 · {ch['source']['zh']}</span>
            <span data-lang="en">Source · {ch['source']['en']}</span>
          </p>"""


def objectives_html(ch):
    items = "\n".join(
        f'            <li><span data-lang="zh">{z}</span><span data-lang="en">{e}</span></li>'
        for z, e in zip(ch["objectives"]["zh"], ch["objectives"]["en"])
    )
    return f"""      <section class="objectives" aria-labelledby="objectives-title">
        <div class="objectives__head">
          <h2 class="objectives__title" id="objectives-title">
            <span data-lang="zh">学完这一章，你应该能够</span>
            <span data-lang="en">By the end of this chapter you should be able to</span>
          </h2>
        </div>
        <ul class="objectives__list">
{items}
        </ul>
        <p class="objectives__prereq">
          <strong><span data-lang="zh">前置知识</span><span data-lang="en">Prerequisites</span>：</strong>
          <span data-lang="zh">{ch['prereq']['zh']}</span>
          <span data-lang="en">{ch['prereq']['en']}</span>
        </p>
      </section>"""


# ============================================================ 章节页

# ============================================================ 延伸实验
# 第 1 章额外带了一批「可独立运行」的实验页面（lesson-01/demo/），
# 每个都自包含、能单独拷给学生改。原站旧导航里出现过一次，重构后一度变成孤儿——
# 内容没问题，只是没有任何页面指向它了。这类「能打开但走不到」的页面，
# 和断链一样会导致内容实质不可达，所以重新接线回章节页。

LABS = {
    "01": {
        "href": "demo/",
        "name": {"zh": "5 个可独立运行的实验", "en": "Five standalone experiments"},
        "desc": {
            "zh": "数据加载器 · DIKW 金字塔 · 属性类型 × 视觉通道 · D3 数组函数 · Selection 三态模型。"
                  "每个实验都是一个独立页面，不依赖本站其他资源。",
            "en": "Data loader · DIKW pyramid · attribute types × visual channels · D3 array helpers · "
                  "the three states of a selection. Each experiment is its own page with no dependencies.",
        },
    },
}


def lab_callout(ch):
    lab = LABS.get(ch["id"])
    if not lab:
        return ""
    return f"""
        <aside class="lab-callout">
          <div>
            <p class="lab-callout__eyebrow" data-i18n="lab.eyebrow">延伸实验</p>
            <h2 class="lab-callout__title">
              <span data-lang="zh">{lab['name']['zh']}</span>
              <span data-lang="en">{lab['name']['en']}</span>
            </h2>
            <p class="lab-callout__desc">
              <span data-lang="zh">{lab['desc']['zh']}</span>
              <span data-lang="en">{lab['desc']['en']}</span>
            </p>
          </div>
          <a class="lab-callout__cta" href="{lab['href']}">
            <span data-i18n="lab.open">打开实验目录</span>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6"/></svg>
          </a>
        </aside>"""


def quiz_html(ch):
    """章末自测。题目只考本章正文讲过的内容，答错给解析 + 回查小节的链接。

    刻意不做「提交后统一判分」：选完立刻出解析，读者的注意力还在那道题上。
    """
    items_data = QUIZ.get(ch["id"], [])
    if not items_data:
        return ""

    by_sid = {s["id"]: s for s in ch["_section_data"]}
    items = []
    for qi, q in enumerate(items_data, 1):
        sec = by_sid.get(q.get("section"))
        ref = (f'<a class="quiz__ref" href="#sec-{sec["id"]}">'
               f'<span data-lang="zh">复习 {sec["num"]} {sec["title"]["zh"]}</span>'
               f'<span data-lang="en">Review {sec["num"]} {sec["title"]["en"]}</span></a>'
               if sec else "")
        opts = "\n".join(
            f'              <button class="quiz__opt" type="button" data-i="{oi}">'
            f'<span class="quiz__key">{"ABCD"[oi]}</span>'
            f'<span class="quiz__text">'
            f'<span data-lang="zh">{o["zh"]}</span>'
            f'<span data-lang="en">{o["en"]}</span></span></button>'
            for oi, o in enumerate(q["options"])
        )
        items.append(f"""          <li class="quiz__item" data-answer="{q['answer']}">
            <p class="quiz__q">
              <span class="quiz__num">{qi:02d}</span>
              <span class="quiz__qtext"><span data-lang="zh">{q['q']['zh']}</span><span data-lang="en">{q['q']['en']}</span></span>
            </p>
            <div class="quiz__options" role="group"
                 aria-label="第 {qi} 题选项">
{opts}
            </div>
            <div class="quiz__why" hidden>
              <p class="quiz__verdict" data-quiz-verdict></p>
              <p><span data-lang="zh">{q['why']['zh']}</span><span data-lang="en">{q['why']['en']}</span></p>
              {ref}
            </div>
          </li>""")

    return f"""        <section class="quiz" aria-labelledby="quiz-title">
          <div class="quiz__head">
            <p class="quiz__eyebrow">Self-check</p>
            <h2 class="quiz__title" id="quiz-title">
              <span data-lang="zh">自测 · {len(items_data)} 题</span>
              <span data-lang="en">Self-check · {len(items_data)} questions</span>
            </h2>
            <p class="quiz__lead">
              <span data-lang="zh">选一个答案，立刻看解析。答错的那题，解析末尾有回到对应小节的链接。</span>
              <span data-lang="en">Pick an answer to see the explanation. Each one links back to the section it came from.</span>
            </p>
            <p class="quiz__score" data-quiz-score hidden></p>
          </div>
          <ol class="quiz__list">
{chr(10).join(items)}
          </ol>
        </section>
"""


def build_lesson(ch):
    slug = ch["slug"]
    sections = ch["_section_data"]
    idx = CHAPTERS.index(ch)
    prev_ch = CHAPTERS[idx - 1] if idx > 0 else None
    next_ch = CHAPTERS[idx + 1] if idx < len(CHAPTERS) - 1 else None

    concept = json.dumps(ch["concept"], ensure_ascii=False, separators=(",", ":"))
    tour = json.dumps(ch["tour"], ensure_ascii=False, separators=(",", ":"))

    title = f"第 {ch['num']} 章 {ch['title']['zh']} · 《可视化导论》"
    desc = re.sub(r"\s+", " ", ch["lead"]["zh"])[:110]

    pager_prev = ('<span class="lesson-pager__spacer"></span>' if not prev_ch else
                  f'<a class="lesson-pager__link" href="../{prev_ch["slug"]}/">'
                  f'<span class="lesson-pager__label" data-i18n="nav.prev">上一节</span>'
                  f'<span class="lesson-pager__title"><span data-lang="zh">第 {prev_ch["num"]} 章 {prev_ch["title"]["zh"]}</span>'
                  f'<span data-lang="en">Ch. {prev_ch["num"]} {prev_ch["title"]["en"]}</span></span></a>')
    pager_next = ('<span class="lesson-pager__spacer"></span>' if not next_ch else
                  f'<a class="lesson-pager__link lesson-pager__link--next" href="../{next_ch["slug"]}/">'
                  f'<span class="lesson-pager__label" data-i18n="nav.next">下一节</span>'
                  f'<span class="lesson-pager__title"><span data-lang="zh">第 {next_ch["num"]} 章 {next_ch["title"]["zh"]}</span>'
                  f'<span data-lang="en">Ch. {next_ch["num"]} {next_ch["title"]["en"]}</span></span></a>')

    html = f"""{head(title, desc, "../", extra_js=("conceptmap", "lesson"),
                     path=f"/{ch['slug']}/")}
<body id="top">
  <a class="skip-link" href="#main">跳到主要内容</a>

{topbar("../", [(L("课程门户", "Home"), "../"), (L(f"第 {ch['num']} 章 {ch['title']['zh']}", f"Ch. {ch['num']} {ch['title']['en']}"), None)], slug)}

{search_layer()}

  <div class="shell">
{sidebar(CHAPTERS, slug, sections)}

    <main class="main" id="main">
      <div class="content" style="--ch-accent: var(--{CHAPTER_ACCENT[ch['id']]})">
        <div class="page-head page-head--chapter">
          <span class="page-head__chapter" aria-hidden="true">{ch['num']:02d}</span>
          <p class="page-head__eyebrow">
            <span data-lang="zh">第 {ch['num']:0>2} 章 · {ch['title']['zh']}</span>
            <span data-lang="en">Chapter {ch['num']:0>2} · {ch['title']['en']}</span>
          </p>
          <h1>
            <span data-lang="zh">第 {ch['num']} 章 {ch['title']['zh']}</span>
            <span data-lang="en">Chapter {ch['num']}: {ch['title']['en']}</span>
          </h1>
          <p class="page-head__lead">
            <span data-lang="zh">{ch['lead']['zh']}</span>
            <span data-lang="en">{ch['lead']['en']}</span>
          </p>
{chapter_stats(ch)}
        </div>

{objectives_html(ch)}

        <figure class="figure">
          <div class="figure__frame" id="concept-map" role="img"
               aria-label="本章概念依赖图"></div>
          <figcaption>
            <span data-lang="zh">本章知识点的依赖关系。箭头表示「先理解前者，才容易理解后者」。节点可以拖动，双击复位。</span>
            <span data-lang="en">Dependencies between the concepts in this chapter. Drag a node to move it; double-click to reset.</span>
          </figcaption>
        </figure>

{chr(10).join(section_html(s, "explain" if i == 0 else None) for i, s in enumerate(sections))}

{quiz_html(ch)}

{lab_callout(ch)}

        <nav class="lesson-pager" data-prev="{"../" + prev_ch["slug"] + "/" if prev_ch else ""}"
             data-next="{"../" + next_ch["slug"] + "/" if next_ch else ""}" aria-label="章节翻页">
          {pager_prev}
          {pager_next}
        </nav>
      </div>
    </main>
  </div>

{site_footer("../")}

  <script type="application/json" id="concept-data">{concept}</script>
  <script type="application/json" id="tour-data">{tour}</script>
{close_page(tour=True)}"""

    write(ROOT / slug / "index.html", add_img_dims(html, ROOT / slug))

    # 讲义：把 markdown 渲染成 HTML，取代原来「下载一个 .md」的做法
    md = ROOT / slug / "lecture.md"
    if md.exists():
        write(ROOT / slug / "lecture.html", build_lecture(ch, read(md), sections))
    return sections


def build_lecture(ch, md_text, sections):
    """讲义页：完整 markdown 版正文，供打印与离线阅读。

    中英两版都渲染进同一个页面，靠 data-lang 切换。英文锚点统一加 `-en`
    后缀，否则两版里的 h2 id 完全相同，英文模式下点目录会跳到被隐藏的中文标题上。
    讲义页原本是「点了 EN 没反应」的重灾区：顶栏有语言按钮，正文一个字不动。"""
    id_map = {s["num"]: s["id"] for s in sections}
    body = markdown(md_text, id_map)
    en_md_path = ROOT / ch["slug"] / "lecture-en.md"
    if en_md_path.exists():
        en_body = markdown(read(en_md_path), {s["num"]: s["id"] + "-en" for s in sections})
        body = (f'<div class="lecture__lang" data-lang="zh">\n{body}\n</div>\n'
                f'<div class="lecture__lang" data-lang="en">\n{en_body}\n</div>')
    toc = "\n".join(
        f'          <li><a class="sidebar__link" href="#{s["id"]}" data-lang="zh">'
        f'<span class="sidebar__num">{s["num"]}</span>'
        f'<span class="sidebar__text">{s["title"]["zh"]}</span></a>'
        f'<a class="sidebar__link" href="#{s["id"]}-en" data-lang="en">'
        f'<span class="sidebar__num">{s["num"]}</span>'
        f'<span class="sidebar__text">{s["title"]["en"]}</span></a></li>'
        for s in sections
    )
    html = f"""{head(f"第 {ch['num']} 章 讲义 · 《可视化导论》", re.sub(r"\\s+", " ", ch['lead']['zh'])[:110], "../",
                     path=f"/{ch['slug']}/lecture.html")}
<body id="top">
  <a class="skip-link" href="#main">跳到主要内容</a>

{topbar("../", [(L("课程门户", "Home"), "../"), (L(f"第 {ch['num']} 章 {ch['title']['zh']}", f"Ch. {ch['num']} {ch['title']['en']}"), f"../{ch['slug']}/"), (L("讲义", "Lecture"), None)], ch['slug'])}

{search_layer()}

  <div class="shell">
    <aside class="sidebar" id="sidebar" data-open="false" aria-label="讲义目录">
      <nav class="sidebar__group">
        <div class="sidebar__title">
          <span data-lang="zh">{ch['title']['zh']} · 讲义</span>
          <span data-lang="en">Ch. {ch['num']} {ch['title']['en']} · Lecture</span>
        </div>
        <ul class="sidebar__list">
{toc}
          <li><a class="sidebar__link" href="../{ch['slug']}/">
            <span class="sidebar__text">
              <span data-lang="zh">← 返回交互版章节页</span>
              <span data-lang="en">← Back to the interactive chapter</span>
            </span></a></li>
        </ul>
      </nav>
    </aside>
    <div class="sidebar-scrim" id="sidebar-scrim" data-open="false" aria-hidden="true"></div>

    <main class="main" id="main">
      <article class="content lecture">
{indent(body, 8)}
      </article>
    </main>
  </div>

{site_footer("../")}
{close_page()}"""
    return html


# ============================================================ Markdown
# 只用标准库实现一个够用的子集：标题 / 段落 / 列表 / 表格 / 围栏代码 /
# 引用 / 分隔线 / 行内强调与链接。引入第三方 markdown 库会破坏
# 「零依赖、一条 python 命令就能重新构建」这个卖点。

RE_MD_FENCE = re.compile(r"^```(\w*)\s*$")
RE_MD_TABLE_SEP = re.compile(r"^\|?[\s:]*-{2,}[\s:|-]*\|?\s*$")


def md_inline(s: str) -> str:
    s = (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    s = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"(?<!\*)\*([^*\n]+)\*(?!\*)", r"<em>\1</em>", s)
    s = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', s)
    s = re.sub(r"^⭐\s*", '<span class="star">⭐</span> ', s)
    return s


def markdown(text: str, id_map: dict = None) -> str:
    """极简 markdown → HTML。

    id_map 用于给 h2 指定确定的锚点：{小节号: id}，例如 {"2.1": "ch-2-1"}。
    讲义页的侧栏目录是按小节 id 生成的，而锚点原本是从标题文字推导的
    （`2-1-数据可视化流程-card-mackinlay-van-wijk`），两边对不上 ——
    27 个目录项点了全都没反应。传了 id_map 就以它为准。

    同名标题也会自动去重（`你的原案例` → `你的原案例-2` …）。讲义里
    「你的原案例」「嵌入的理论」这种标题每小节都出现一次，不去重就是
    一串重复 id，页面内链接永远只能跳到第一个。
    """
    lines = text.split("\n")
    out = []
    i = 0
    n = len(lines)
    used: dict[str, int] = {}

    def make_anchor(txt: str, level: int) -> str:
        if id_map and level == 2:
            for num, sid in id_map.items():
                if txt.startswith(num + " "):
                    return sid
        base = re.sub(r"[^\w\u4e00-\u9fff]+", "-", txt).strip("-").lower()
        if not base:
            base = "section"
        seen = used.get(base, 0) + 1
        used[base] = seen
        return base if seen == 1 else f"{base}-{seen}"

    while i < n:
        line = lines[i]

        fence = RE_MD_FENCE.match(line)
        if fence:
            lang = fence.group(1) or "text"
            buf = []
            i += 1
            while i < n and not lines[i].startswith("```"):
                buf.append(lines[i])
                i += 1
            i += 1
            code = "\n".join(buf)
            # 必须转义。代码示例里出现 <defs> / <marker> / <input> 是常态
            # （第 2 章讲 SVG 流程图、讲滑块交互都用得到），不转义的话浏览器
            # 会把它们当成真实标签：<defs> <marker> 直接消失，代码里那一行
            # 变成「// 1. 用  +  定义箭头」；<input> 更糟，真的在代码块里
            # 渲染出一个滑块。
            out.append(f'<div class="code-block"><pre><code class="lang-{lang}">'
                       f'{html_escape(code)}</code></pre></div>')
            continue

        if re.match(r"^#{1,6}\s", line):
            level = len(line) - len(line.lstrip("#"))
            txt = line[level:].strip()
            anchor = make_anchor(txt, level)
            out.append(f'<h{level} id="{anchor}">{md_inline(txt)}</h{level}>')
            i += 1
            continue

        if line.strip() in ("---", "***", "___"):
            out.append("<hr />")
            i += 1
            continue

        if line.startswith(">"):
            buf = []
            while i < n and lines[i].startswith(">"):
                buf.append(lines[i].lstrip("> ").rstrip())
                i += 1
            out.append('<blockquote class="note">' + md_inline(" ".join(buf)) + "</blockquote>")
            continue

        # 表格
        if "|" in line and i + 1 < n and RE_MD_TABLE_SEP.match(lines[i + 1]):
            head = [c.strip() for c in line.strip().strip("|").split("|")]
            i += 2
            rows = []
            while i < n and "|" in lines[i] and lines[i].strip():
                rows.append([c.strip() for c in lines[i].strip().strip("|").split("|")])
                i += 1
            th = "".join(f'<th scope="col">{md_inline(c)}</th>' for c in head)
            trs = "".join(
                "<tr>" + "".join(f'<td data-label="{head[k] if k < len(head) else ""}">'
                                 f"{md_inline(c)}</td>" for k, c in enumerate(r)) + "</tr>"
                for r in rows
            )
            out.append(f'<table class="theory-table"><thead><tr>{th}</tr></thead>'
                       f"<tbody>{trs}</tbody></table>")
            continue

        # 列表
        if re.match(r"^\s*(?:[-*+]|\d+\.)\s", line):
            ordered = bool(re.match(r"^\s*\d+\.\s", line))
            tag = "ol" if ordered else "ul"
            items = []
            while i < n and re.match(r"^\s*(?:[-*+]|\d+\.)\s", lines[i]):
                items.append(re.sub(r"^\s*(?:[-*+]|\d+\.)\s", "", lines[i]))
                i += 1
            out.append(f"<{tag}>" + "".join(f"<li>{md_inline(x)}</li>" for x in items) + f"</{tag}>")
            continue

        if not line.strip():
            i += 1
            continue

        buf = []
        while i < n and lines[i].strip() and not re.match(
            r"^\s*(?:#{1,6}\s|[-*+]\s|\d+\.\s|>|\||```)", lines[i]
        ) and lines[i].strip() not in ("---", "***", "___"):
            buf.append(lines[i].strip())
            i += 1
        out.append("<p>" + md_inline(" ".join(buf)) + "</p>")

    return "\n".join(out)


# ============================================================ 演示模块

NAV_FUNCS = ["__resolveDemoName", "__renderDemo", "__renderAllDemos",
             "__activateChapter", "__bindLessonNav"]

DEMO_HEADER = """/* ============================================================================
   第 {num} 章演示模块 —— 由 tools/build.py 从原 lesson.js 抽取
   ----------------------------------------------------------------------------
   原站把「导航 + tab 切换 + 演示注册」写在同一个 {size} 字节的文件里，
   而且 5 章的演示键会互相冲突（第 1 章的 d-3-1 和第 3 章的 d-3-1 同名）。
   抽取时做了两件事：
     · 删掉导航与 tab 相关函数 —— 这些已由 assets/js/shell.js 统一提供；
     · 把 window.DEMOS 收进模块作用域，改为 default export，由 lesson.js
       按需动态 import，因此打开页面时不会下载任何演示代码。
   内容逻辑（{count} 个演示）未作任何改动。
   ========================================================================= */

"""


def strip_js_blocks(src: str, header_re) -> str:
    """删掉匹配 header_re 的顶层语句块（含 {} 平衡体）。

    用来清掉原 lesson.js 里的导航副作用，例如：
        if (location.hash) { ... __activateChapter(initialId) ... }
    这类逻辑现在由 assets/js/shell.js 的 ScrollSpy 统一负责。
    """
    pat = re.compile(header_re, re.M)
    while True:
        m = pat.search(src)
        if not m:
            break
        open_idx = src.index("{", m.end() - 1)
        close_idx = js_match_brace(src, open_idx)
        start = m.start()
        while start > 0 and src[start - 1] in " \t":
            start -= 1
        src = src[:start] + src[close_idx + 1:]
    return src


def build_demos():
    counts = {}
    for ch in CHAPTERS:
        cid = ch["id"]
        # 从 tools/origin/ 读，而不是从 lesson-0X/lesson.js 读。
        # 后者会被 cleanup_legacy() 删掉，如果直接从站点树读，
        # 这个管道就只能跑一次（第一次之后输入就没了），没法复现也没法 diff。
        src = read(ORIGIN / f"lesson-{cid}.js")
        original_size = len(src.encode("utf-8"))
        n_reg = len(re.findall(r'DEMOS\["', src))

        src = strip_js_functions(src, NAV_FUNCS)
        src = strip_js_blocks(src, r"^if\s*\(\s*location\.hash\s*\)")
        # 摘掉对已删除函数的顶层调用
        src = re.sub(r"^[ \t]*__bindLessonNav\(\);[ \t]*\n", "", src, flags=re.M)
        src = re.sub(r"^[ \t]*__renderAllDemos\(\);[ \t]*\n", "", src, flags=re.M)
        src = re.sub(r"^[ \t]*queueMicrotask\(\(\) => __renderAllDemos\(\)\);[ \t]*\n",
                     "", src, flags=re.M)
        # 原文件里交代「本文件已被补丁脚本改过」的注释，抽取后不再成立
        src = re.sub(r"^// 统一章节导航 \+ Tab 切换 \+ 自动渲染 demo.*\n", "", src, flags=re.M)
        src = re.sub(r"^\s*// 页面初始（module 加载后立即执行）\s*\n", "", src, flags=re.M)
        src = re.sub(r"^\s*// 延迟到下一个 microtask.*\n", "", src, flags=re.M)
        src = re.sub(r"^\s*// 如果 URL 带 hash，激活对应章节\s*\n", "", src, flags=re.M)
        # 把全局注册表收进模块作用域，避免跨章同名冲突。
        # 注意不能无脑替换成 `const DEMOS = {};`：第 2 章的原文件里本来就有一处
        # `const DEMOS = {}`（第 110 行），再补一个就是重复声明 —— 整个模块在
        # 语法解析阶段就抛 "Identifier 'DEMOS' has already been declared"，
        # 演示区全部显示「加载失败」。这里先只把已知的那句去掉，再确认全文
        # 恰好有一处声明。
        src = re.sub(r"^[ \t]*window\.DEMOS\s*=\s*window\.DEMOS\s*\|\|\s*\{\};[ \t]*\n",
                     "", src, flags=re.M)
        src = re.sub(r"(?:window|globalThis)\.DEMOS\s*\[\s*", "DEMOS[", src)
        decl = re.findall(r"^[ \t]*(?:const|let|var)\s+DEMOS\s*=", src, flags=re.M)
        if not decl:
            # 没有自带声明时补一个，放在 d3 导入之后，保持 import 在前
            src = re.sub(r'^(import \* as d3 from [^\n]+\n)',
                         r'\1\nconst DEMOS = {};\n', src, count=1, flags=re.M)
        elif len(decl) > 1:
            raise SystemExit(f"第 {ch['num']} 章演示模块出现 {len(decl)} 处 DEMOS 声明，"
                             f"抽取规则需要调整")
        # 删掉残留的「传给已删除函数」的调用
        src = re.sub(r"^[ \t]*const mount = .*__[a-zA-Z]+\(.*\);[ \t]*\n", "", src, flags=re.M)
        src = re.sub(r"\n{3,}", "\n\n", src)

        leftovers = [fn for fn in NAV_FUNCS if fn in src]
        if leftovers:
            raise SystemExit(f"第 {ch['num']} 章演示模块仍引用已删除的 {leftovers}，"
                             f"抽取规则需要调整")

        assert "import * as d3" in src, f"lesson-{cid} 缺少 d3 导入"
        # 原站从 jsDelivr 的 +esm 入口取 d3，那个入口不打包：浏览器实际要发
        # 40 多个模块请求。网络受限或 CDN 一抖动，整块演示区就是「正在加载演示…」
        # 永远停在那儿。这里统一换成仓库内置的单文件版本（assets/js/vendor/d3.esm.js），
        # 离线也能读，首屏少 40 次往返。
        src = re.sub(r'^import \* as d3 from ["\'][^"\']+["\'];',
                     'import * as d3 from "../vendor/d3.esm.js";', src, flags=re.M)

        body = DEMO_HEADER.format(num=ch["num"], size=original_size, count=n_reg) + src
        body += "\n\nexport default DEMOS;\n"

        out = ROOT / "assets" / "js" / "demos" / f"ch{cid}.js"
        write(out, body)
        counts[cid] = n_reg
        print(f"  · 第 {ch['num']} 章：抽取 {n_reg} 个演示 → assets/js/demos/ch{cid}.js "
              f"({original_size} B → {len(body.encode('utf-8'))} B)")
    return counts


# ============================================================ 搜索索引

def strip_tags(s):
    s = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", s, flags=re.S)
    s = re.sub(r"<[^>]+>", " ", s)
    s = (s.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<")
          .replace("&gt;", ">").replace("&quot;", '"').replace("&#39;", "'"))
    return re.sub(r"\s+", " ", s).strip()


def build_search_index(all_sections):
    entries = []

    for ch in CHAPTERS:
        scope = f"第 {ch['num']} 章"
        entries.append({
            "href": f"{ch['slug']}/",
            "primary": True,
            "zh": {
                "title": f"第 {ch['num']} 章 {ch['title']['zh']}",
                "where": "章节首页",
                "text": ch["lead"]["zh"] + " " + " ".join(ch["objectives"]["zh"]),
            },
            "en": {
                "title": f"Chapter {ch['num']} {ch['title']['en']}",
                "where": "Chapter home",
                "text": ch["lead"]["en"] + " " + " ".join(ch["objectives"]["en"]),
            },
        })

        for s in all_sections[ch["id"]]:
            explain = strip_tags(s["panels"].get("explain", ""))
            code = strip_tags(s["panels"].get("code", ""))
            entries.append({
                "href": f"{ch['slug']}/index.html#{s['id']}",
                "primary": False,
                "zh": {
                    "title": s["full"]["zh"],
                    "where": f"{scope} · 1.{s['num'].split('.')[-1]}",
                    "text": (s["subtitle"]["zh"] + " " + explain)[:420],
                },
                "en": {
                    "title": s["full"]["en"],
                    "where": f"{scope} · {s['num']}",
                    "text": (s["subtitle"]["en"] + " " + explain)[:420],
                },
            })
            # 代码块单独成条：学生常常是「想不起来那个 API 叫什么」才来搜
            if code:
                entries.append({
                    "href": f"{ch['slug']}/index.html#{s['id']}",
                    "primary": False,
                    "zh": {"title": f"{s['full']['zh']} · 关键代码",
                           "where": f"{scope} 代码", "text": code[:420]},
                    "en": {"title": f"{s['full']['en']} · key code",
                           "where": f"{scope} code", "text": code[:420]},
                })

        for s in all_sections[ch["id"]]:
            if s.get("demo"):
                entries.append({
                    "href": f"{ch['slug']}/index.html#{s['id']}",
                    "primary": False,
                    "zh": {"title": f"{s['full']['zh']} · 可运行演示",
                           "where": f"{scope} 演示", "text": s["subtitle"]["zh"]},
                    "en": {"title": f"{s['full']['en']} · live demo",
                           "where": f"{scope} demo", "text": s["subtitle"]["en"]},
                })

    # 术语表与补充 Demo 原本一条都不在索引里 —— 学生搜「视觉通道」「日历热图」
    # 只会得到「没有匹配」，可这两处恰恰是最该被搜到的地方：术语表就是拿来查的，
    # 补充 Demo 是按图形类型排的图例集。索引只覆盖 5 章正文是这套检索最大的漏。
    for t in json.loads(read(DATA / "glossary.json"))["terms"]:
        entries.append({
            "href": f"glossary.html#term-{t['id']}",
            "primary": False,
            "zh": {"title": t["zh"], "where": f"术语表 · 第 {int(t['ch'])} 章",
                   "text": (t["zh_def"] + " " + t["zh_why"])[:420]},
            "en": {"title": t["en"], "where": f"Glossary · ch. {int(t['ch'])}",
                   "text": (t["en_def"] + " " + t["en_why"])[:420]},
        })

    for cid, _title, _hint, demos in SUPP_GROUPS:
        for fname, name, desc in demos:
            entries.append({
                "href": f"supplementary/{fname}",
                "primary": False,
                "zh": {"title": name, "where": f"补充 Demo · 第 {int(cid)} 章", "text": desc},
                "en": {"title": name, "where": f"Extra demo · ch. {int(cid)}", "text": desc},
            })

    return entries


# ============================================================ 门户页

# --------------------------------------------------------------- 章节微缩图
# 每张章节卡片顶部的一枚小图形。三个约束：
#   1. 内联 SVG，构建期就写死 —— 不发额外请求，也不依赖 JS，脚本禁用也在；
#   2. 取色一律走 --viz-* 令牌（Wong 色板，深色模式下会自动换成提亮版本），
#      线条用 currentColor + opacity，因此明暗两套主题都自动适配；
#   3. 只作视觉指引，语义信息仍由卡片文字承载，所以标 aria-hidden。
# 之所以要加：这是一门讲可视化的课，门户页本身却全靠文字介绍，说不过去。
_MOTIF_OPEN = ('<svg class="chapter-card__motif" viewBox="0 0 330 60" '
               'preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">')


def _motif_table():
    """第 1 章：数据 = 带类型的属性表。表头着色区分属性类型，下方是取值。"""
    cols = [("5", "--viz-2"), ("88", "--viz-1"), ("171", "--viz-3"), ("254", "--viz-6")]
    rows = []
    for x, color in cols:
        rows.append(f'<rect x="{x}" y="9" width="71" height="12" rx="3" fill="var({color})"/>')
        for y in (25, 36, 47):
            rows.append(f'<rect x="{x}" y="{y}" width="71" height="8" rx="2.5" '
                        f'fill="currentColor" opacity=".15"/>')
    return _MOTIF_OPEN + "".join(rows) + "</svg>"


def _motif_pipeline():
    """第 2 章：流程 = 四个阶段的节点链。箭头表示数据在阶段之间流动。"""
    nodes = [(5, "--viz-1"), (90, "--viz-5"), (175, "--viz-3"), (260, "--viz-4")]
    parts = []
    for i, (x, color) in enumerate(nodes):
        parts.append(f'<rect x="{x}" y="18" width="64" height="24" rx="7" '
                     f'fill="var({color})" fill-opacity=".16" '
                     f'stroke="var({color})" stroke-width="1.5"/>')
        if i < 3:
            ax = x + 64 + 4
            parts.append(f'<path d="M{ax} 25 L{ax + 8} 30 L{ax} 35 Z" '
                         f'fill="currentColor" opacity=".38"/>')
    return _MOTIF_OPEN + "".join(parts) + "</svg>"


def _motif_color():
    """第 3 章：色彩 = 色相带 + 明度渐变带。色相取本课程自己用的 Wong 六色。"""
    hues = ["--viz-1", "--viz-5", "--viz-3", "--viz-7", "--viz-2", "--viz-6"]
    parts = []
    for i, c in enumerate(hues):
        x = 5 + i * 53.3
        parts.append(f'<rect x="{x:.1f}" y="9" width="53.4" height="19" '
                     f'fill="var({c})"/>')
    parts.append('<defs><linearGradient id="motif-ch3-lum" x1="0" y1="0" x2="1" y2="0">'
                 '<stop offset="0" stop-color="#0b0e14"/>'
                 '<stop offset="1" stop-color="#ffffff"/></linearGradient></defs>')
    parts.append('<rect x="5" y="34" width="320" height="15" rx="2.5" '
                 'fill="url(#motif-ch3-lum)" opacity=".9"/>')
    return _MOTIF_OPEN + "".join(parts) + "</svg>"


def _motif_scatter():
    """第 4 章：低维数据 = 相关系数、聚类这些「按量级分组」的问题。"""
    a = [(30, 44), (46, 47), (58, 40), (72, 45), (86, 38), (40, 36), (64, 33)]
    b = [(198, 24), (218, 18), (238, 25), (262, 15), (284, 21), (206, 30), (250, 31)]
    pts = "".join(f'<circle cx="{x}" cy="{y}" r="3.2" fill="var(--viz-1)" opacity=".8"/>'
                  for x, y in a)
    pts += "".join(f'<circle cx="{x}" cy="{y}" r="3.2" fill="var(--viz-2)" opacity=".8"/>'
                   for x, y in b)
    axis = ('<path d="M14 7 V50 H322" fill="none" stroke="currentColor" '
            'stroke-width="1.5" opacity=".28"/>')
    return _MOTIF_OPEN + axis + pts + "</svg>"


def _motif_timeseries():
    """第 5 章：时序数据 = 折线在时间轴上的走势，阴影是其到基线的累积。"""
    line = "M14 43 L62 34 L110 39 L158 22 L206 29 L254 13 L322 20"
    area = line + " L322 51 L14 51 Z"
    return (_MOTIF_OPEN
            + f'<path d="{area}" fill="var(--viz-1)" opacity=".14"/>'
            + f'<path d="{line}" fill="none" stroke="var(--viz-1)" stroke-width="2.4" '
              'stroke-linejoin="round" stroke-linecap="round"/>'
            + '<path d="M14 51 H322" stroke="currentColor" stroke-width="1.5" opacity=".28"/>'
            + "</svg>")


CHAPTER_MOTIFS = {
    "01": _motif_table(),
    "02": _motif_pipeline(),
    "03": _motif_color(),
    "04": _motif_scatter(),
    "05": _motif_timeseries(),
}


def build_portal(all_sections, demo_counts):
    total_sections = sum(len(v) for v in all_sections.values())
    total_stars = sum(c["_stars"] for c in CHAPTERS)
    total_demos = sum(demo_counts.values())

    cards = []
    for ch in CHAPTERS:
        secs = all_sections[ch["id"]]
        tags = "".join(
            f'<li><span data-lang="zh">{s["title"]["zh"]}</span>'
            f'<span data-lang="en">{s["title"]["en"]}</span></li>' for s in secs
        )
        cards.append(f"""        <a class="chapter-card" href="{ch['slug']}/" data-progress-scope="c{ch['id']}s" data-progress-total="{len(secs)}">
          <span class="chapter-card__glow" aria-hidden="true"></span>
          {CHAPTER_MOTIFS[ch['id']]}
          <span class="chapter-card__top">
            <span class="chapter-card__num"><span data-lang="zh">第 {ch['num']} 章</span><span data-lang="en">Chapter {ch['num']}</span></span>
            <span class="chapter-card__progress" data-progress-out>0%</span>
          </span>
          <span class="chapter-card__title">
            <span data-lang="zh">{ch['title']['zh']}</span>
            <span data-lang="en">{ch['title']['en']}</span>
          </span>
          <span class="chapter-card__lead">
            <span data-lang="zh">{ch['lead']['zh']}</span>
            <span data-lang="en">{ch['lead']['en']}</span>
          </span>
          <ul class="chapter-card__tags">{tags}</ul>
          <span class="chapter-card__foot">
            <span>
              <span data-lang="zh">{len(secs)} 小节 · {demo_counts[ch['id']]} 个演示</span>
              <span data-lang="en">{len(secs)} sections · {demo_counts[ch['id']]} demos</span>
            </span>
            <span class="chapter-card__cta">
              <span data-lang="zh">进入章节 →</span><span data-lang="en">Open →</span>
            </span>
          </span>
          <span class="chapter-card__bar" aria-hidden="true">
            <span class="chapter-card__barfill" data-progress-bar style="width:0%"></span>
          </span>
        </a>""")

    # 第 6 格：5 章在 3 列网格里排成 3+2，右下角空出一个洞。
    # 与其让它空着，不如把「散在别处的入口」收进这一格 —— 术语表、补充 demo、
    # 独立实验原本只在页面最底「配套资源」那段文字里各占一行，学生走不到那儿。
    # 这一格不是章节，所以用虚线边框、不放进度条，视觉上明确区分。
    n_terms = len(json.loads(read(DATA / "glossary.json"))["terms"])
    n_supp = len([p for p in (ROOT / "supplementary").glob("*.html") if p.stem != "index"])
    n_lab = len(list((ROOT / "lesson-01" / "demo").glob("*/index.html")))
    cards.append(f"""        <div class="portal-extra">
          <span class="portal-extra__glow" aria-hidden="true"></span>
          <span class="portal-extra__label">
            <span data-lang="zh">速查与延伸</span><span data-lang="en">Reference</span>
          </span>
          <ul class="portal-extra__list">
            <li>
              <a href="glossary.html">
                <span class="portal-extra__name">
                  <span data-lang="zh">术语表</span><span data-lang="en">Glossary</span>
                </span>
                <span class="portal-extra__meta">
                  <span data-lang="zh">{n_terms} 个名词，每个都写了「容易在哪儿搞错」</span>
                  <span data-lang="en">{n_terms} terms, each with the usual pitfall</span>
                </span>
              </a>
            </li>
            <li>
              <a href="supplementary/">
                <span class="portal-extra__name">
                  <span data-lang="zh">补充 Demo</span><span data-lang="en">Extra demos</span>
                </span>
                <span class="portal-extra__meta">
                  <span data-lang="zh">{n_supp} 个页面，按图形类型排的独立示例</span>
                  <span data-lang="en">{n_supp} standalone pages grouped by chart type</span>
                </span>
              </a>
            </li>
            <li>
              <a href="lesson-01/demo/">
                <span class="portal-extra__name">
                  <span data-lang="zh">独立实验</span><span data-lang="en">Lab exercises</span>
                </span>
                <span class="portal-extra__meta">
                  <span data-lang="zh">{n_lab} 个自包含页面，可单独拷给学生改</span>
                  <span data-lang="en">{n_lab} self-contained pages, easy to hand out</span>
                </span>
              </a>
            </li>
          </ul>
          <span class="portal-extra__hint">
            <span data-lang="zh">或按 <kbd>Ctrl</kbd>+<kbd>K</kbd> 直接搜</span>
            <span data-lang="en">Or press <kbd>Ctrl</kbd>+<kbd>K</kbd> to search</span>
          </span>
        </div>""")

    roadmap = json.dumps({
        "nodes": [{"id": c["id"], "zh": c["title"]["zh"], "en": c["title"]["en"],
                   "num": c["num"]} for c in CHAPTERS],
        "edges": [["01", "02"], ["02", "04"], ["01", "03"], ["02", "03"], ["02", "05"]],
    }, ensure_ascii=False)

    tour = json.dumps(META["portalTour"], ensure_ascii=False)

    html = f"""{head("《可视化导论》· 课程门户",
               "中国石油大学（华东）《可视化导论》课程：案例驱动，零依赖，浏览器打开即用。",
               "", extra_css=("portal",), extra_js=("conceptmap", "portal"),
               path="/")}
<body id="top">
  <a class="skip-link" href="#main">跳到主要内容</a>

{topbar("", [(L("课程门户", "Home"), None)], "")}

{search_layer()}

  <main id="main">
    <section class="portal-hero">
      <svg class="portal-hero__art" viewBox="0 0 520 380" aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id="heroArea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--viz-1)" stop-opacity=".15" />
            <stop offset="100%" stop-color="var(--viz-1)" stop-opacity="0" />
          </linearGradient>
        </defs>
        <path d="M8 296 C64 282 96 214 148 198 S236 214 288 158 386 66 470 78 L520 82 L520 372 L8 372 Z"
              fill="url(#heroArea)" />
        <path d="M8 296 C64 282 96 214 148 198 S236 214 288 158 386 66 470 78"
              fill="none" stroke="var(--viz-1)" stroke-width="2" stroke-linecap="round" opacity=".75" />
        <g fill="var(--viz-2)" opacity=".8">
          <circle cx="58" cy="268" r="4" /><circle cx="112" cy="240" r="5" />
          <circle cx="188" cy="196" r="4" /><circle cx="246" cy="188" r="5" />
          <circle cx="312" cy="140" r="4" /><circle cx="372" cy="104" r="5" />
          <circle cx="428" cy="88" r="4" />
        </g>
        <g fill="var(--viz-3)" opacity=".5">
          <rect x="24" y="316" width="18" height="44" rx="3" />
          <rect x="56" y="300" width="18" height="60" rx="3" />
          <rect x="88" y="324" width="18" height="36" rx="3" />
          <rect x="120" y="286" width="18" height="74" rx="3" />
        </g>
        <g fill="none" stroke-width="9" stroke-linecap="round" opacity=".45">
          <path d="M470 214 A58 58 0 0 1 412 272" stroke="var(--viz-4)" />
          <path d="M404 292 A58 58 0 0 1 352 330" stroke="var(--viz-6)" />
          <path d="M340 300 A58 58 0 0 0 396 246" stroke="var(--viz-7)" />
        </g>
      </svg>
      <p class="page-head__eyebrow">{SITE['tag']}</p>
      <h1>
        <span data-lang="zh">《可视化导论》</span>
        <span data-lang="en">Introduction to Visualization</span>
      </h1>
      <p class="portal-hero__sub">
        <span data-lang="zh">{t(SITE['subtitle'], 'zh')}</span>
        <span data-lang="en">{t(SITE['subtitle'], 'en')}</span>
      </p>
      <p class="portal-hero__meta">
        <span data-lang="zh">{t(SITE['school'], 'zh')}</span>
        <span data-lang="en">{t(SITE['school'], 'en')}</span> ·
        <span data-lang="zh">授课教师</span><span data-lang="en">Instructor</span>
        <a href="{SITE['teacherUrl']}" target="_blank" rel="noopener">{SITE['teacher']}</a>
        · <span data-lang="zh">主要参考教材</span><span data-lang="en">Main textbook</span>
        <span data-lang="zh">{t(SITE['book'], 'zh')}</span>
        <span data-lang="en">{t(SITE['book'], 'en')}</span>
      </p>
      <div class="portal-hero__actions">
        <a class="btn btn--primary" href="lesson-01/">
          <span data-lang="zh">从第 1 章开始</span><span data-lang="en">Start with Chapter 1</span>
        </a>
        <button class="btn" type="button" data-search-open>
          <span data-lang="zh">检索知识点</span><span data-lang="en">Search concepts</span>
          <kbd>Ctrl K</kbd>
        </button>
        <button class="btn" type="button" data-tour-start>
          <span data-lang="zh">自动导览</span><span data-lang="en">Guided tour</span>
        </button>
      </div>
      <dl class="portal-stats">
        <div><dt><span data-lang="zh">章节</span><span data-lang="en">Chapters</span></dt><dd>{len(CHAPTERS)}</dd></div>
        <div><dt><span data-lang="zh">小节</span><span data-lang="en">Sections</span></dt><dd>{total_sections}</dd></div>
        <div><dt><span data-lang="zh">可运行演示</span><span data-lang="en">Live demos</span></dt><dd>{total_demos}</dd></div>
        <div><dt><span data-lang="zh">关键代码点</span><span data-lang="en">Key snippets</span></dt><dd>{total_stars}</dd></div>
      </dl>
    </section>

    <section class="portal-section" aria-labelledby="roadmap-title">
      <h2 id="roadmap-title" class="portal-section__title">
        <span data-lang="zh">课程主线</span><span data-lang="en">Course roadmap</span>
      </h2>
      <p class="portal-section__lead">
        <span data-lang="zh">五章不是并列的。先用「数据」把地基打好，再用「流程」把整条链路串起来，
        中间单列一章讲颜色，最后用「低维」和「时序」两类数据做实战。箭头表示建议的学习顺序。</span>
        <span data-lang="en">The five chapters form a path, not a list. Start with data,
        then the pipeline, take colour as a standalone topic, and finish with low-dimensional
        and time-series practice.</span>
      </p>
      <div class="roadmap" id="roadmap" role="img" aria-label="课程章节依赖关系图"></div>
      <p class="portal-section__hint">
        <span data-lang="zh">节点可以拖动：哪条箭头看不清楚，就把挡路的节点挪开；双击节点回到原位。</span>
        <span data-lang="en">Drag a node out of the way if an arrow is hard to follow; double-click it to snap back.</span>
      </p>
    </section>

{routes_html({c['id']: len(all_sections[c['id']]) for c in CHAPTERS})}

    <section class="portal-section" aria-labelledby="chapters-title">
      <h2 id="chapters-title" class="portal-section__title">
        <span data-lang="zh">全部章节</span><span data-lang="en">All chapters</span>
      </h2>
      <p class="portal-section__lead">
        <span data-lang="zh">每一章都是同一套结构：<strong>讲解</strong>看原理、
        <strong>关键代码</strong>看写法与坑、<strong>演示</strong>看实际效果，三个视图随时切换。</span>
        <span data-lang="en">Every chapter shares one structure: explain, key code and a live demo.</span>
      </p>
      <div class="chapter-grid">
{chr(10).join(cards)}
      </div>
    </section>

    <section class="portal-section" aria-labelledby="howto-title">
      <h2 id="howto-title" class="portal-section__title">
        <span data-lang="zh">怎么用这套材料</span><span data-lang="en">How to use this</span>
      </h2>
      <div class="howto-grid">
        <article class="howto-card">
          <h3><span data-lang="zh">学生在自学</span><span data-lang="en">Studying on your own</span></h3>
          <ol>
            <li><span data-lang="zh">读章首的「学完这一章你应该能够」，先知道要往哪去</span><span data-lang="en">Read the objectives first — know where you are going</span></li>
            <li><span data-lang="zh">按小节顺序过一遍讲解，遇到看不懂的看概念依赖图找到前置</span><span data-lang="en">Work through the sections in order; use the concept map to find prerequisites</span></li>
            <li><span data-lang="zh">对照关键代码，注意 ⭐ 标出的写法和旁边写的坑</span><span data-lang="en">Compare with the key code, and read the pitfalls marked ⭐</span></li>
            <li><span data-lang="zh">打开演示亲手改一改参数，看画面怎么变</span><span data-lang="en">Open the demo and change the parameters yourself</span></li>
          </ol>
        </article>
        <article class="howto-card">
          <h3><span data-lang="zh">教师在课堂</span><span data-lang="en">Teaching in class</span></h3>
          <ol>
            <li><span data-lang="zh">每章顶部有「自动导览」，可以按脚本把重点依次演一遍</span><span data-lang="en">Each chapter has a guided tour that walks the highlights in order</span></li>
            <li><span data-lang="zh">讲解 / 关键代码 / 演示三个视图随时切换，不必切窗口</span><span data-lang="en">Switch between explain, code and demo without leaving the page</span></li>
            <li><span data-lang="zh">演示都支持实时调参，适合现场提问「如果改成这样会怎样」</span><span data-lang="en">Demos are live — perfect for "what happens if we change this?"</span></li>
            <li><span data-lang="zh">按 <kbd>Ctrl</kbd>+<kbd>K</kbd> 可以直接跳到任意知识点</span><span data-lang="en">Press <kbd>Ctrl</kbd>+<kbd>K</kbd> to jump straight to any concept</span></li>
          </ol>
        </article>
        <article class="howto-card">
          <h3><span data-lang="zh">离线与局域网</span><span data-lang="en">Offline and LAN</span></h3>
          <ol>
            <li><span data-lang="zh">整个站点没有任何构建步骤，克隆下来就能跑</span><span data-lang="en">No build step at all — clone it and open it</span></li>
            <li><span data-lang="zh"><code>python -m http.server 8080</code> 起一个本地服务</span><span data-lang="en">Serve it with <code>python -m http.server 8080</code></span></li>
            <li><span data-lang="zh">同一 WiFi 下的设备用本机 IP 即可访问，适合机房环境</span><span data-lang="en">Other devices on the same Wi-Fi can use your local IP</span></li>
            <li><span data-lang="zh">D3.js 已内置在仓库里，断网也能跑完全部演示</span><span data-lang="en">D3 is bundled in the repo — every demo runs offline</span></li>
          </ol>
        </article>
        <article class="howto-card">
          <h3><span data-lang="zh">配套资源</span><span data-lang="en">More material</span></h3>
          <ol>
            <li><span data-lang="zh"><a href="supplementary/">补充 demo 集合</a>：与章节配合的独立示例</span><span data-lang="en"><a href="supplementary/">Extra demos</a> — standalone examples that pair with the chapters</span></li>
            <li><span data-lang="zh"><a href="glossary.html">术语表</a>：全课程名词的集中解释</span><span data-lang="en"><a href="glossary.html">Glossary</a> — every term in one place</span></li>
            <li><span data-lang="zh">每章都有完整讲义页，适合打印</span><span data-lang="en">Each chapter has a printable handout page</span></li>
            <li><span data-lang="zh">源码结构与重构说明见仓库 README 与 docs/</span><span data-lang="en">Structure and refactor notes live in README and docs/</span></li>
          </ol>
        </article>
      </div>
    </section>

    <section class="portal-section" aria-labelledby="about-title">
      <h2 class="portal-section__title" id="about-title">
        <span data-lang="zh">关于这门课</span><span data-lang="en">About</span>
      </h2>
      <p class="portal-section__lead">
        <span data-lang="zh">教材依据、内容取舍与实现方式。想知道某个结论出自哪篇论文，或者想把站子拿去改，看这里。</span>
        <span data-lang="en">Where the material comes from, what it is built on, and how to reuse it.</span>
      </p>
      <dl class="about-grid">
        <div>
          <dt><span data-lang="zh">理论来源</span><span data-lang="en">References</span></dt>
          <dd>
            <span data-lang="zh">陈为《可视化导论》。单点结论分别出自 Mackinlay 1986（视觉通道量化排序）、
            Stevens 1946（测量尺度）、Cleveland &amp; McGill 1985（图形感知）、
            Card 1999（数据流模型）、van Wijk 2005（交互反馈模型）、
            Bostock 的 D3 官方文档。</span>
            <span data-lang="en">Chen Wei, <i>Introduction to Visualization</i>. Individual claims come from
            Mackinlay 1986 (ranked visual channels), Stevens 1946 (scales of measurement),
            Cleveland &amp; McGill 1985 (graphical perception), Card 1999 (data-flow model),
            van Wijk 2005 (interaction loop), and Bostock's D3 documentation.</span>
          </dd>
        </div>
        <div>
          <dt><span data-lang="zh">设计原则</span><span data-lang="en">Approach</span></dt>
          <dd>
            <span data-lang="zh">以案例为中心，不以理论为中心。每个知识点都嵌在一个具体案例里讲，
            再配 <span class="star">⭐</span> 标出的关键代码与可直接改参数的演示 ——
            先看到东西动起来，再回头说它为什么这样动。</span>
            <span data-lang="en">Case-first, not theory-first. Every idea is introduced inside a concrete
            example, followed by a <span class="star">⭐</span> key-code block and a demo you can retune —
            see it move first, then explain why it moves that way.</span>
          </dd>
        </div>
        <div>
          <dt><span data-lang="zh">技术栈</span><span data-lang="en">Stack</span></dt>
          <dd>
            <span data-lang="zh">零依赖、零构建：纯 HTML + CSS + ES Modules，D3.js v7 走 CDN。
            <code>python -m http.server</code> 一条命令起站，不需要 npm。
            禁用 JavaScript 时正文仍然完整可读。</span>
            <span data-lang="en">No dependencies, no build step: plain HTML + CSS + ES Modules, with D3.js v7
            from a CDN. One <code>python -m http.server</code> is enough; no npm.
            The text stays fully readable with JavaScript disabled.</span>
          </dd>
        </div>
        <div>
          <dt><span data-lang="zh">数据集</span><span data-lang="en">Datasets</span></dt>
          <dd>
            <span data-lang="zh">新生数据、Crime 数据等已随仓库打包，浏览器直接 <code>fetch</code> 加载。
            除 D3 之外不请求任何外部资源，断网也能跑完全部章节。</span>
            <span data-lang="en">The freshman and crime datasets ship with the repository and are loaded with
            <code>fetch</code>. Apart from D3 nothing is requested externally, so every chapter works offline.</span>
          </dd>
        </div>
      </dl>
    </section>
  </main>

{site_footer("")}

  <script type="application/json" id="roadmap-data">{roadmap}</script>
  <script type="application/json" id="tour-data">{tour}</script>
{close_page(tour=True)}"""

    write(ROOT / "index.html", html)


# ============================================================ 主流程

def main():
    print("=" * 72)
    print("课程网站重构 · 内容管道")
    print("=" * 72)

    all_sections = {}
    print("\n[1/6] 抽取章节正文")
    # 先把 5 章的正文全部抽完：侧栏与门户要显示「每章多少小节」，
    # 如果边抽边建，第 1 章渲染时后面 4 章的数字还没算出来。
    for ch in CHAPTERS:
        secs = extract_sections(read(ORIGIN / f"{ch['slug']}.index.html"))
        ch["_sections"] = len(secs)
        ch["_stars"] = sum(s["stars"] for s in secs)
        ch["_section_data"] = secs
        all_sections[ch["id"]] = secs
        print(f"  · 第 {ch['num']} 章 {ch['title']['zh']}：{len(secs)} 小节，"
              f"{ch['_stars']} 处关键代码")

    print("\n[2/6] 装配章节页面")
    for ch in CHAPTERS:
        build_lesson(ch)
    print("  · 已完成 " + "、".join(f"lesson-{c['id']}" for c in CHAPTERS))

    print("\n[3/6] 抽取演示模块")
    demo_counts = build_demos()

    print("\n[4/6] 生成门户页")
    build_portal(all_sections, demo_counts)

    print("\n[5/6] 生成搜索索引与配套页面")
    index = build_search_index(all_sections)
    write(ROOT / "assets" / "search-index.json",
          json.dumps(index, ensure_ascii=False, separators=(",", ":")))
    print(f"  · {len(index)} 条索引")

    build_supplementary()
    build_404()
    build_glossary(all_sections)

    print("\n[6/7] 修复补充 Demo 与第 1 章独立演示")
    sys.path.insert(0, str(ROOT / "tools"))
    import build_supp
    build_supp.main()

    print("\n[7/7] 清理原站遗留")
    cleanup_legacy()

    print("\n完成。")


# ============================================================ 补充 demo 集合
# 原索引里有两个「指向不存在文件」的条目：
#   · yearcalendar.html   —— 文件压根没有（本次补上，van Wijk 日历热图）
#   · volumeRendering.html —— 只有一份 163 行的 WebGL 工具函数，缺 .raw 数据，
#                             且从未接线，本次从索引中移除，不假装它存在
# 另外原页面引用 ../portal/styles.css（不存在）与 ../i18n.css（已废弃）。

SUPP_GROUPS = [
    ("01", "第 1 章 · 数据", "对应 1.1 数据生成、1.5 数据选择器", [
        ("tableshow.html", "新生数据表格展示", "d3.csv → renderTable，看数据怎么落到 DOM 上"),
        ("newstudent.html", "新生年龄分布饼图", "d3.rollup 聚合 + d3.arc 画弧"),
    ]),
    ("02", "第 2 章 · 数据可视化流程", "对应 2.3 视觉映射、2.4 渲染与交互", [
        ("treelist.html", "可展开 / 折叠的树形列表", "d3-hierarchy + 事件委托"),
        ("nssystem.html", "新生数据管理系统", "树 + 表格联动 + 搜索，一个综合案例"),
    ]),
    ("03", "第 3 章 · 色彩专题", "对应 3.5 科研经典配色", [
        ("sex_compare.html", "性别数据对比条形图", "双系列 + 颜色编码"),
    ]),
    ("04", "第 4 章 · 低维数据可视化", "对应 4.1 数据转换、4.3 曲线拟合、4.5 等值线", [
        ("crime1985.html", "1985 美国犯罪数据性别差异", "d3-regression 散点 + 回归线"),
        ("regression.html", "d3-regression 最小示例", "只保留回归本身，方便对照"),
        ("colormap.html", "terrain colormap 热力图", "10×10 网格 + interpolateViridis"),
        ("mark.html", "10×10 标记法", "按数值大小画方块"),
        ("contour.html", "移动四边形法等值线", "自己实现 Marching Squares"),
        ("contourd3.html", "D3 内置 d3-contour", "与上一个对照，看内置实现怎么省事"),
    ]),
    ("05", "第 5 章 · 时序数据可视化", "对应 5.3 日历热图、5.4 周期时间", [
        ("yearcalendar.html", "van Wijk 日历热图", "年 = 行 / 周 = 列，把 4 年数据放进一张图"),
        ("calendar.html", "2008 螺旋时间轴日历", "基础版"),
        ("calendar1.html", "2008 螺旋时间轴日历（变体 1）", "调整参数后的样子"),
        ("calendar3.html", "2008 螺旋时间轴日历（变体 3）", "再一种布局变体"),
    ]),
]


def build_supplementary():
    blocks = []
    for cid, title, hint, demos in SUPP_GROUPS:
        cards = "".join(
            f"""          <li><a class="demo-card" href="{f}">
            <span class="demo-card__file">{f}</span>
            <span class="demo-card__name">{name}</span>
            <span class="demo-card__desc">{desc}</span>
          </a></li>"""
            for f, name, desc in demos
        )
        blocks.append(f"""      <section class="supp-group" aria-labelledby="supp-{cid}">
        <div class="supp-group__head">
          <h2 id="supp-{cid}">{title}</h2>
          <span class="supp-group__hint">{hint}</span>
          <span class="supp-group__count">{len(demos)} 个示例</span>
        </div>
        <ul class="demo-grid">
{cards}
        </ul>
      </section>""")

    html = f"""{head("补充 Demo 集合 · 《可视化导论》",
               "与《可视化导论》各章配合的独立可运行示例，含表格、树形列表、回归拟合、等值线与时间日历。",
               "../", extra_css=("portal",), path="/supplementary/")}
<body id="top">
  <a class="skip-link" href="#main">跳到主要内容</a>

{topbar("../", [(L("课程门户", "Home"), "../"), (L("补充 Demo 集合", "Extra demos"), None)], "")}

{search_layer()}

  <div class="shell shell--wide">
    <main class="main" id="main">
      <div class="page-head">
        <p class="page-head__eyebrow">Supplementary demos</p>
        <h1>补充 Demo 集合</h1>
        <p class="page-head__lead">
          这些示例原本是独立的小页面，用来配合对应章节讲解。
          每一个都能单独打开、单独修改、单独打包给学生 —— 这是原课程设计里很好的一点，重构后保留了。
        </p>
      </div>

      <div class="supp-note">
        <p>下面每个示例都在新标签页中打开。所有示例运行时不依赖本站的其他资源，可以直接拷走单独使用。</p>
        <p>想按课程顺序学，请回到 <a href="../">课程门户</a>；
           想查某个名词，看 <a href="../glossary.html">术语表</a>。</p>
      </div>

{chr(10).join(blocks)}

      <section class="supp-group" aria-labelledby="supp-extra">
        <div class="supp-group__head">
          <h2 id="supp-extra">其他资料</h2>
        </div>
        <ul class="demo-grid">
          <li><a class="demo-card" href="5. 低维数据可视化.pdf" download>
            <span class="demo-card__file">PDF</span>
            <span class="demo-card__name">低维数据可视化（讲义 PDF）</span>
            <span class="demo-card__desc">原课程附带的章节资料</span>
          </a></li>
        </ul>
      </section>
    </main>
  </div>

{site_footer("../")}
{close_page()}"""

    write(ROOT / "supplementary" / "index.html", html)


# ============================================================ 404

# 404 页专用：把站点根算出来再补 href。
# 单独放字符串常量而不是塞进 f-string，是为了避免 JS 里的大量花括号和 Python 的
# f-string 占位符打架（要么到处写 {{ }}，要么像现在这样分开放）。
ROOT_SCRIPT = """  <script>
    /* 只有 404 页需要这一段。GitHub Pages 把 404.html 部署在站点根，但浏览器地址栏
       里保留的仍然是「没找到的那个路径」，于是页面上所有相对地址都会被按缺失路径
       解析 —— 访问 /a/b/c/ 时，页面里写的 assets/css/tokens.css 会变成
       /a/b/c/assets/css/tokens.css，favicon、样式、脚本全部 404，页面裸奔。

       做法分三步：
       1. 从当前路径逐级向上，找第一个真的能取到 assets/css/tokens.css 的层级，
          那就是站点根。覆盖三种情形：域根、子路径（如 /Rebuild-ct-web/）、本地预览。
       2. 把它写成 <base>。此后文档里所有相对地址都按它解析，不用逐个去改。
       3. 补两个 <base> 管不到的：站内链接用的是 data-root-link（没有 href 可解析），
          以及 "#main" 这类纯片段链接会被 <base> 带偏到站点根（会跳去首页）。 */
    (function () {
      var segs = location.pathname.split("/").filter(Boolean);
      // 直接访问 404.html 时，最后一段是文件名而不是「缺失的目录名」，
      // 拿它去拼路径只会多打一次注定 404 的请求，先摘掉。
      if (/\\.[a-z0-9]{1,6}$/i.test(segs[segs.length - 1] || "")) segs.pop();

      var base = "/", i, cand, x;
      for (i = segs.length; i >= 0; i--) {
        cand = "/" + segs.slice(0, i).join("/") + (i ? "/" : "");
        try {
          x = new XMLHttpRequest();
          x.open("GET", cand + "assets/css/tokens.css", false);
          x.send(null);
          if (x.status === 200) { base = cand; break; }
        } catch (e) {}
      }

      // appendChild 而不是插到最前面：<meta charset> 必须留在文档开头。
      var b = document.createElement("base");
      b.href = base;
      document.head.appendChild(b);

      document.addEventListener("DOMContentLoaded", function () {
        document.querySelectorAll("[data-root-link]").forEach(function (el) {
          var url = base + el.getAttribute("data-root-link");
          el.setAttribute(el.tagName === "SCRIPT" ? "src" : "href", url);
        });
        document.querySelectorAll('a[href^="#"]').forEach(function (a) {
          a.setAttribute("href", location.href.split("#")[0] + a.getAttribute("href"));
        });
      });
    })();
  </script>"""


def build_404():
    """生成 404 页。

    GitHub Pages 会把这个文件部署在**站点根目录**，但浏览器地址栏里保留的仍然是
    「没找到的那个路径」。这带来两个陷阱：

      · 写相对链接（`assets/css/...`）——浏览器会按「缺失路径」当基准去解析，必错；
      · 写站点根绝对链接（`/glossary.html`）——本地 `http.server` 下是对的，
        但部署到 `https://<user>.github.io/vis/` 后 `/glossary.html` 指向域根，同样 404。

    所以在页面前面放一段极短的同步探测：从当前路径逐级向上，找第一个真的能取到
    `assets/css/tokens.css` 的层级，那就是站点根。只在这一个页面上跑，代价可以接受，
    而且它对「部署在域根」「部署在子路径」「本地预览」三种情况都成立。
    """
    links = "".join(
        f'          <li><a data-root-link="{c["slug"]}/">第 {c["num"]} 章 {c["title"]["zh"]}'
        f'<span>{len(c["objectives"]["zh"])} 项目标</span></a></li>'
        for c in CHAPTERS
    )
    html = f"""{head("页面不存在 · 《可视化导论》",
               "没有找到这个页面。下面是可以去的地方。", "",
               extra_css=("portal",), root_probe=True, path=None)}
<body id="top">
  <a class="skip-link" href="#main">跳到主要内容</a>
{topbar("@", [(L("课程门户", "Home"), None)], "")}
{search_layer()}
  <main class="shell shell--wide" id="main" style="display:block">
    <div class="page-head">
      <p class="page-head__eyebrow">Error 404</p>
      <h1>这个地址没有对应的页面</h1>
      <p class="page-head__lead">
        可能链接过期了，也可能网址打错了。下面几个入口应该能帮你找到想找的内容。
      </p>
    </div>
    <ul class="demo-grid">
      <li><a class="demo-card" data-root-link="">
        <span class="demo-card__file">HOME</span>
        <span class="demo-card__name">课程门户</span>
        <span class="demo-card__desc">五章总览与课程主线</span></a></li>
      <li><a class="demo-card" data-root-link="supplementary/">
        <span class="demo-card__file">DEMO</span>
        <span class="demo-card__name">补充 Demo 集合</span>
        <span class="demo-card__desc">独立可运行的配套示例</span></a></li>
      <li><a class="demo-card" data-root-link="glossary.html">
        <span class="demo-card__file">TERM</span>
        <span class="demo-card__name">术语表</span>
        <span class="demo-card__desc">全课程名词解释</span></a></li>
    </ul>
    <h2 class="portal-section__title" style="margin-top:2.5rem">或者直接去某一章</h2>
    <ul class="chapter-list">
{links}
    </ul>
  </main>
{site_footer("")}
{close_page()}"""
    write(ROOT / "404.html", html)


# ============================================================ 术语表

def build_glossary(all_sections):
    data = json.loads(read(DATA / "glossary.json"))
    items = []
    usage = term_usage(all_sections)
    for term in data["terms"]:
        ch = next(c for c in CHAPTERS if c["id"] == term["ch"])
        seen = usage.get(term["id"], [])
        shown = seen[:4]
        links = " ".join(
            f'<a href="{c["slug"]}/index.html#sec-{s["id"]}">{s["num"]}</a>'
            for c, s in shown
        )
        more = f'<span class="term-card__more">等 {len(seen)} 处</span>' if len(seen) > 4 else ""
        seen_html = (f"""
          <p class="term-card__seen">
            <span data-lang="zh">出现在</span><span data-lang="en">Appears in</span>{links}{more}
          </p>""" if seen else "")
        items.append(f"""        <li class="term-card" id="term-{term['id']}" data-term-ch="{term['ch']}">
          <div class="term-card__head">
            <h2><span class="term-card__zh">{term['zh']}</span><span class="term-card__en">{term['en']}</span></h2>
            <a class="term-card__src" href="{ch['slug']}/">
              <span data-lang="zh">第 {ch['num']} 章 {ch['title']['zh']}</span>
              <span data-lang="en">Ch. {ch['num']} {ch['title']['en']}</span>
            </a>
          </div>
          <p class="term-card__def">
            <span data-lang="zh">{term['zh_def']}</span>
            <span data-lang="en">{term['en_def']}</span>
          </p>
          <p class="term-card__why">
            <span data-lang="zh">{term['zh_why']}</span>
            <span data-lang="en">{term['en_why']}</span>
          </p>{seen_html}
        </li>""")

    html = f"""{head("术语表 · 《可视化导论》",
               "《可视化导论》全课程术语表：每个名词给出定义，并说明它为什么重要、容易在哪儿搞错。",
               "", extra_css=("portal",), path="/glossary.html")}
<body id="top">
  <a class="skip-link" href="#main">跳到主要内容</a>

{topbar("", [(L("课程门户", "Home"), "./"), (L("术语表", "Glossary"), None)], "")}

{search_layer()}

  <div class="shell shell--wide">
    <main class="main" id="main">
      <div class="page-head">
        <p class="page-head__eyebrow">Glossary</p>
        <h1>
          <span data-lang="zh">术语表</span>
          <span data-lang="en">Glossary</span>
        </h1>
        <p class="page-head__lead">
          <span data-lang="zh">按章节顺序排列。每个词条除了「是什么」，还写了「为什么重要」——
          名词表最容易变成一份背了也没用的清单，加上后半句才有意义。</span>
          <span data-lang="en">Ordered by chapter. Each entry says what the term is and why it
          matters — a bare list of definitions is something you memorise and forget.</span>
        </p>
      </div>

      <div class="term-filter" role="group" aria-label="按章节筛选">
        <button type="button" data-term-filter="all" aria-pressed="true">
          <span data-lang="zh">全部 {len(data['terms'])}</span>
          <span data-lang="en">All {len(data['terms'])}</span>
        </button>
        {''.join(f'''<button type="button" data-term-filter="{c['id']}" aria-pressed="false"><span data-lang="zh">第 {c['num']} 章</span><span data-lang="en">Ch. {c['num']}</span></button>''' for c in CHAPTERS)}
      </div>

      <ul class="term-list">
{chr(10).join(items)}
      </ul>
    </main>
  </div>

{site_footer("")}
  <script type="module">
    document.querySelectorAll("[data-term-filter]").forEach(btn => {{
      btn.addEventListener("click", () => {{
        const k = btn.getAttribute("data-term-filter");
        document.querySelectorAll("[data-term-filter]").forEach(b =>
          b.setAttribute("aria-pressed", String(b === btn)));
        document.querySelectorAll(".term-card").forEach(card => {{
          const show = k === "all" || card.getAttribute("data-term-ch") === k;
          card.style.display = show ? "" : "none";
        }});
      }});
    }});
  </script>
{close_page()}"""
    write(ROOT / "glossary.html", html)


# ============================================================ 清理原站遗留

LEGACY = [
    "i18n.js", "i18n.css", "styles.css",
    "supplementary/i18n.js", "supplementary/i18n.css",
    "lesson-01/build_en.py",
]
LEGACY_GLOB = [
    "lesson-0*/styles.css", "lesson-0*/lesson.js",
    "lesson-0*/zh_blocks.json", "lesson-0*/en_blocks.json",
]


def cleanup_legacy():
    removed = 0
    freed = 0
    for rel in LEGACY:
        p = ROOT / rel
        if p.exists():
            freed += p.stat().st_size
            if not CHECK_ONLY:
                p.unlink()
            removed += 1
            print(f"  · 移除 {rel}")
    for pattern in LEGACY_GLOB:
        for p in ROOT.glob(pattern):
            freed += p.stat().st_size
            if not CHECK_ONLY:
                p.unlink()
            removed += 1
    print(f"  · 共移除 {removed} 个已被取代的文件，释放 {freed / 1024:.0f} KB")


# 入口放在文件最后：main() 会调用前面所有构建函数，必须等它们都定义完再执行
if __name__ == "__main__":
    main()
