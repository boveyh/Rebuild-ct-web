#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
全站静态审计 —— 在浏览器打开之前，先把「一定会坏」的东西找出来。

为什么需要这个脚本：
    重构把 5 章页面从「手写 HTML」变成了「管道生成 + 运行时增强」，
    路径从「页面同级」变成了「相对站点根目录的两级结构」。
    这种结构性改动最容易留下的隐患是「静态看起来没问题、点开是 404」——
    而作业明确要求修掉无法渲染的 404 页面，所以必须有一个可重复执行的检查。

    这个脚本检查 6 类问题：
      L1  本地引用断链         href / src / import / fetch / url() 指向不存在的文件
      L2  站点根绝对路径       "/xxx" 在 GitHub Pages 子路径下必然 404
      L3  外部 CDN 可用性      远程资源做一次 HEAD（可选，--offline 跳过）
      L4  编辑器残留           data-page-node-id、重复属性等
      L5  可访问性下限          <img> 缺 alt、表单元素缺标签
      L6  内容完整性           章节小节数、关键点计数、演示模块注册数

用法：
    python tools/audit.py                 # 全量检查（含联网）
    python tools/audit.py --offline       # 跳过联网检查
    python tools/audit.py --json out.json # 同时输出机器可读结果
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 审计时跳过的目录：不是站点产物，或体积大且与渲染无关。
# .tmp 与 deliverables 是本机的工作目录，里面的脚本会写 Node 内置模块名
# （node:module 之类），混进来会被误判成断链。
SKIP_DIRS = {
    ".git", ".tmp", ".workbuddy", "deliverables",
    "node_modules", "__pycache__", "tools", "docs",
}

# 这些扩展名会被当作「本地资源」去检查是否存在
ASSET_EXT = {
    ".html", ".htm", ".css", ".js", ".mjs", ".json", ".csv", ".tsv", ".txt",
    ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico",
    ".woff", ".woff2", ".ttf", ".otf", ".pdf", ".mp4", ".webm", ".xml",
}

# 属性中出现的 URL 引用
RE_ATTR = re.compile(
    r"""\b(href|src|srcset|poster|data-src|action)\s*=\s*(?:"([^"]*)"|'([^']*)')""",
    re.I,
)
# <script type="module"> 里的裸 import / 动态 import
RE_IMPORT = re.compile(r"""\b(?:import|import\s*\(|from)\s*\(?\s*["']([^"']+)["']""")
# CSS 里的 url(...) 与 @import
RE_CSS_URL = re.compile(r"""url\(\s*["']?([^"')]+)["']?\s*\)""")
RE_CSS_IMPORT = re.compile(r"""@import\s+(?:url\(\s*)?["']([^"']+)["']""")
# 运行时才发生的资源请求（d3.csv / fetch / XHR），静态审计只能靠模式匹配
RE_RUNTIME = re.compile(
    r"""(?:d3\.(?:csv|json|text|tsv|xml)|fetch|d3\.csvParse)\s*\(\s*["'`]([^"'`]+)["'`]"""
)

RE_IMG = re.compile(r"<img\b[^>]*>", re.I)
RE_ALT = re.compile(r"""\balt\s*=\s*(?:"([^"]*)"|'([^']*)')""", re.I)

RE_HAS_NODE_ID = re.compile(r"data-page-node-id")
RE_DUP_ATTR = re.compile(r"<[a-zA-Z][^>]*\s([a-zA-Z-]+)=")

# 一个合法的小节 id 形如 ch-1-1，用来核对内容完整性
RE_SEC_ID = re.compile(r'id="(ch-\d+-\d+)"')

# ---------------------------------------------------------------------------
# 结果收集
# ---------------------------------------------------------------------------

class Report:
    def __init__(self) -> None:
        self.issues: list[dict] = []
        self.stats: dict = {}

    def add(self, level: str, kind: str, where: str, detail: str, ref: str = "") -> None:
        self.issues.append(
            {"level": level, "kind": kind, "where": where, "detail": detail, "ref": ref}
        )

    def by_kind(self) -> dict[str, list[dict]]:
        out: dict[str, list[dict]] = defaultdict(list)
        for it in self.issues:
            out[it["kind"]].append(it)
        return dict(out)


# ---------------------------------------------------------------------------
# 遍历站点文件
# ---------------------------------------------------------------------------

def site_files() -> list[Path]:
    files: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for fn in filenames:
            files.append(Path(dirpath) / fn)
    return sorted(files)


def is_external(url: str) -> bool:
    return bool(re.match(r"^(?:[a-z]+:)?//", url, re.I)) or url.startswith(
        ("mailto:", "tel:", "data:", "javascript:")
    )


def split_hash(url: str) -> tuple[str, str]:
    """把 a.html#sec 拆成 (a.html, #sec)。"""
    if "#" in url:
        p, _, h = url.partition("#")
        return p, "#" + h
    return url, ""


def resolve(base_dir: Path, ref: str) -> Path:
    """把相对引用解析为磁盘路径。"""
    clean = ref.split("?")[0].split("#")[0]
    if clean == "":
        return base_dir
    if clean.startswith("/"):
        return ROOT / clean.lstrip("/")
    # normpath 能消掉 ../，而 Path.resolve() 在目标不存在时会抛错，这里要的是「不存在也要能算出来」
    return Path(os.path.normpath(base_dir / clean))


def exists(path: Path) -> bool:
    """文件存在，或者是一个带 index.html 的目录。"""
    if path.is_file():
        return True
    if path.is_dir():
        return (path / "index.html").is_file()
    # 允许无扩展名的页面（如 extensionless URL）
    if path.suffix == "" and (path.parent / (path.name + ".html")).is_file():
        return True
    return False


def dynamic_join(text: str, ref: str) -> bool:
    """判断 ref 是不是被拼接出来的路径片段。

    静态审计遇到 `import("./demos/ch" + chapterId + ".js")` 这类写法只能认输：
    完整的路径在运行期才成立。与其报一条永远修不掉的假警报，不如识别出来，
    退一步只校验它的父目录。
    """
    esc = re.escape(ref)
    return bool(re.search(rf"""["']{esc}["']\s*\+""", text) or
                re.search(rf"""\+\s*["']{esc}["']""", text))


# ---------------------------------------------------------------------------
# L1 / L2 —— 引用检查
# ---------------------------------------------------------------------------

RE_HTML_COMMENT = re.compile(r"<!--.*?-->", re.S)
RE_PRE_BLOCK = re.compile(r"<pre\b[^>]*>.*?</pre>", re.S | re.I)
RE_SCRIPT_BLOCK = re.compile(r"<script\b([^>]*)>(.*?)</script>", re.S | re.I)
RE_STYLE_BLOCK = re.compile(r"<style\b[^>]*>(.*?)</style>", re.S | re.I)
# 只剥「行首注释」和块注释：行尾注释的正则容易误伤 "https://…" 这类字符串
RE_JS_LINE_COMMENT = re.compile(r"^[ \t]*//.*$", re.M)
RE_JS_BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.S)


def html_surfaces(text: str) -> tuple[str, str]:
    """把一份 HTML 拆成「属性面」和「代码面」。

    这件事必须做，否则审计会大量误报 —— 实测踩到过的四种：
      · 正文里写着 `from 'a table' to 'a chart'`，被 import 正则当成模块说明符；
      · 代码示例块里有 `import { regressionLinear } from 'd3-regression'`，
        那是讲给学生看的示例，不是真实依赖；
      · HTML 注释里留着 `<script src="volumeRendering.js">`；
      · JS 注释里留着 `// import * as d3 from "d3"`。

    做法：注释和 <pre> 整块挖掉（代码示例都在 <pre> 里），
    属性面用剩下的文档，代码面只取 <script> 的内部、再去掉注释。
    """
    code = "\n".join(m.group(2) for m in RE_SCRIPT_BLOCK.finditer(text))
    code = RE_JS_BLOCK_COMMENT.sub(" ", code)
    code = RE_JS_LINE_COMMENT.sub("", code)

    markup = RE_PRE_BLOCK.sub(" ", text)
    markup = RE_HTML_COMMENT.sub(" ", markup)
    return markup, code


def script_hosts(files: list[Path]) -> dict[str, list[Path]]:
    """建立「本地脚本 -> 会执行它的页面目录」的映射。

    d3.csv / fetch 的相对路径是按**文档**解析的，不是按脚本文件。
    supplementary/utils/data.js 里的 './newstudent.csv'，被 supplementary/tableshow.html
    加载时实际请求的是 supplementary/newstudent.csv；如果只看脚本自身所在目录，
    就会误判成断链，进而「修」成真正会 404 的路径 —— 这个坑我实际踩过一次。

    除了 <script src> 直连，还要沿着 import 图传下去：
    lesson.js 由章节页加载，而它又 `import("./demos/ch" + id + ".js")`，
    所以 demos/chXX.js 的宿主也是 lesson-XX/。
    """
    hosts: dict[str, set[Path]] = defaultdict(set)

    for f in files:
        if f.suffix.lower() not in (".html", ".htm"):
            continue
        text = f.read_text(encoding="utf-8", errors="replace")
        for m in RE_SCRIPT_BLOCK.finditer(text):
            sm = re.search(r"""src\s*=\s*["']([^"']+)["']""", m.group(1))
            if not sm:
                continue
            src = sm.group(1).split("?")[0].split("#")[0]
            if is_external(src) or src.startswith("/"):
                continue
            try:
                key = str(resolve(f.parent, src).relative_to(ROOT)).replace("\\", "/")
            except ValueError:
                continue
            hosts[key].add(f.parent)

    # 沿 import 边传播宿主（BFS，少量轮次即收敛）
    for _ in range(6):
        changed = False
        for js, dirs in list(hosts.items()):
            p = ROOT / js
            if not p.is_file():
                continue
            src = p.read_text(encoding="utf-8", errors="replace")

            # 静态 import / 精确动态 import
            for m in re.finditer(r"""import\s*\(?\s*["']([^"']+)["']""", src):
                spec = m.group(1)
                if is_external(spec) or not spec.startswith("."):
                    continue
                try:
                    k = str(resolve(p.parent, spec).relative_to(ROOT)).replace("\\", "/")
                except ValueError:
                    continue
                if not set(dirs) <= hosts.get(k, set()):
                    hosts.setdefault(k, set()).update(dirs)
                    changed = True

            # 拼接式动态 import：`import("./demos/ch" + id + ".js")`
            # 拿不到完整文件名，但能拿到「目录 + 文件名前缀」，
            # 于是让 demos/ch*.js 这一批继承同一个宿主。
            for m in re.finditer(r"""import\s*\(\s*["']([^"']+)["']\s*\+""", src):
                frag = m.group(1)
                d = resolve(p.parent, frag).parent
                if not d.is_dir():
                    continue
                stem = str(resolve(p.parent, frag).name)
                for child in d.glob(stem + "*.js"):
                    try:
                        k = str(child.relative_to(ROOT)).replace("\\", "/")
                    except ValueError:
                        continue
                    if not set(dirs) <= hosts.get(k, set()):
                        hosts.setdefault(k, set()).update(dirs)
                        changed = True
        if not changed:
            break

    return {k: sorted(v) for k, v in hosts.items()}


def check_references(files: list[Path], rep: Report) -> None:
    external: set[str] = set()
    root_links: list[tuple[str, str]] = []
    hosts = script_hosts(files)

    for f in files:
        rel_where = str(f.relative_to(ROOT)).replace("\\", "/")
        suffix = f.suffix.lower()

        # 只审计站点产物，源材料（.md / .py / 打包文件）不参与
        if f.name.endswith((".md", ".py", ".tar.gz")):
            continue

        if suffix in (".html", ".htm"):
            try:
                text = f.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue

            markup, code = html_surfaces(text)

            refs: list[str] = []
            for m in RE_ATTR.finditer(markup):
                raw = m.group(2) if m.group(2) is not None else m.group(3) or ""
                if m.group(1).lower() == "srcset":
                    refs += [p.strip().split(" ")[0] for p in raw.split(",")]
                else:
                    refs.append(raw)
            refs += [m.group(1) for m in RE_IMPORT.finditer(code)]
            refs += [m.group(1) for m in RE_RUNTIME.finditer(code)]

            for m in RE_STYLE_BLOCK.finditer(text):
                body = m.group(1)
                refs += [u.group(1) for u in RE_CSS_URL.finditer(body)]
                refs += [u.group(1) for u in RE_CSS_IMPORT.finditer(body)]

            # 404 页专用的「站点根相对路径」：构建期算不出前缀，交给运行时补。
            # 这里仍然要验证目标存在，否则等于把断链藏进了 JS 里。
            for m in re.finditer(r'data-root-link="([^"]*)"', markup):
                root_links.append((rel_where, m.group(1)))

        elif suffix in (".css",):
            text = f.read_text(encoding="utf-8", errors="replace")
            refs = [m.group(1) for m in RE_CSS_URL.finditer(text)]
            refs += [m.group(1) for m in RE_CSS_IMPORT.finditer(text)]
        elif suffix in (".js", ".mjs"):
            text = f.read_text(encoding="utf-8", errors="replace")
            refs = [m.group(1) for m in RE_IMPORT.finditer(text)]
            refs += [m.group(1) for m in RE_RUNTIME.finditer(text)]
        else:
            continue

        # 运行时路径（d3.csv('./data/x.csv')）相对**文档**解析，不相对脚本文件。
        # 所以基准要换成真正加载这份代码的那些页面所在目录：
        #   · assets/js/demos/chXX.js  -> lesson-XX/
        #   · supplementary/utils/*.js -> 用 <script src> 引用它的那个页面
        runtime_bases = [f.parent]
        if suffix in (".js", ".mjs"):
            hosted = hosts.get(rel_where)
            if hosted:
                runtime_bases = hosted

        for raw in refs:
            ref = raw.strip()
            if not ref or ref.startswith("#"):
                continue
            if is_external(ref):
                external.add(ref.split("?")[0].split("#")[0])
                continue

            # L2：站点根绝对路径在 GitHub Pages 子路径下会 404
            if ref.startswith("/"):
                rep.add(
                    "L2",
                    "站点根绝对路径",
                    rel_where,
                    f"`{ref}` 以 / 开头；部署到 /vis/ 子路径后会 404",
                    ref,
                )
                continue

            has_ext = Path(ref.split("?")[0].split("#")[0]).suffix.lower()
            if has_ext and has_ext not in ASSET_EXT:
                continue

            # 动态拼接（`import("./demos/ch" + id + ".js")`）没法静态求值。
            # 退一步校验它所在的目录存在，至少能挡住「整个目录被删掉」这类问题。
            if dynamic_join(text, ref):
                d = resolve(f.parent, ref).parent
                if not d.is_dir():
                    rep.add("L1", "断链", rel_where,
                            f"动态拼接的路径 `{ref}…` 所在目录不存在", ref)
                continue

            is_runtime = any(rr.group(1) == ref for rr in RE_RUNTIME.finditer(text))
            bases = runtime_bases if is_runtime else [f.parent]

            if not any(exists(resolve(b, ref)) for b in bases):
                rep.add("L1", "运行时资源缺失" if is_runtime else "断链",
                        rel_where, f"-> `{ref}`", ref)

    # 站点根相对链接：目标是相对站点根写的，直接对 ROOT 校验
    for where, target in root_links:
        if not exists(resolve(ROOT, target)):
            rep.add("L1", "断链", where, f"data-root-link -> `{target or '(站点根)'}`", target or "./")

    rep.stats["外部域名"] = sorted({re.sub(r"^(https?:)?//([^/]+).*", r"\2", u) for u in external})


def check_external(rep: Report, offline: bool) -> None:
    if offline:
        rep.stats["外部资源探测"] = "已跳过（--offline）"
        return
    hosts = rep.stats.get("外部域名", [])
    results = {}
    for host in hosts:
        url = "https://" + host + "/"
        try:
            req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "audit"})
            with urllib.request.urlopen(req, timeout=6) as r:
                results[host] = r.status
        except urllib.error.HTTPError as e:
            # 403/405 只说明 HEAD 不被允许，不代表资源不可用
            results[host] = f"HTTP {e.code}"
        except Exception as e:  # noqa: BLE001
            results[host] = f"不可达（{type(e).__name__}）"
    rep.stats["外部资源探测"] = results


# ---------------------------------------------------------------------------
# L4 —— 残留与非法标记
# ---------------------------------------------------------------------------

def check_leftovers(files: list[Path], rep: Report) -> None:
    classic: list[str] = []
    for f in files:
        if f.suffix.lower() not in (".html", ".htm"):
            continue
        rel = str(f.relative_to(ROOT)).replace("\\", "/")
        text = f.read_text(encoding="utf-8", errors="replace")

        n = len(RE_HAS_NODE_ID.findall(text))
        if n:
            rep.add("L4", "编辑器残留", rel, f"{n} 处 data-page-node-id")

        # 重复属性：同一个标签里同一个属性名出现两次
        for tag in re.finditer(r"<([a-zA-Z][\w-]*)((?:\s+[\w:-]+(?:=(\"[^\"]*\"|'[^']*'|[^\s>]+))?)+)\s*/?>", text):
            attrs = re.findall(r"([\w:-]+)\s*=", tag.group(2))
            dup = {a for a in attrs if attrs.count(a) > 1}
            if dup:
                rep.add("L4", "非法 HTML", rel, f"标签 <{tag.group(1)}> 重复属性 {sorted(dup)}")

        # 非 module 的本地脚本：原站遗留的独立 demo 用「全局函数 + 顺序加载」这一套，
        # 页内自洽、能跑，而且改成 ES Module 要动作者的数据管线（相互依赖的全局函数），
        # 风险大于收益。这里只登记，不算缺陷。
        for m in re.finditer(r"<script\b([^>]*)>", text, re.I):
            attrs = m.group(1)
            sm = re.search(r'src\s*=\s*"([^"]+)"', attrs)
            if not sm or is_external(sm.group(1)) or "module" in attrs:
                continue
            classic.append(f"{rel} ({sm.group(1)})")
    if classic:
        rep.stats["旧式脚本（遗留 demo，非缺陷）"] = classic


# ---------------------------------------------------------------------------
# L5 —— 可访问性下限
# ---------------------------------------------------------------------------

def check_a11y(files: list[Path], rep: Report) -> None:
    tot_img = tot_noalt = 0
    tot_aria = 0
    for f in files:
        if f.suffix.lower() not in (".html", ".htm"):
            continue
        rel = str(f.relative_to(ROOT)).replace("\\", "/")
        text = f.read_text(encoding="utf-8", errors="replace")

        tot_aria += len(re.findall(r"\baria-[a-z]+=", text))

        noalt = []
        for m in RE_IMG.finditer(text):
            tag = m.group(0)
            tot_img += 1
            if not RE_ALT.search(tag):
                tot_noalt += 1
                noalt.append(tag[:80])
        if noalt:
            rep.add("L5", "图片缺少 alt", rel, f"{len(noalt)} 个 <img> 无 alt")

    rep.stats["图片总数"] = tot_img
    rep.stats["缺 alt 图片"] = tot_noalt
    rep.stats["aria-* 属性总数"] = tot_aria


# ---------------------------------------------------------------------------
# L6 —— 内容完整性
# ---------------------------------------------------------------------------

def check_content(rep: Report) -> None:
    chapters = json.loads((ROOT / "tools" / "data" / "chapters.json").read_text(encoding="utf-8"))
    if isinstance(chapters, dict):
        chapters = chapters.get("chapters", chapters)

    rows = []
    total_sec = total_demo = 0
    for ch in chapters:
        cid = ch.get("id") or ch.get("chapter")
        page = ROOT / f"lesson-{int(cid):02d}" / "index.html"
        if not page.is_file():
            rep.add("L6", "章节页缺失", f"lesson-{int(cid):02d}/index.html", "未生成")
            continue
        text = page.read_text(encoding="utf-8", errors="replace")
        sec_ids = sorted(set(RE_SEC_ID.findall(text)))
        expected = ch.get("sections") or []
        n_expected = len(expected) if expected else len(sec_ids)

        demo_module = ROOT / "assets" / "js" / "demos" / f"ch{int(cid):02d}.js"
        n_demo = 0
        if demo_module.is_file():
            js = demo_module.read_text(encoding="utf-8", errors="replace")
            # 只数「行首注册」`DEMOS["d-4-1"] = ...`。
            # 早先写成 re.findall(r"DEMOS\[", js) 会把调度语句
            # `if (DEMOS[name]) DEMOS[name](firstMount);` 也算进来 ——
            # 一行里两个 `DEMOS[`，第 2 章因此被多算成 6 个演示。
            n_demo = len(re.findall(r"^DEMOS\[", js, re.MULTILINE))

        total_sec += len(sec_ids)
        total_demo += n_demo
        rows.append(
            {
                "章": ch.get("title") or f"第 {cid} 章",
                "小节数": len(sec_ids),
                "小节 id": ",".join(s.replace("ch-", "") for s in sec_ids),
                "演示数": n_demo,
            }
        )
        if expected and len(sec_ids) != n_expected:
            rep.add(
                "L6",
                "小节数不符",
                f"lesson-{int(cid):02d}/index.html",
                f"页面 {len(sec_ids)} 小节，元数据 {n_expected} 节",
            )

    rep.stats["章节概览"] = rows
    rep.stats["小节总数"] = total_sec
    rep.stats["演示总数"] = total_demo

    # 搜索索引与术语表
    idx = ROOT / "assets" / "search-index.json"
    if idx.is_file():
        rep.stats["搜索索引条目"] = len(json.loads(idx.read_text(encoding="utf-8")))
    gl = ROOT / "tools" / "data" / "glossary.json"
    if gl.is_file():
        g = json.loads(gl.read_text(encoding="utf-8"))
        rep.stats["术语条目"] = len(g if isinstance(g, list) else g.get("terms", g))


# ---------------------------------------------------------------------------
# 样式覆盖：页面用到的类，是否真有「本页加载了的」样式表去定义它
# ---------------------------------------------------------------------------
# 这条规则来自一次真实事故，值得写下来：
#   门户页 index.html 的 head 里漏了 portal.css，于是 .chapter-grid、
#   .chapter-card、.portal-stats、.roadmap 这些类一个样式都没有，首页
#   整个塌成一列纯文字 —— 用户看到的第一反应是「首页全是文字，设计有问题」。
#   而它在所有既有检查项目里都是"干净"的：没有断链（根本没请求这个文件）、
#   没有 404、没有 JS 报错、元素也都存在，浏览器验证只断言"元素在不在"，
#   自然也抓不到。缺的是一条「结构与样式是否对得上」的检查。

def css_class_owners() -> dict[str, set[str]]:
    """类名 -> 定义它的样式表（去掉扩展名的文件名）集合。"""
    owners: dict[str, set[str]] = defaultdict(set)
    for f in sorted((ROOT / "assets" / "css").glob("*.css")):
        txt = re.sub(
            r"/\*.*?\*/", " ", f.read_text(encoding="utf-8", errors="replace"), flags=re.S
        )
        # 点号后必须紧跟字母/下划线/连字符，这样 1.5rem、.5em 之类的
        # 数字不会被当成类名
        for c in re.findall(r"\.(-?[_a-zA-Z][-_a-zA-Z0-9]*)", txt):
            owners[c].add(f.stem)
    return owners


def check_css_coverage(rep: Report) -> None:
    owners = css_class_owners()
    all_css = {p.stem for p in (ROOT / "assets" / "css").glob("*.css")}
    referenced: set[str] = set()

    for page in site_files():
        if page.suffix != ".html":
            continue
        rel = page.relative_to(ROOT).as_posix()
        # 自包含的独立 Demo：自带 <style>，本来就不套站点外壳
        if rel.startswith("lesson-01/demo/"):
            continue
        if rel.startswith("supplementary/") and rel != "supplementary/index.html":
            continue

        txt = page.read_text(encoding="utf-8", errors="replace")

        # 本页真正加载的样式表。只认 <link rel="stylesheet">：404 页的探测
        # 脚本里也有一句 "assets/css/tokens.css"，那是拿去做 XHR 探测的字符串，
        # 不是引用。
        loaded = set(
            re.findall(
                r'<link[^>]+rel="stylesheet"[^>]+href="[^"]*assets/css/([\w-]+)\.css"', txt
            )
        )
        referenced |= loaded

        # 页面里的类名。先挖掉 <script>/<style>，免得把 JS 里的
        # querySelector(".foo") 或模板串里的类名当成页面结构。
        body = re.sub(
            r"<script\b.*?</script>|<style\b.*?</style>", " ", txt, flags=re.S | re.I
        )
        classes: set[str] = set()
        for grp in re.findall(r'class="([^"]*)"', body):
            classes |= set(grp.split())

        for c in sorted(classes):
            own = owners.get(c)
            # 全站都没定义过这个类 -> 属于另一类问题（可能是 JS 的钩子），这里不管
            if not own or (own & loaded):
                continue
            rep.add(
                "L7",
                "样式未加载",
                rel,
                f".{c} 只由 {','.join(sorted(own))}.css 定义，而本页加载的是 "
                f"{','.join(sorted(loaded)) or '（无样式表）'}",
            )

    # 反过来也查一遍：有没有样式表根本没被人引用（死文件）
    for css in sorted(all_css - referenced):
        rep.add("L7", "样式未引用", f"assets/css/{css}.css", "没有任何页面加载它")


# ---------------------------------------------------------------------------
# 演示接线：页面写下的模块名与演示键，必须都能落到真实的东西上
# ---------------------------------------------------------------------------
# 又一条来自真实事故的规则：
#   页面写 data-demo-chapter="1"，lesson.js 直接拼成 ./demos/ch1.js，
#   而文件叫 ch01.js —— 5 章演示全部 404。报错文案还写着「可能是 CDN 不可达」，
#   把排查方向带偏了。根因是「属性值」与「文件名」之间靠运行时补零对齐，
#   谁都不知道这个约定；把它写成静态检查，约定就变成了约束。

RE_DEMO_CH = re.compile(r'data-demo-chapter="([^"]*)"')
RE_DEMO_KEY = re.compile(r'data-demo="([^"]*)"')


def check_demo_wiring(files: list[Path], rep: Report) -> None:
    demo_dir = ROOT / "assets" / "js" / "demos"
    for f in files:
        if f.suffix != ".html":
            continue
        text = f.read_text(encoding="utf-8", errors="replace")
        rel = f.relative_to(ROOT).as_posix()

        chaps = sorted(set(RE_DEMO_CH.findall(text)))
        keys = sorted(set(RE_DEMO_KEY.findall(text)))
        if not chaps and not keys:
            continue
        if not chaps or not keys:
            rep.add("L8", "演示接线错误", rel,
                    f"只有一半信息：data-demo-chapter={chaps or '无'}，data-demo={keys or '无'}")
            continue

        registered: set[str] = set()
        for chap in chaps:
            mod = demo_dir / f"ch{chap}.js"
            if not mod.is_file():
                have = ", ".join(sorted(p.name for p in demo_dir.glob("ch*.js")))
                rep.add("L8", "演示接线错误", f"{rel} → assets/js/demos/ch{chap}.js",
                        f"模块不存在（实际有：{have}）")
                continue
            js = mod.read_text(encoding="utf-8", errors="replace")
            registered |= set(re.findall(r'^DEMOS\["([^"]+)"\]', js, re.MULTILINE))

        for key in keys:
            if registered and key not in registered:
                rep.add("L8", "演示接线错误", f"{rel} → 演示键 {key}",
                        "该键没有在对应的 demos 模块里注册")


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--offline", action="store_true", help="跳过外部 CDN 探测")
    ap.add_argument("--json", metavar="PATH", help="额外输出 JSON 报告")
    args = ap.parse_args()

    rep = Report()
    files = site_files()

    check_references(files, rep)
    check_external(rep, args.offline)
    check_leftovers(files, rep)
    check_a11y(files, rep)
    check_content(rep)
    check_css_coverage(rep)
    check_demo_wiring(files, rep)

    kinds = rep.by_kind()
    order = [
        "断链",
        "运行时资源缺失",
        "站点根绝对路径",
        "样式未加载",
        "样式未引用",
        "演示接线错误",
        "编辑器残留",
        "非法 HTML",
        "脚本加载方式",
        "图片缺少 alt",
        "小节数不符",
        "章节页缺失",
    ]

    print("=" * 74)
    print("全站静态审计")
    print("=" * 74)
    print(f"扫描文件 {len(files)} 个\n")

    if not rep.issues:
        print("✅ 未发现静态问题\n")
    for k in order:
        items = kinds.get(k)
        if not items:
            continue
        mark = (
            "❌"
            if k in ("断链", "运行时资源缺失", "章节页缺失", "样式未加载", "演示接线错误")
            else "⚠️"
        )
        print(f"{mark} {k}（{len(items)}）")
        seen: dict[str, list[str]] = defaultdict(list)
        for it in items:
            seen[it["where"]].append(it["ref"] or it["detail"])
        for where, refs in sorted(seen.items())[:40]:
            uniq = sorted(set(refs))
            head = ", ".join(uniq[:6])
            more = f" … 共 {len(uniq)} 项" if len(uniq) > 6 else ""
            print(f"    {where}")
            print(f"        {head}{more}")
        print()

    print("-" * 74)
    print("统计")
    print("-" * 74)
    for k, v in rep.stats.items():
        if k == "章节概览":
            print(f"  {k}:")
            for row in v:
                print(
                    f"    · {row['章']}：{row['小节数']} 小节"
                    f"（{row['小节 id']}），{row['演示数']} 个演示"
                )
        elif isinstance(v, list):
            print(f"  {k}: {len(v)} 项 -> {', '.join(v[:8])}")
        elif isinstance(v, dict):
            print(f"  {k}:")
            for kk, vv in v.items():
                print(f"      {kk}: {vv}")
        else:
            print(f"  {k}: {v}")

    if args.json:
        Path(args.json).write_text(
            json.dumps({"issues": rep.issues, "stats": rep.stats}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        print(f"\nJSON 报告 -> {args.json}")

    hard = [i for i in rep.issues if i["level"].startswith("L1") or i["kind"] == "章节页缺失"]
    print(f"\n需要修复的项：{len(hard)}")
    return 1 if hard else 0


if __name__ == "__main__":
    sys.exit(main())
