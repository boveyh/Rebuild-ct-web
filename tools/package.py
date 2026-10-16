#!/usr/bin/env python3
"""把可交付的源码打成压缩包。

为什么单独写成脚本：作业允许「不限次修改」，改完内容就要重新交一次包。
把「哪些进包、哪些不进包」固化成代码，比每次手动右键压缩可靠。

排除项分三类：
  1. 版本控制与 Agent 会话数据（.git/、.workbuddy/）—— 体积大且与源码无关
  2. 可再生成的产物（tools/screenshots/、__pycache__/）—— 跑一次验证脚本就有
  3. 打包输出目录自身（deliverables/）—— 否则会包进上一次的包

用法：
    python tools/package.py
    python tools/package.py --out D:/somewhere/else.zip
"""

from __future__ import annotations

import argparse
import os
import time
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = ROOT / "deliverables" / "Rebuild-ct-web-source.zip"

# 目录前缀匹配：命中即整棵子树跳过
EXCLUDE_DIRS = {
    ".git",
    ".workbuddy",
    "deliverables",
    "__pycache__",
    ".tmp",
    "node_modules",
    "tools/screenshots",
}

# 单个文件后缀匹配
EXCLUDE_SUFFIXES = {".pyc", ".pyo", ".log", ".zip", ".DS_Store"}


def should_skip(rel: Path) -> bool:
    posix = rel.as_posix()
    for d in EXCLUDE_DIRS:
        if posix == d or posix.startswith(d + "/"):
            return True
    if rel.suffix in EXCLUDE_SUFFIXES:
        return True
    if rel.name in {".DS_Store", "Thumbs.db"}:
        return True
    return False


def collect() -> list[Path]:
    files: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        here = Path(dirpath)
        rel_here = here.relative_to(ROOT)

        # 原地裁剪 dirnames，os.walk 就不会往里走（比事后过滤省事也更准）
        dirnames[:] = [
            d for d in dirnames
            if not should_skip((rel_here / d) if str(rel_here) != "." else Path(d))
        ]

        for name in filenames:
            rel = (rel_here / name) if str(rel_here) != "." else Path(name)
            if not should_skip(rel):
                files.append(rel)

    return sorted(files, key=lambda p: p.as_posix())


def main() -> int:
    ap = argparse.ArgumentParser(description="打包可交付源码")
    ap.add_argument("--out", default=str(DEFAULT_OUT), help="输出 zip 路径")
    args = ap.parse_args()

    out = Path(args.out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)

    files = collect()
    if not files:
        print("没有可打包的文件，检查工作目录是否正确")
        return 1

    # zip 内统一用「项目名/」做顶层目录，解压不会散落一地
    top = ROOT.name + "/"
    raw = 0

    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for rel in files:
            src = ROOT / rel
            if not src.is_file():
                continue
            zf.write(src, top + rel.as_posix())
            raw += src.stat().st_size

    packed = out.stat().st_size

    # 分类统计，便于确认「该进的进了、不该进的没进」
    def bucket(rel: Path) -> str:
        p = rel.as_posix()
        if p.startswith("tools/"):
            return "tools/"
        if p.startswith("docs/"):
            return "docs/"
        if p.startswith("assets/"):
            return "assets/"
        if p.startswith("lesson-"):
            return "lesson-*"
        if p.startswith("supplementary/"):
            return "supplementary/"
        return "根目录"

    stats: dict[str, list[int]] = {}
    for rel in files:
        b = bucket(rel)
        acc = stats.setdefault(b, [0, 0])
        acc[0] += 1
        acc[1] += (ROOT / rel).stat().st_size

    print("=" * 62)
    print("打包完成")
    print("=" * 62)
    print(f"输出       {out}")
    print(f"文件数     {len(files)}")
    print(f"原始体积   {raw / 1024 / 1024:.2f} MB")
    print(f"压缩后     {packed / 1024 / 1024:.2f} MB"
          f"（压缩比 {packed / raw * 100:.1f}%）")
    print()
    print("分组明细")
    for name in sorted(stats, key=lambda k: -stats[k][1]):
        n, size = stats[name]
        print(f"  {name:<16} {n:>4} 个   {size / 1024:>9.1f} KB")
    print()
    print("已排除：" + "、".join(sorted(EXCLUDE_DIRS)))
    print(f"生成时间：{time.strftime('%Y-%m-%d %H:%M:%S')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
