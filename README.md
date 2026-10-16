# 《可视化导论》课程网站 · 重构版

中国石油大学（华东）《可视化导论》课程网站的重构。

原站：<https://cinger007.github.io/vis/>
重构版线上：<https://boveyh.github.io/Rebuild-ct-web/>

**目标**：让内容展现更清晰、更适合学习。

**做法**：把「内容」和「外壳」拆开——原作者的正文、讲解、关键点一字不改；
外壳（导航、排版、检索、双语、无障碍、响应式）整体重写。
抽取与装配由 `tools/build.py` 完成，可复现、可 diff。

---

## 快速开始

```bash
# 本地预览（零依赖，只要 Python 3）
python -m http.server 8080
# 打开 http://localhost:8080
```

> **必须通过 HTTP 服务器打开，不要双击 HTML。**
> `file://` 协议下浏览器会拦截 `fetch`，站内搜索和演示数据都读不到。

GitHub Pages 可直接部署：把本目录作为站点根目录推送到 `main` 分支即可，**无需任何构建步骤**。

---

## 三条主线上的改动

### 1. 信息架构：补上「学习导航」这一层

原站直接给内容，学生不知道「这一章学什么、要多久、学之前得会什么」。

新增：每章的学习目标卡（共 26 条，用可检验的句式）、前置知识与预计时长、
**概念依赖图**（分层有向图，自研约 6 KB 渲染器）、25 条术语表、小节级阅读进度、
命令面板式全站搜索（`Ctrl/⌘ + K`，86 条索引）。

### 2. 阅读体验：让内容真的更好读

- **双语**从「中英两段并排堆叠」改为「双 DOM + 一条 CSS 规则切换」——中文读者不再被迫读两遍
- **代码块**加上行号（`::before` 生成，不进复制文本）、语言标签、复制按钮，
  并用黄色左边条标出原作者用 ⭐ 标记的 **123 处**关键代码点
- **配色采用 Wong 色板**（Nature Methods 2011，色觉缺陷友好）——
  第 3 章正好讲色彩与色觉缺陷，界面自身就是那个标准的示例
- 深色模式（跟随系统 / 手动切换 / 记忆）、5 档响应式断点、窄屏表格转卡片、打印时三 tab 全展开

### 3. 修复：断链、404 与「打不开的页面」

详见 [`docs/改动说明.md`](docs/改动说明.md) 第五节。含：

- 5 章 `href="lecture"` 指向不存在的文件 → 生成真正的讲义页
- 索引里点名、仓库里从未存在的 `yearcalendar.html` → **按描述补做**（van Wijk 日历热图）
- `volumeRendering.html`（缺数据、从未接线）→ 从索引移除，不假装它存在
- `calendar*.html` 的站点根绝对路径（子路径部署必 404）→ 修正
- `regression.html` 算完回归却没画、整页空白 → 重写为真正绘制
- 第 1 章 5 个可独立运行的实验失去入口 → 重新接线回章节页
- 自定义 `404.html`：GitHub Pages 会把缺失路径留在地址栏，页面里所有相对地址都会解析错位
  （上线实测过 —— favicon、CSS、JS 全 404，页面裸奔）。改为在 `<head>` 最前面探测站点根
  并写成 `<base>`，域根 / 子路径 / 本地预览三种情况都成立

---

## 工程结构

```
├── index.html                  门户：课程主线图 + 章节卡 + 统计
├── glossary.html               术语表（25 条，可按章筛选）
├── 404.html
├── lesson-01..05/
│   ├── index.html              集成教学页（讲解 / 关键代码 / 演示）
│   ├── lecture.html            讲义页（可打印）
│   └── data/                   该章演示数据
├── lesson-01/demo/             5 个可独立运行的实验（自包含，可单独拷走）
├── supplementary/              16 个页面（索引页 + 15 个独立 Demo）
├── assets/
│   ├── css/                    tokens / base / shell / content / portal
│   ├── js/                     shell / enhance / conceptmap / lesson / portal
│   │                           + demos/ch0X.js（按需动态 import）
│   └── search-index.json
└── tools/                      ※ 不参与部署，但请保留
    ├── build.py                内容管道：从原站快照抽取内容 + 统一外壳装配
    ├── build_supp.py           补充 Demo 修复与统一
    ├── audit.py                全站静态审计
    ├── verify_render.mjs       真实浏览器渲染验证
    ├── package.py              交付打包：排除 .git / 会话数据 / 可再生成产物
    ├── data/                   教学元数据：章节目标、概念图、导览脚本、术语表
    └── origin/                 原站快照（管道的输入，勿删）
```

---

## 开发与验证

```bash
python tools/build.py          # 重建全站（可重复执行，结果确定）
python tools/audit.py          # 静态审计：断链 / 绝对路径 / 残留 / a11y / 内容完整性
node  tools/verify_render.mjs  # 本地浏览器跑 35 个页面 + 6 项交互断言
node  tools/verify_render.mjs --shots   # 同时输出截图到 tools/screenshots/
node  tools/verify_live.mjs    # 部署后验证线上 404 页（子路径下样式是否正常）
python tools/package.py        # 打交付压缩包到 deliverables/
```

> `verify_render.mjs` 与 `verify_live.mjs` 都依赖 `puppeteer-core` 和本机的 Chrome / Edge。
> 前者默认连 `http://127.0.0.1:8099`，后者默认连线上地址，可用环境变量覆盖：
> `BASE=http://127.0.0.1:9000 node tools/verify_render.mjs`、`PROXY=http://127.0.0.1:7890 node tools/verify_live.mjs`。

`verify_render.mjs` 依赖 `puppeteer-core` 和本机的 Chrome / Edge，通过 `NODE_PATH`
指向工作区的 `node_modules` 即可（不需要在项目里装依赖）。

**当前状态：静态审计无问题；35/35 页面在真实浏览器中零报错、零失败请求；交互断言 6/6 通过。**

---

## 技术栈

纯 HTML + CSS + ES Modules。**零构建、零依赖。**
D3.js v7 走 CDN（jsDelivr）。`python -m http.server` 即可运行。

设计系统有 128 个 CSS 变量，分三层：原始色阶 → 语义令牌 → 组件。
换主题只动语义层。

---

## 许可与来源

课程内容版权归原作者（中国石油大学（华东）《可视化导论》课程组，授课教师李昕）所有。
本仓库是在原课程内容基础上的教学网站重构。
