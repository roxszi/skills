# 交付链路执行手册（提图 + HTML 导出）

> 本文是 SKILL.md §3.4 与 §5.4 的执行细节层；命令与红线以 SKILL.md 为准，本文只放参数、架构与已知边界。

## 一 图表提取（figures）

### 1.1 架构

```
review.mjs figures --project <dir> [--id <n>]
  └─ 逐篇 spawn scripts/fig_run.mjs <pdf> <outDir> <logsDir>   （编排器，自身不 import 任何 pdf 库）
       ├─ 阶段 1 fig_embed.mjs   仅 pdf-parse（内置 pdfjs@5）：提内嵌位图
       └─ 阶段 2 fig_render.mjs  仅 pdfjs-dist@6 + sharp：文本层分类 + 渲染裁剪 + 编排落盘
```

两段必须独立进程：pdf-parse 内置的 pdfjs@5 与 pdfjs-dist@6 加载时都会写 `globalThis.pdfjsWorker`，同进程混用必崩（跨版本全局污染）。编排器与 review.mjs 自身不 import 两个 pdf 库到同一进程，即天然免疫。

产物：`figures/{id}_{slug}/fig_N.png`（按页码与页内位置统一编号）+ `manifest.json` / `manifest.md` + `issues.json`（阶段 1 位图提取与阶段 2 渲染的全部异常登记，整页/裁剪条目人工过目排障先查它）；中间量在 `figures/_logs/`（`*_embed.json` 位图盘点）。

### 1.2 决策树（逐页路由）

| 分支 | 条件 | 产物 origin | 中文含义 |
|---|---|---|---|
| a | 恰 1 张合格内嵌位图，绘制无旋转 | `embedded` | 内嵌直提（原生分辨率） |
| b | ≥2 张内嵌位图（碎片排版），CTM bbox 邻接聚类；邻近矢量簇并入窗口（位图+矢量混排复合图完整裁剪） | `render-crop` | 渲染裁剪（碎片拼版） |
| c | 1 张位图但绘制矩阵带旋转分量 | `rotated-embedded` | 内嵌直提（已自动转正） |
| d | 0 张真图 + 有文本层：图内标注行（大部分面积落矢量簇内的行）不算正文行；行级 caption 命中 → 图注上方窗口裁剪，窗口塌缩但页内存在大矢量簇时整页兜底 | `render-crop` / `fullpage` | 渲染裁剪（图注定位）／整页兜底 |
| d′ | 行级未命中但行内有 FIG 信号（两栏 OCR 乱序） | `fullpage` | 整页截取 |
| e | 0 张真图 + 无文本层（纯扫描页） | `fullpage` | 整页截取 |

### 1.3 整页兜底红线（不放假图）

d 分支裁剪前做文字带检测：裁剪窗口内文本行覆盖高度 ≥ 窗口 1/3，判为文字段假图，不放——降级为整页高清截取（`origin=fullpage`）。触发场景：双栏扫描件 OCR 行宽不过正文判定阈值致窗口罩住正文；图注在图上方的排版。垃圾拦截另含：过小位图（minSide<120）、条带（高宽比>8）、近纯色白图（跨页重复判装饰）。

对用户汇报与图注标注口径、手动裁剪后的重入循环以 SKILL.md §3.4 与 §5.4 为准，本文不重复。

### 1.4 manifest 字段契约

| 字段 | 类型 | 说明 |
|---|---|---|
| file | string | `fig_N.png`，全库统一编号 |
| page | number | 1 起页码 |
| origin | enum | `embedded` / `rotated-embedded` / `render-crop` / `fullpage`（含义见 1.2 表） |
| caption | string | 图注全文（legends 汇总页回填或图注链拼接）；整页截取为空串 |

### 1.5 已知边界

- 扫描版（JBIG2 等）：渲染需 wasm 资源参数（脚本已内置）；条带拼接型扫描页无完整图元素，走整页截取。
- 双栏 OCR 乱序：图注不在行首时行级匹配失败，靠行内 FIG 信号兜底整页截取。
- 复合图：同页多碎片经 CTM 聚类后渲染裁剪拼回逻辑图；跨页逻辑图（一图跨两页）不支持自动拼版，两页各自整页截取。
- caption 偶见只抓到短标签（图注起始行与碎片组距离选择未接全文），人工过目项之一。
- 碎片无绘制矩阵（frag-no-ctm）：位图碎片缺 CTM 时无法定位拼版，该路径下该页不产碎片图；issues.json 有登记，人工过目。
- 超长扫描本（数百页）：阶段 2 整页 PNG buffer 全程持有，内存占用随页数线性增长；按单篇篇目级使用设计，超长本分批跑。
- Form XObject 内嵌图：图像包在 Form group 内时 opList 线性 CTM 跟踪拿到 Form 内部坐标，bbox 失真（超页界）；守卫触发后该页碎片回退内嵌直提（issues.json 记 frag-ctm-offpage-fallback-embed），不产裁剪图。
- 图注汇总页（legends 页）：识别后解析「图号→全文」映射回填各图 caption，页面本身不产图（2026-10-24 实测该类页裁剪产物 17/17 全为图注文字假图）；无位图无矢量簇才判 legends 页，短 legends 页（<3 条图注）仍走常规路径。
- 矢量图感知：constructPath 路径记录 bbox 并页内聚类——纯矢量图（无内嵌位图）走 caption 窗口裁剪，窗口塌缩时大矢量簇兜底整页截取；位图+矢量混排复合图按「位图碎片并集 ∪ 邻近矢量簇」裁剪，矢量子图不丢。整页装饰框（宽高双 ≥95% 页面）不参与判定。

### 1.6 依赖与安装

`pdf-parse`（阶段 1）、`pdfjs-dist` + `sharp` + `@napi-rs/canvas`（阶段 2）。首次使用在本 skill 目录 `npm install`／`pnpm install`／`bun install` 任一；依赖缺失时报错信息含安装指引。渲染 scale 按页内位图原生分辨率自适应（上限 4），扫描页整页截取分辨率以页内条带原生高度为准。

## 二 一键自包含 HTML（export-html）

```
node review.mjs export-html --project <dir> [--review <综述.md>]
```

- 缺省综述 `deliverables/综述.md`（与 check 缺省一致）；`assemble` 用了自定义 `--out` 时传同名 `--review`。
- 产物：综述同名 `.html`，单文件。解析用 marked（GFM）；`<img>` 本地相对路径自动转 base64 内嵌（路径以项目根为基准，与 §3.4 配图纪律一致；CLI 直跑引擎脚本时以 md 所在目录为基准）；CSS 内嵌；http(s) 与 data: 引用保留原样并计入外链报告。
- 退出码：0 = 全部内嵌成功；2 = 有缺失图片（清单已打印，修正后重跑本步）。
- 校验口径（对用户汇报）：内嵌张数 = md 本地图片引用数；缺失 = 0；外链 = 0（若引用了远程图会如实列出，离线不可见）。
- 重入循环：导出 → 用户手动裁剪整页图 / 修正 md → 再次运行本命令 → 交付终稿。本步不读条目、不碰 sections、不触发 check。
- 公式与 mermaid 按 md 原样显示（不引 CDN 保离线可开）；交稿格式转换走宿主文档能力。
