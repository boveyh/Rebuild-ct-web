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
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ORIGIN = ROOT / "tools" / "origin"
DATA = ROOT / "tools" / "data"

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

RESOURCE_DIR = ROOT / "supplementary"


def t(pair, lang="zh"):
    if isinstance(pair, dict):
        return pair.get(lang) or pair.get("zh") or ""
    return pair or ""


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
        key = h2.group("key") if h2 else None
        zh_title = ZH.get(key + ".title") if key else None
        en_title = EN.get(key + ".title") if key else None
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
            "stars": panels.get("code", "").count('class="star"'),
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

def head(title, desc, depth, extra_css=(), extra_js=(), theme_color="#3d4bc0"):
    """depth = 相对站点根目录的层级，'../' 或 ''"""
    up = depth
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
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>{title}</title>
  <meta name="description" content="{desc}" />
  <meta name="theme-color" content="{theme_color}" />
  <link rel="icon" href="{up}favicon.svg" type="image/svg+xml" />
  <meta property="og:title" content="{title}" />
  <meta property="og:description" content="{desc}" />
  <meta property="og:type" content="website" />
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


def topbar(depth, crumbs, current, lang_toggle=True):
    """顶栏：侧栏开关 + 品牌 + 面包屑 + 搜索 / 主题 / 语言"""
    up = depth
    crumb_html = []
    for i, (label, href) in enumerate(crumbs):
        last = i == len(crumbs) - 1
        if last:
            crumb_html.append(f'<li><span aria-current="page">{label}</span></li>')
        else:
            crumb_html.append(f'<li><a href="{href}">{label}</a></li>')
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

      <a class="topbar__brand" href="{up}">
        {BRAND_MARK}<span class="brand-text">可视化导论</span>
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
        scope = f' data-progress-scope="c{c["id"]}s"'
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
    <div class="sidebar-scrim" id="sidebar-scrim" data-open="false" hidden-a11y="true"></div>"""


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
    tour_bar = ""
    if tour:
        tour_bar = """
  <div class="tour-bar" id="tour-bar" data-open="false" role="region" aria-label="自动导览">
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
  </div>"""
    return f"""{tour_bar}
</body>
</html>
"""


# ============================================================ 小节装配

def panel_html(section, name):
    sid = section["id"]
    pid = f"p-{sid}-{name}"
    inner = section["panels"].get(name, "").strip()
    if name == "demo":
        if section.get("demo"):
            inner = (f'<div class="demo-mount" data-demo-chapter="{sid.split("-")[1]}" '
                     f'data-demo="{section["demo"]}"></div>\n' + inner)
        elif not inner:
            inner = ('<p class="demo-hint">本小节没有配套演示，请参考左侧「补充 demo 集合」里的'
                     '独立示例。</p>')
    return (f'        <div class="tab-panel" id="{pid}" data-panel="{name}" role="tabpanel"\n'
            f'             aria-labelledby="t-{sid}-{name}" data-active="false">\n'
            f'{indent(inner, 10)}\n        </div>')


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
               data-progress-key="c{sid.split('-')[1]}s{section['num'].split('.')[-1]}"
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
          <div class="objectives__meta">
            <span>{len(ch['objectives']['zh'])} 项目标</span>
            <span>约 {ch['minutes']} 分钟</span>
            <span>{ch['_sections']} 个小节</span>
            <span>{ch['_stars']} 处关键代码</span>
          </div>
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

def build_lesson(ch):
    slug = ch["slug"]
    raw = read(ORIGIN / f"{slug}.index.html")
    sections = extract_sections(raw)
    ch["_sections"] = len(sections)
    ch["_stars"] = sum(s["stars"] for s in sections)

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
                  f'<span class="lesson-pager__title">第 {prev_ch["num"]} 章 {prev_ch["title"]["zh"]}</span></a>')
    pager_next = ('<span class="lesson-pager__spacer"></span>' if not next_ch else
                  f'<a class="lesson-pager__link lesson-pager__link--next" href="../{next_ch["slug"]}/">'
                  f'<span class="lesson-pager__label" data-i18n="nav.next">下一节</span>'
                  f'<span class="lesson-pager__title">第 {next_ch["num"]} 章 {next_ch["title"]["zh"]}</span></a>')

    html = f"""{head(title, desc, "../", extra_js=("conceptmap", "lesson"))}
<body id="top">
  <a class="skip-link" href="#main">跳到主要内容</a>

{topbar("../", [("课程门户", "../"), (f"第 {ch['num']} 章 {ch['title']['zh']}", None)], slug)}

{search_layer()}

  <div class="shell">
{sidebar(CHAPTERS, slug, sections)}

    <main class="main" id="main">
      <div class="content">
        <div class="page-head">
          <p class="page-head__eyebrow">Chapter {ch['num']:0>2} · {ch['title']['en']}</p>
          <h1>第 {ch['num']} 章 {ch['title']['zh']}</h1>
          <p class="page-head__lead">
            <span data-lang="zh">{ch['lead']['zh']}</span>
            <span data-lang="en">{ch['lead']['en']}</span>
          </p>
          <div class="page-head__meta">
            <dl><dt>来源</dt><dd>{ch['source']['zh']}</dd></dl>
            <dl><dt>时长</dt><dd>约 {ch['minutes']} 分钟</dd></dl>
            <dl><dt>小节</dt><dd>{ch['_sections']}</dd></dl>
            <dl><dt>关键代码</dt><dd>{ch['_stars']} 处</dd></dl>
          </div>
        </div>

{objectives_html(ch)}

        <figure class="figure">
          <div class="figure__frame" id="concept-map" role="img"
               aria-label="本章概念依赖图"></div>
          <figcaption>
            <span data-lang="zh">本章知识点的依赖关系。箭头表示「先理解前者，才容易理解后者」。</span>
            <span data-lang="en">Dependencies between the concepts in this chapter.</span>
          </figcaption>
        </figure>

{chr(10).join(section_html(s, "explain" if i == 0 else None) for i, s in enumerate(sections))}

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

    write(ROOT / slug / "index.html", html)

    # 讲义：把 markdown 渲染成 HTML，取代原来「下载一个 .md」的做法
    md = ROOT / slug / "lecture.md"
    if md.exists():
        write(ROOT / slug / "lecture.html", build_lecture(ch, read(md), sections))
    return sections


def build_lecture(ch, md_text, sections):
    """讲义页：完整 markdown 版正文，供打印与离线阅读。"""
    body = markdown(md_text)
    toc = "\n".join(
        f'          <li><a class="sidebar__link" href="#{s["id"]}">'
        f'<span class="sidebar__num">{s["num"]}</span>'
        f'<span class="sidebar__text">{s["title"]["zh"]}</span></a></li>'
        for s in sections
    )
    html = f"""{head(f"第 {ch['num']} 章 讲义 · 《可视化导论》", re.sub(r"\\s+", " ", ch['lead']['zh'])[:110], "../")}
<body id="top">
  <a class="skip-link" href="#main">跳到主要内容</a>

{topbar("../", [("课程门户", "../"), (f"第 {ch['num']} 章 {ch['title']['zh']}", f"../{ch['slug']}/"), ("讲义", None)], ch['slug'])}

{search_layer()}

  <div class="shell">
    <aside class="sidebar" id="sidebar" data-open="false" aria-label="讲义目录">
      <nav class="sidebar__group">
        <div class="sidebar__title">{ch['title']['zh']} · 讲义</div>
        <ul class="sidebar__list">
{toc}
          <li><a class="sidebar__link" href="../{ch['slug']}/">
            <span class="sidebar__text">← 返回交互版章节页</span></a></li>
        </ul>
      </nav>
    </aside>
    <div class="sidebar-scrim" id="sidebar-scrim" data-open="false" hidden-a11y="true"></div>

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


def markdown(text: str) -> str:
    lines = text.split("\n")
    out = []
    i = 0
    n = len(lines)

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
            out.append(f'<div class="code-block"><pre><code class="lang-{lang}">'
                       f'{code}</code></pre></div>')
            continue

        if re.match(r"^#{1,6}\s", line):
            level = len(line) - len(line.lstrip("#"))
            txt = line[level:].strip()
            anchor = re.sub(r"[^\w\u4e00-\u9fff]+", "-", txt).strip("-").lower()
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
            th = "".join(f"<th>{md_inline(c)}</th>" for c in head)
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


def build_demos():
    counts = {}
    for ch in CHAPTERS:
        cid = ch["id"]
        src = read(ROOT / ch["slug"] / "lesson.js")
        original_size = len(src.encode("utf-8"))
        n_reg = len(re.findall(r'DEMOS\["', src))

        src = strip_js_functions(src, NAV_FUNCS)
        # 摘掉对已删除函数的顶层调用
        src = re.sub(r"^[ \t]*__bindLessonNav\(\);[ \t]*\n", "", src, flags=re.M)
        src = re.sub(r"^[ \t]*__renderAllDemos\(\);[ \t]*\n", "", src, flags=re.M)
        src = re.sub(r"^[ \t]*queueMicrotask\(\(\) => __renderAllDemos\(\)\);[ \t]*\n",
                     "", src, flags=re.M)
        # 把全局注册表收进模块作用域，避免跨章同名冲突
        src = re.sub(r"window\.DEMOS\s*=\s*window\.DEMOS\s*\|\|\s*\{\};", "const DEMOS = {};", src)
        src = re.sub(r"(?:window|globalThis)\.DEMOS\s*\[\s*", "DEMOS[", src)
        # 删掉残留的「传给已删除函数」的调用
        src = re.sub(r"^[ \t]*const mount = .*__[a-zA-Z]+\(.*\);[ \t]*\n", "", src, flags=re.M)

        leftovers = [fn for fn in NAV_FUNCS if fn in src]
        if leftovers:
            print(f"  ! 第 {ch['num']} 章演示模块仍引用: {leftovers}")

        assert "import * as d3" in src, f"lesson-{cid} 缺少 d3 导入"

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

    return entries


# ============================================================ 门户页

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
        cards.append(f"""        <a class="chapter-card" href="{ch['slug']}/" data-progress-scope="c{ch['id']}s">
          <span class="chapter-card__glow" aria-hidden="true"></span>
          <span class="chapter-card__top">
            <span class="chapter-card__num">第 {ch['num']} 章</span>
            <span class="chapter-card__progress" data-progress-out>0%</span>
          </span>
          <span class="chapter-card__title">{ch['title']['zh']}</span>
          <span class="chapter-card__lead">
            <span data-lang="zh">{ch['lead']['zh']}</span>
            <span data-lang="en">{ch['lead']['en']}</span>
          </span>
          <ul class="chapter-card__tags">{tags}</ul>
          <span class="chapter-card__foot">
            <span>{len(secs)} 小节 · 约 {ch['minutes']} 分钟</span>
            <span class="chapter-card__cta">进入章节 →</span>
          </span>
          <span class="chapter-card__bar" aria-hidden="true">
            <span class="chapter-card__barfill" data-progress-bar style="width:0%"></span>
          </span>
        </a>""")

    roadmap = json.dumps({
        "nodes": [{"id": c["id"], "zh": c["title"]["zh"], "en": c["title"]["en"],
                   "num": c["num"]} for c in CHAPTERS],
        "edges": [["01", "02"], ["02", "04"], ["01", "03"], ["02", "03"], ["02", "05"]],
    }, ensure_ascii=False)

    tour = json.dumps(META["portalTour"], ensure_ascii=False)

    html = f"""{head("《可视化导论》· 课程门户",
               "中国石油大学（华东）《可视化导论》课程：案例驱动，零依赖，浏览器打开即用。",
               "", extra_js=("conceptmap", "portal"))}
<body id="top">
  <a class="skip-link" href="#main">跳到主要内容</a>

{topbar("", [("课程门户", None)], "")}

{search_layer()}

  <main id="main">
    <section class="portal-hero">
      <p class="page-head__eyebrow">{SITE['tag']}</p>
      <h1>《可视化导论》</h1>
      <p class="portal-hero__sub">{t(SITE['subtitle'])}</p>
      <p class="portal-hero__meta">
        {t(SITE['school'])} · 授课教师
        <a href="{SITE['teacherUrl']}" target="_blank" rel="noopener">{SITE['teacher']}</a>
        · 主要参考教材 {t(SITE['book'])}
      </p>
      <div class="portal-hero__actions">
        <a class="btn btn--primary" href="lesson-01/">
          <span data-lang="zh">从第 1 章开始</span><span data-lang="en">Start with Chapter 1</span>
        </a>
        <button class="btn" type="button" data-search-open>
          <span data-lang="zh">检索知识点</span><span data-lang="en">Search concepts</span>
          <kbd>Ctrl K</kbd>
        </button>
        <button class="btn" type="button" id="tour-play">
          <span data-lang="zh">自动导览</span><span data-lang="en">Guided tour</span>
        </button>
      </div>
      <dl class="portal-stats">
        <div><dt>章节</dt><dd>{len(CHAPTERS)}</dd></div>
        <div><dt>小节</dt><dd>{total_sections}</dd></div>
        <div><dt>可运行演示</dt><dd>{total_demos}</dd></div>
        <div><dt>关键代码点</dt><dd>{total_stars}</dd></div>
        <div><dt>预计总时长</dt><dd>{SITE['totalMinutes']} 分</dd></div>
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
    </section>

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
          <h3>学生在自学</h3>
          <ol>
            <li>读章首的「学完这一章你应该能够」，先知道要往哪去</li>
            <li>按小节顺序过一遍讲解，遇到看不懂的看概念依赖图找到前置</li>
            <li>对照关键代码，注意 ⭐ 标出的写法和旁边写的坑</li>
            <li>打开演示亲手改一改参数，看画面怎么变</li>
          </ol>
        </article>
        <article class="howto-card">
          <h3>教师在课堂</h3>
          <ol>
            <li>每章顶部有「自动导览」，可以按脚本把重点依次演一遍</li>
            <li>讲解 / 关键代码 / 演示三个视图随时切换，不必切窗口</li>
            <li>演示都支持实时调参，适合现场提问「如果改成这样会怎样」</li>
            <li>按 <kbd>Ctrl</kbd>+<kbd>K</kbd> 可以直接跳到任意知识点</li>
          </ol>
        </article>
        <article class="howto-card">
          <h3>离线与局域网</h3>
          <ol>
            <li>整个站点没有任何构建步骤，克隆下来就能跑</li>
            <li><code>python -m http.server 8080</code> 起一个本地服务</li>
            <li>同一 WiFi 下的设备用本机 IP 即可访问，适合机房环境</li>
            <li>除 D3.js 走 CDN 之外没有外部依赖</li>
          </ol>
        </article>
        <article class="howto-card">
          <h3>配套资源</h3>
          <ol>
            <li><a href="supplementary/">补充 demo 集合</a>：与章节配合的独立示例</li>
            <li><a href="glossary.html">术语表</a>：全课程名词的集中解释</li>
            <li>每章都有完整讲义页，适合打印</li>
            <li>源码结构与重构说明见仓库 README 与 docs/</li>
          </ol>
        </article>
      </div>
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
    for ch in CHAPTERS:
        secs = build_lesson(ch)
        all_sections[ch["id"]] = secs
        print(f"  · 第 {ch['num']} 章 {ch['title']['zh']}：{len(secs)} 小节，"
              f"{ch['_stars']} 处关键代码")
    print("  统计：", json.dumps({c["id"]: {"sections": c["_sections"], "stars": c["_stars"]}
                                for c in CHAPTERS}, ensure_ascii=False))

    print("\n[2/6] 抽取演示模块")
    demo_counts = build_demos()

    print("\n[3/6] 生成门户页")
    build_portal(all_sections, demo_counts)

    print("\n[4/6] 生成搜索索引")
    index = build_search_index(all_sections)
    write(ROOT / "assets" / "search-index.json",
          json.dumps(index, ensure_ascii=False, separators=(",", ":")))
    print(f"  · {len(index)} 条索引")

    print("\n[5/6] 生成配套页面")
    build_404()
    build_glossary(all_sections)

    print("\n[6/6] 清理原站遗留")
    cleanup_legacy()

    print("\n完成。")


if __name__ == "__main__":
    main()


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
               "../", extra_css=("portal",))}
<body id="top">
  <a class="skip-link" href="#main">跳到主要内容</a>

{topbar("../", [("课程门户", "../"), ("补充 Demo 集合", None)], "")}

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

def build_404():
    links = "".join(
        f'          <li><a href="{c["slug"]}/">第 {c["num"]} 章 {c["title"]["zh"]}'
        f'<span>{len(c["objectives"]["zh"])} 项目标</span></a></li>'
        for c in CHAPTERS
    )
    html = f"""{head("页面不存在 · 《可视化导论》",
               "没有找到这个页面。下面是可以去的地方。", "")}
<body id="top">
  <a class="skip-link" href="#main">跳到主要内容</a>
{topbar("", [("课程门户", "/")], "")}
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
      <li><a class="demo-card" href="/index.html">
        <span class="demo-card__file">HOME</span>
        <span class="demo-card__name">课程门户</span>
        <span class="demo-card__desc">五章总览与课程主线</span></a></li>
      <li><a class="demo-card" href="/supplementary/">
        <span class="demo-card__file">DEMO</span>
        <span class="demo-card__name">补充 Demo 集合</span>
        <span class="demo-card__desc">独立可运行的配套示例</span></a></li>
      <li><a class="demo-card" href="/glossary.html">
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
    for term in data["terms"]:
        ch = next(c for c in CHAPTERS if c["id"] == term["ch"])
        items.append(f"""        <li class="term-card" data-term="{term['zh']} {term['en']}">
          <div class="term-card__head">
            <h3>{term['zh']}<span class="term-card__en">{term['en']}</span></h3>
            <a class="term-card__src" href="../{ch['slug']}/">第 {ch['num']} 章 {ch['title']['zh']}</a>
          </div>
          <p class="term-card__def">
            <span data-lang="zh">{term['zh_def']}</span>
            <span data-lang="en">{term['en_def']}</span>
          </p>
          <p class="term-card__why">
            <span data-lang="zh">{term['zh_why']}</span>
            <span data-lang="en">{term['en_why']}</span>
          </p>
        </li>""")

    html = f"""{head("术语表 · 《可视化导论》",
               "《可视化导论》全课程术语表：每个名词给出定义，并说明它为什么重要、容易在哪儿搞错。",
               "../", extra_css=("portal",))}
<body id="top">
  <a class="skip-link" href="#main">跳到主要内容</a>

{topbar("../", [("课程门户", "../"), ("术语表", None)], "")}

{search_layer()}

  <div class="shell shell--wide">
    <main class="main" id="main">
      <div class="page-head">
        <p class="page-head__eyebrow">Glossary</p>
        <h1>术语表</h1>
        <p class="page-head__lead">
          按章节顺序排列。每个词条除了「是什么」，还写了「为什么重要」——
          名词表最容易变成一份背了也没用的清单，加上后半句才有意义。
        </p>
      </div>

      <div class="term-filter" role="group" aria-label="按章节筛选">
        <button type="button" data-term-filter="all" aria-pressed="true">全部 {len(data['terms'])}</button>
        {''.join(f'''<button type="button" data-term-filter="{c['id']}" aria-pressed="false">第 {c['num']} 章</button>''' for c in CHAPTERS)}
      </div>

      <ul class="term-list">
{chr(10).join(items)}
      </ul>
    </main>
  </div>

{site_footer("../")}
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
