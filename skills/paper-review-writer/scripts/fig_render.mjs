/**
 * fig-batch-render.mjs —— 阶段 2（v2）：五分支决策树分类 + 渲染裁剪/整页 + 内嵌图编排（独立进程）
 *
 * 设计思路（v2 架构）：
 * 进程隔离纪律：与 fig-batch-embed.mjs（pdf-parse/pdfjs@5）分开进程，本脚本只用 pdfjs-dist@6 + sharp。
 * 渲染不再走 pdf-to-img（其 getDocument 不传 wasmUrl，JBIG2 扫描页静默画白，v1 bug #2），
 * 改为直接 getDocument({ wasmUrl, standardFontDataUrl, cMapUrl, verbosity: 0 }) +
 * doc.canvasFactory.create 出画布、page.render({ canvas })，渲染产物做空白检测拦截废图。
 *
 * 每页先做「真图盘点」：阶段 1 内嵌位图（过垃圾过滤）+ operatorList 位图绘制记录（CTM 跟踪），
 * 按 `(宽,高)` 配对后路由：
 *   a. 恰 1 张真图且绘制无旋转 → 内嵌直提（原生分辨率，origin=embedded）
 *   b. ≥2 张真图（碎片排版）→ 渲染裁剪：CTM bbox 邻接聚类成逻辑图，按并集裁出（origin=render-crop）
 *   c. 1 张真图但绘制矩阵带旋转 → 内嵌直提 + sharp 旋转校正（origin=rotated-embedded）
 *   d. 0 张真图 + 有文本层 → 渲染整页 → 空白检测 → 有 caption 则裁剪，裁不出则整页附（origin=fullpage）
 *   e. 0 张真图 + 无文本层（纯扫描版）→ 渲染整页 → 整页附
 *
 * caption：双正则（带分隔符 Figure 1. / 无分隔符紧跟大写或中文 Figure 1Single-cell）+ 行链拼接
 * （修复 v1 间隔判断对下方行恒为负导致拖正文的 bug）；legends 汇总页（≥3 caption 且无真图）
 * 解析 `{图号: 全文}` 回填各图。渲染 scale 按页内位图原生分辨率自适应（上限 4）。
 *
 * 用法：node scripts/fig-batch-render.mjs <pdf绝对路径> <输出目录> <日志目录>
 */

import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import sharp from "sharp"
import { createCanvas } from "@napi-rs/canvas"
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs"

const [, , pdfPath, outDir, logsDir] = process.argv
if (!pdfPath || !outDir || !logsDir) {
  console.error("usage: node scripts/fig-batch-render.mjs <pdfAbsPath> <outDir> <logsDir>")
  process.exit(1)
}
const tmpDir = path.join(outDir, "_tmp")
fs.mkdirSync(outDir, { recursive: true })

const name = path.basename(outDir)
const embedJsonPath = path.join(logsDir, `${name}_embed.json`)
if (!fs.existsSync(embedJsonPath)) {
  console.error(`embed json missing: ${embedJsonPath} (run fig-batch-embed.mjs first)`)
  process.exit(1)
}
const embedData = JSON.parse(fs.readFileSync(embedJsonPath, "utf8"))
const issues = [...(embedData.issues || [])]
/** 异常登记（合并阶段 1 的 issues 后统一落盘） */
function issue(type, detail = {}) {
  issues.push({ type, ...detail })
  console.log(`[ISSUE] ${type} ${JSON.stringify(detail).slice(0, 240)}`)
}

// ---------- 自建 canvasFactory（Node 渲染必需；doc.canvasFactory 在 Node 下无默认实现） ----------
const canvasFactory = {
  create(w, h) {
    const c = createCanvas(Math.ceil(w), Math.ceil(h))
    return { canvas: c, context: c.getContext("2d") }
  },
  reset(cc, w, h) {
    cc.canvas.width = Math.ceil(w)
    cc.canvas.height = Math.ceil(h)
  },
  destroy(cc) {
    cc.canvas = null
    cc.context = null
  },
}

// ---------- pdfjs 资源参数（wasm/字体/cMap，修复 JBIG2 静默空白） ----------
const req = createRequire(import.meta.url)
const pdfjsPkgDir = path.dirname(req.resolve("pdfjs-dist/package.json"))
// pdfjs 的 url 类参数（cMapUrl/standardFontDataUrl/wasmUrl）要求正斜杠且以 / 结尾（getFactoryUrlProp 校验 endsWith("/")），
// Windows path.sep 是反斜杠会直接抛 Invalid factory url，故统一转正斜杠（2026-10-24 实测）
const pkgUrl = (sub) => path.join(pdfjsPkgDir, sub).replace(/\\/g, "/") + "/"
const docParams = {
  isEvalSupported: false,
  useSystemFonts: true,
  verbosity: 0,
  canvasFactory,
  cMapUrl: pkgUrl("cmaps"),
  cMapPacked: true,
  standardFontDataUrl: pkgUrl("standard_fonts"),
  wasmUrl: pkgUrl("wasm"),
}

// ---------- 基础工具 ----------
/** 矩阵乘：pdfjs OPS.transform 语义 = 当前 CTM 乘以新矩阵（与 canvas transform 一致） */
function mul(m, t) {
  return [
    m[0] * t[0] + m[1] * t[2],
    m[0] * t[1] + m[1] * t[3],
    m[2] * t[0] + m[3] * t[2],
    m[2] * t[1] + m[3] * t[3],
    m[4] * t[0] + m[5] * t[2] + t[4],
    m[4] * t[1] + m[5] * t[3] + t[5],
  ]
}
/** CTM 下单位方形四角 → 页面坐标 bbox（y 向上） */
function bboxOf(m) {
  const xs = [m[4], m[4] + m[0], m[4] + m[2], m[4] + m[0] + m[2]]
  const ys = [m[5], m[5] + m[1], m[5] + m[3], m[5] + m[1] + m[3]]
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
/** bbox 相交（含 pad） */
function bboxHits(a, b, pad = 0) {
  return a.x0 < b.x1 + pad && a.x1 > b.x0 - pad && a.y0 < b.y1 + pad && a.y1 > b.y0 - pad
}

// ---------- caption 识别 ----------
/**
 * 双正则 caption 判定：返回 {no} 或 null。
 * 第一条：带分隔符（Figure 1. / FIG.2: / Figure 4A]）
 * 第二条：无分隔符紧跟大写字母或中文（Figure 1Single-cell，23 篇 13 条全漏的根因）
 * 裸「Figure 3」（页顶短标签）也算 caption。
 */
function captionInfo(text) {
  const m = /^(Fig(?:ure)?\.?\s*(\d{1,2}))/i.exec(text)
  if (!m) return null
  const rest = text.slice(m[0].length)
  if (rest.trim() === "") return { no: Number(m[2]) }
  if (/^[A-Za-z]?\s*[.:|\]]/.test(rest)) return { no: Number(m[2]) }
  if (/^[A-Z\u4e00-\u9fff]/.test(rest) || (/^[a-z]/.test(rest) && !rest.startsWith(" "))) return { no: Number(m[2]) } // 小写仅认连写（figure 1abc）；带前导空格的小写正文句不算，防误判
  return null
}
/** kind：short = 页顶短标签（<15 字符），full = 完整图题 */
function captionKind(line) {
  const info = captionInfo(line.text)
  if (!info) return null
  return line.text.length >= 15 ? "full" : "short"
}
/** 页码行：纯数字且贴近页顶/页底 */
function isPageNo(line, pageH) {
  return /^\d{1,4}$/.test(line.text) && (line.yTop > pageH - 70 || line.yBot < 70)
}
/** 正文状宽行（拦截图区域上界 + 文本密度过滤双用） */
function isBodyLike(line, colL, colR) {
  return line.text.length > 50 && line.x1 - line.x0 > 0.5 * (colR - colL)
}
/**
 * 完整图题链：caption 起始行 + 下方紧邻延续行。
 * v1 的间隔判断（l.yTop - capEnd.yBot < 14）对下方行恒为负、永不截断 → 拖正文（v1 08 篇 880 字 caption）。
 * v2 改为正向间隔 gap = capEnd.yBot - l.yTop，仅收 [−2, 13) 的紧邻行，且字号差与缩进受限；遇下一条 caption 起始行即停。
 */
function captionChain(content, cap, sizeTol = 0.6) {
  const below = content
    .filter((l) => l !== cap && l.yTop < cap.yTop && cap.yTop - l.yTop < 150)
    .filter((l) => Math.abs(l.size - cap.size) <= sizeTol)
    .filter((l) => Math.min(l.x1, cap.x1) - Math.max(l.x0, cap.x0) > 0.6 * Math.min(l.x1 - l.x0, cap.x1 - cap.x0))
    .filter((l) => Math.abs(l.x0 - cap.x0) < 20)
    .filter((l) => !captionInfo(l.text))
    .sort((a, b) => b.yTop - a.yTop)
  let capEnd = cap
  const lines = [cap]
  for (const l of below) {
    const gap = capEnd.yBot - l.yTop
    if (gap >= -2 && gap < 13) { lines.push(l); capEnd = l } else break
  }
  return { text: lines.map((l) => l.text).join(" "), end: capEnd }
}

// ---------- 文本层：行级 bbox ----------
async function extractLines(page) {
  const viewport = page.getViewport({ scale: 1 })
  const pageW = viewport.width
  const pageH = viewport.height
  const tc = await page.getTextContent()
  const items = []
  for (const it of tc.items) {
    if (!it.str || !it.str.trim()) continue
    const [a, b, , d, e, f] = it.transform
    const size = Math.max(Math.abs(a), Math.abs(d)) || Math.abs(b)
    items.push({ text: it.str, x0: e, x1: e + it.width, y: f, size })
  }
  items.sort((p, q) => q.y - p.y || p.x0 - q.x0)
  const lines = []
  let cur = []
  for (const it of items) {
    if (cur.length === 0 || Math.abs(cur[cur.length - 1].y - it.y) < 2.5) cur.push(it)
    else { lines.push(cur); cur = [it] }
  }
  if (cur.length) lines.push(cur)
  return {
    pageW,
    pageH,
    lines: lines.map((grp) => {
      grp.sort((p, q) => p.x0 - q.x0)
      return {
        text: grp.map((g) => g.text).join("").replace(/\s+/g, " ").trim(),
        x0: Math.min(...grp.map((g) => g.x0)),
        x1: Math.max(...grp.map((g) => g.x1)),
        yTop: Math.max(...grp.map((g) => g.y + g.size * 0.9)),
        yBot: Math.min(...grp.map((g) => g.y - g.size * 0.25)),
        size: grp[0].size,
      }
    }),
  }
}

// ---------- operatorList 扫描：位图绘制记录 + 矢量 op 计数 ----------
const PAINT_OPS = new Set([OPS.paintImageXObject, OPS.paintImageXObjectRepeat, OPS.paintJpegXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject])
async function scanPageOps(page) {
  const ops = await page.getOperatorList()
  let ctm = [1, 0, 0, 1, 0, 0]
  const stack = []
  const draws = []
  const vecBboxes = []
  let vectorOps = 0
  const fnArray = ops.fnArray
  const argsArray = ops.argsArray
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i]
    if (fn === OPS.save) stack.push(ctm)
    else if (fn === OPS.restore) ctm = stack.pop() ?? ctm
    else if (fn === OPS.transform) ctm = mul(ctm, argsArray[i])
    else if (PAINT_OPS.has(fn)) {
      const args = argsArray[i]
      let objId = `inline_${draws.length}`
      let w = 0
      let h = 0
      if (fn === OPS.paintInlineImageXObject) {
        w = args[0]?.width ?? 0
        h = args[0]?.height ?? 0
      } else {
        objId = String(args[0])
        w = args[1] ?? 0
        h = args[2] ?? 0
      }
      draws.push({ objId, w, h, bbox: bboxOf(ctm), theta: (Math.atan2(ctm[1], ctm[0]) * 180) / Math.PI })
    } else if (fn === OPS.constructPath || fn === OPS.fill || fn === OPS.eoFill || fn === OPS.stroke || fn === OPS.fillStroke) {
      vectorOps++
      // 矢量 bbox 记录（2026-10-24 51 篇实测驱动）：pdfjs 6 constructPath args[2] = 路径本地 minMax
      // {minX,minY,maxX,maxY}，经当前 CTM 四角变换即页面坐标 bbox。用于图内标注行过滤与混合图矢量并窗。
      if (fn === OPS.constructPath && vecBboxes.length < 2000) {
        const mm = argsArray[i]?.[2]
        if (mm && typeof mm === "object" && Number.isFinite(mm[0]) && Number.isFinite(mm[3])) {
          const corners = [[mm[0], mm[1]], [mm[2], mm[1]], [mm[0], mm[3]], [mm[2], mm[3]]].map(([x, y]) => [x * ctm[0] + y * ctm[2] + ctm[4], x * ctm[1] + y * ctm[3] + ctm[5]])
          const bx0 = Math.min(...corners.map((c) => c[0])), by0 = Math.min(...corners.map((c) => c[1]))
          const bx1 = Math.max(...corners.map((c) => c[0])), by1 = Math.max(...corners.map((c) => c[1]))
          if (bx1 - bx0 < 2000 && by1 - by0 < 2000) vecBboxes.push({ x0: bx0, y0: by0, x1: bx1, y1: by1 }) // 异常巨 path 丢弃，防病态页
        }
      }
    }
  }
  return { draws, vectorOps, vecBboxes }
}

// ---------- 渲染与空白检测 ----------
const pageObjCache = new Map()
async function getPageObj(doc, pageNo) {
  if (!pageObjCache.has(pageNo)) pageObjCache.set(pageNo, await doc.getPage(pageNo))
  return pageObjCache.get(pageNo)
}
/** 渲染整页 PNG buffer（scale 由调用方按原生分辨率自适应） */
async function renderPagePng(doc, pageNo, scale) {
  const page = await getPageObj(doc, pageNo)
  const vp = page.getViewport({ scale })
  const cc = canvasFactory.create(vp.width, vp.height)
  try {
    await page.render({ canvasContext: cc.context, viewport: vp }).promise
    return cc.canvas.toBuffer("image/png")
  } finally {
    canvasFactory.destroy(cc)
  }
}
/** 空白检测：灰度 stdev < 2 判空白（JBIG2 未解码时画面全白在此拦截） */
async function blankInfo(png) {
  const st = await sharp(png).grayscale().stats()
  return { stdev: st.channels[0].stdev, mean: st.channels[0].mean, blank: st.channels[0].stdev < 2 }
}

// ---------- 读阶段 1 产物 + 跨页重复过滤 ----------
const perPageEmb = new Map()
for (const e of embedData.entries || []) {
  if (!perPageEmb.has(e.page)) perPageEmb.set(e.page, [])
  perPageEmb.get(e.page).push(e)
}
// 跨页感知哈希重复：>=30% 页出现（至少 3 页）判装饰图剔除（v1 bug #4 的兜底层）；
// 页数基准在第 1 步 prescan 后用本进程 doc.numPages（审核 J1：fig_embed 不产出 totalPages，旧写法恒 false 死代码）
const hashPages = new Map()
for (const e of embedData.entries || []) {
  if (!hashPages.has(e.phash)) hashPages.set(e.phash, new Set())
  hashPages.get(e.phash).add(e.page)
}
/** 页内见过的位图最大宽（含被过滤项）→ 整页渲染 dpi 自适应用 */
function pageBitmapMaxW(pageNo) {
  const list = (embedData.perPageBitmaps || {})[String(pageNo)] || []
  return list.reduce((mx, b) => Math.max(mx, b.w || 0), 0)
}
/** 整页渲染 scale：有位图见证时按 最宽位图/页宽 算，clamp [2.5, 4]；无见证 2.5 */
function fullpageScale(pageNo, pageW) {
  const mw = pageBitmapMaxW(pageNo)
  return mw > 0 ? clamp(mw / pageW, 2.5, 4) : 2.5
}

// ---------- 第 1 步：全页预扫描（文本层 + 绘制记录） ----------
console.log(`[render 1/4] prescan text+ops: ${pdfPath}`)
const doc = await getDocument({ data: new Uint8Array(fs.readFileSync(pdfPath)), ...docParams }).promise
const N = doc.numPages
const pageCtx = []
for (let p = 1; p <= N; p++) {
  const page = await getPageObj(doc, p)
  const ex = await extractLines(page)
  const { draws, vectorOps, vecBboxes } = await scanPageOps(page)
  // 整页框过滤（2026-10-25 03 篇回归实测驱动）：宽高双 ≥95% 页面的簇是页面装饰边框/转换工具
  // 加的裁剪框，不是图形内容——留着会让 inVec 把全部正文行判成图内行（up 全排除窗口撑大）、
  // 让 b 分支并窗把窗口并成整页。过滤后 inVec/大簇兜底/矢量并窗全部受益。
  pageCtx.push({ p, ...ex, draws, vectorOps, vecClusters: clusterBboxes(vecBboxes, 14).filter((v) => !(v.x1 - v.x0 > ex.pageW * 0.95 && v.y1 - v.y0 > ex.pageH * 0.95)) })
}
console.log(`pages: ${N}`)
{
  const junkHashes = new Set()
  for (const [h, pages] of hashPages) {
    if (pages.size >= 3 && pages.size >= Math.ceil(0.3 * N)) {
      junkHashes.add(h)
      issue("junk-repeat-page-hash", { phash: h, pages: pages.size, of: N })
    }
  }
  for (const [p, list] of perPageEmb) perPageEmb.set(p, list.filter((e) => !junkHashes.has(e.phash)))
}

// ---------- 第 2 步：legends 汇总页识别（`{图号: 全文}` 回填映射） ----------
const legendsMap = new Map()
for (const ctx of pageCtx) {
  const content = ctx.lines.filter((l) => !isPageNo(l, ctx.pageH))
  const capLines = content.filter((l) => captionKind(l))
  const hasRealEmb = (perPageEmb.get(ctx.p) || []).length > 0
  if (capLines.length >= 3 && !hasRealEmb && ctx.draws.length === 0) {
    ctx.isLegends = true // 图注汇总页：只回填映射不产图——2026-10-25 03 篇实测该类页裁剪产物 17/17 全为图注文字假图，红线不放假图
    for (const cap of capLines) {
      const info = captionInfo(cap.text)
      if (!info) continue
      const chain = captionChain(content, cap)
      if (!legendsMap.has(info.no)) legendsMap.set(info.no, chain.text)
    }
  }
}
if (legendsMap.size) console.log(`[legends] 回填映射 ${legendsMap.size} 条`)

// ---------- 渲染缓存（同页多图组复用同一次渲染） ----------
const pagePngCache = new Map()
async function renderedPage(p, scale) {
  const key = `${p}@${scale}`
  if (!pagePngCache.has(key)) pagePngCache.set(key, await renderPagePng(doc, p, scale))
  return pagePngCache.get(key)
}

/** CTM bbox 邻接聚类（pad 内相交合并为逻辑图组） */
function clusterBboxes(bboxes, pad = 18) {
  const groups = bboxes.map((b) => [b])
  let merged = true
  while (merged) {
    merged = false
    outer: for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        if (groups[i].some((a) => groups[j].some((b) => bboxHits(a, b, pad)))) {
          groups[i] = groups[i].concat(groups[j])
          groups.splice(j, 1)
          merged = true
          break outer
        }
      }
    }
  }
  return groups.map((g) => ({
    x0: Math.min(...g.map((b) => b.x0)),
    y0: Math.min(...g.map((b) => b.y0)),
    x1: Math.max(...g.map((b) => b.x1)),
    y1: Math.max(...g.map((b) => b.y1)),
    parts: g.length,
  }))
}

/** caption 选择：距图 bbox 最近的 caption 行（上/下取近）；legends 回填优先，全文链次之 */
function captionFor(bbox, content) {
  let best = null
  let bestDist = Infinity
  for (const l of content) {
    if (!captionKind(l)) continue
    if (l.yTop > bbox.y0 && l.yBot < bbox.y1) continue // 与图相交的行不是它的 caption
    const dist = l.yTop > bbox.y1 ? l.yBot - bbox.y1 : bbox.y0 - l.yTop
    if (dist < bestDist) { bestDist = dist; best = l }
  }
  if (!best) return ""
  const info = captionInfo(best.text)
  if (info && legendsMap.has(info.no)) return legendsMap.get(info.no)
  if (captionKind(best) === "full") return captionChain(content, best).text
  return best.text
}

// ---------- 第 3 步：逐页五分支决策树 ----------
console.log(`[render 2/4] route pages`)
const figs = [] // {page, origin, caption, top, png?|tmpFile?, rotate?}
for (const ctx of pageCtx) {
  const { p, pageW, pageH, lines, draws, vecClusters } = ctx
  const content = lines.filter((l) => !isPageNo(l, pageH))
  const hasText = content.length > 2
  const embs = perPageEmb.get(p) || []
  if (ctx.isLegends) continue // 图注汇总页：映射已在第 2 步回填，页面本身不产图（2026-10-25 03 篇回归修复）
  // 图内标注行判定（2026-10-24 51 篇 Fig.4 实测驱动）：行面积 ≥35% 与矢量簇相交 = 图内文字
  //（轴标签/子图编号/图例），不是正文——up 查找与文字覆盖统计必须排除，否则窗口塌缩误杀整图
  const inVec = (l) => (vecClusters || []).some((v) => {
    const ix = Math.min(l.x1, v.x1) - Math.max(l.x0, v.x0)
    const iy = Math.min(l.yTop, v.y1) - Math.max(l.yBot, v.y0)
    if (ix <= 0 || iy <= 0) return false
    const lw = Math.max(1e-6, l.x1 - l.x0), lh = Math.max(1e-6, l.yTop - l.yBot)
    return (ix * iy) / (lw * lh) > 0.35
  })

  // 真图 ↔ 绘制记录按 (w,h) 贪心配对（同尺寸多张按顺序近似）
  const drawPool = [...draws]
  const paired = embs.map((e) => {
    const idx = drawPool.findIndex((d) => d.w === e.w && d.h === e.h)
    return { e, d: idx >= 0 ? drawPool.splice(idx, 1)[0] : null }
  })

  if (embs.length >= 2) {
    // ---- b. 碎片页：CTM bbox 聚类 → 渲染整页 → 按逻辑图组并集裁剪 ----
    const bboxes = paired.map((x) => x.d?.bbox).filter(Boolean)
    if (!bboxes.length) { issue("frag-no-ctm", { page: p }); continue }
    // Form XObject 坐标系失真守卫（2026-10-24 49 篇实测）：图像包在 Form group 内时，opList 线性
    // CTM 跟踪拿到内部坐标系平移（e/f 巨大但 w/h 正常），bbox 飞出页外，渲染裁剪必产 1px 废图。
    // 判据：bbox 超页界（容差 2pt）或退化（<5pt）。失真页不信裁剪坐标，全部碎片回退 embedded
    // 直提（碎片本身是完整位图，直提即最高质量），不放假图。
    const bboxOk = (b) => b.x0 >= -2 && b.y0 >= -2 && b.x1 <= pageW + 2 && b.y1 <= pageH + 2 && b.x1 - b.x0 >= 5 && b.y1 - b.y0 >= 5
    if (!paired.every((x) => x.d && bboxOk(x.d.bbox))) {
      issue("frag-ctm-offpage-fallback-embed", { page: p, n: embs.length })
      for (const { e } of paired) figs.push({ page: p, origin: "embedded", caption: "", tmpFile: e.tmpFile })
      continue
    }
    const groups = clusterBboxes(bboxes)
    // 混合图矢量并窗（2026-10-24 51 篇 Fig.1 实测驱动）：位图子图（照片）与矢量子图（曲线/示意）
    // 混排时，纯位图并集裁剪会丢矢量子图 → 与组邻近（pad 30pt）的矢量簇迭代并入窗口
    for (const g of groups) {
      let grew = true
      while (grew) {
        grew = false
        for (const v of vecClusters || []) {
          if ((v.x1 - v.x0) < 8 || (v.y1 - v.y0) < 8) continue
          if (bboxHits(g, v, 30)) {
            const nx0 = Math.min(g.x0, v.x0), ny0 = Math.min(g.y0, v.y0), nx1 = Math.max(g.x1, v.x1), ny1 = Math.max(g.y1, v.y1)
            if (nx0 !== g.x0 || ny0 !== g.y0 || nx1 !== g.x1 || ny1 !== g.y1) { g.x0 = nx0; g.y0 = ny0; g.x1 = nx1; g.y1 = ny1; grew = true }
          }
        }
      }
    }
    const scale = fullpageScale(p, pageW)
    const png = await renderedPage(p, scale)
    if ((await blankInfo(png)).blank) { issue("render-blank-frag-page", { page: p }); continue }
    const meta = await sharp(png).metadata()
    for (const g of groups) {
      const left = clamp(Math.floor(g.x0 * scale) - 3, 0, meta.width - 1)
      const top = clamp(Math.floor((pageH - g.y1) * scale) - 3, 0, meta.height - 1)
      const width = clamp(Math.ceil((g.x1 - g.x0) * scale) + 6, 1, meta.width - left)
      const height = clamp(Math.ceil((g.y1 - g.y0) * scale) + 6, 1, meta.height - top)
      if (width < 50 || height < 50) { issue("crop-degenerate", { page: p, width, height, parts: g.parts }); continue } // 退化裁剪不产废图
      figs.push({ page: p, origin: "render-crop", top, caption: captionFor(g, content), png: await sharp(png).extract({ left, top, width, height }).png().toBuffer() })
    }
  } else if (embs.length === 1) {
    const { e, d } = paired[0]
    const theta = d ? d.theta : 0
    const bbox = d?.bbox || { x0: 0, y0: 0, x1: pageW, y1: pageH }
    if (Math.abs(theta) < 2 || Math.abs(Math.abs(theta) - 180) < 2) {
      // ---- a. 单图无旋转：内嵌直提（原生分辨率） ----
      figs.push({ page: p, origin: "embedded", caption: captionFor(bbox, content), tmpFile: e.tmpFile })
    } else {
      // ---- c. 绘制带旋转：直提 + 转正（sharp 顺时针 = -theta；01 篇 fig_5 侧躺即此） ----
      figs.push({ page: p, origin: "rotated-embedded", caption: captionFor(bbox, content), rotate: -theta, tmpFile: e.tmpFile })
    }
  } else {
    // ---- d/e. 无真图页 ----
    const scale = fullpageScale(p, pageW)
    const capLines = content.filter((l) => captionKind(l))
    if (!hasText) {
      // e. 纯扫描页：渲染整页 → 空白拦截 → 整页附
      const png = await renderedPage(p, scale)
      if ((await blankInfo(png)).blank) { issue("scan-page-blank", { page: p }); continue }
      figs.push({ page: p, origin: "fullpage", caption: "", top: 0, png })
    } else if (capLines.length || content.some((l) => /\bFIG\.?\s*\d{1,2}\s*[.:]/.test(l.text))) {
      // d. 有文本层有 caption 信号：行级命中 → 按 caption 上方窗口裁剪；
      // 行级未命中但行内有 FIG 信号（两栏 OCR 乱序，caption 不在行首，09 篇 p4/p5 即此）→ 整页附（用户规则：扫描件整页附）
      if (!capLines.length) {
        const png = await renderedPage(p, scale)
        if ((await blankInfo(png)).blank) { issue("scan-page-blank", { page: p }); continue }
        figs.push({ page: p, origin: "fullpage", caption: "", top: 0, png })
        continue
      }
      for (const cap of capLines) {
        const info = captionInfo(cap.text)
        const chain = captionKind(cap) === "full" ? captionChain(content, cap) : { end: cap }
        const capEndY = chain.end.yBot
        // 图区域上界：capEndY 向上找正文状行/上一 caption，窗口 340pt
        const up = content
          .filter((l) => l !== cap && l.yBot > capEndY && l.yBot < capEndY + 340)
          .filter((l) => !inVec(l)) // 图内标注行不当正文上界（纯矢量图防窗口塌缩）
          .filter((l) => isBodyLike(l, 0, pageW) || captionKind(l))
          .sort((a, b) => a.yBot - b.yBot)[0]
        const topEdge = up ? up.yBot + 2 : Math.min(capEndY + 320, pageH - 8)
        // 用户规则（2026-10-24 拍板）：横带内文本行覆盖 ≥ 1/3 高度 = 文字段假图，不放假图；
        // 降级整页高清截取（origin=fullpage）供用户手动裁剪。触发场景：双栏扫描件 OCR 行宽不过
        // isBodyLike 阈值致窗口罩住正文（09 篇 fig_4 即此）/ 图注在图上方的排版。
        const bandH = topEdge - capEndY
        if (bandH < 60) {
          // 大矢量簇兜底（2026-10-24 51 篇 Fig.4 实测驱动）：caption 上方有大矢量簇（纯矢量图）时，
          // 窗口薄 = up 被图内行塌缩的信号，整页兜底不丢图；无矢量簇才按 legends 孤行拦截
          const bigVec = (vecClusters || []).some((v) => v.y1 > capEndY + 20 && v.y0 < capEndY + 400 && v.y1 - v.y0 > 60 && v.x1 - v.x0 > pageW * 0.3)
          if (bigVec) {
            issue("vec-figure-fullpage-fallback", { page: p, fig: info ? info.no : null })
            const pngFp = await renderedPage(p, scale)
            if (!(await blankInfo(pngFp)).blank) figs.push({ page: p, origin: "fullpage", caption: info && legendsMap.has(info.no) ? legendsMap.get(info.no) : captionChain(content, cap).text, top: 0, png: pngFp })
            continue
          }
          issue("crop-window-thin", { page: p, fig: info ? info.no : null, bandH: +bandH.toFixed(1) }); continue // 窗口薄于约 2.1cm：legends 行/目录行孤行，正常图不会这么扁，渲染前拦截（2026-10-24 03 篇 legends 页文字横条假图实测）
        }
        const bandCover = content
          .filter((l) => l !== cap && !capLines.includes(l) && !inVec(l) && l.yBot > capEndY && l.yTop < topEdge)
          .reduce((s, l) => s + Math.max(0, Math.min(l.yTop, topEdge) - Math.max(l.yBot, capEndY)), 0)
        const png = await renderedPage(p, scale)
        if (bandH >= 60 && bandCover / bandH > 1 / 3) {
          issue("crop-text-band", { page: p, fig: info ? info.no : null, cover: +(bandCover / bandH).toFixed(2) })
          if (!(await blankInfo(png)).blank) figs.push({ page: p, origin: "fullpage", caption: "", top: 0, png })
          continue
        }
        if ((await blankInfo(png)).blank) { issue("render-blank-text-page", { page: p }); continue }
        const meta = await sharp(png).metadata()
        const left = 0
        const top = clamp(Math.floor((pageH - topEdge) * scale) - 2, 0, meta.height - 1)
        const width = meta.width
        const height = clamp(Math.ceil((topEdge - capEndY) * scale) + 4, 1, meta.height - top)
        if (height < 50) { issue("crop-too-thin", { page: p }); continue }
        figs.push({ page: p, origin: "render-crop", top, caption: info && legendsMap.has(info.no) ? legendsMap.get(info.no) : captionChain(content, cap).text, png: await sharp(png).extract({ left, top, width, height }).png().toBuffer() })
      }
    }
    // 有文本层无 caption 的纯文字页：不产出（正常）
  }
}

// ---------- 第 4 步：落盘编排（统一编号 + manifest） ----------
console.log(`[render 3/4] write outputs`)
figs.sort((a, b) => a.page - b.page || (a.top ?? 0) - (b.top ?? 0))
// 旧图清理 + 用户手动件保护（审核 J3）：mtime 新于旧 manifest 的 fig_N.png（或 manifest 未记载的）
// 视为用户按整页兜底工作流手动替换/添加的文件，移入 _user_saved/ 不删，stdout 告知
const oldMfPath = path.join(outDir, "manifest.json")
const oldKnown = new Set()
let oldMtime = -1
if (fs.existsSync(oldMfPath)) {
  oldMtime = fs.statSync(oldMfPath).mtimeMs
  const oldMf = JSON.parse(fs.readFileSync(oldMfPath, "utf8"))
  for (const e of Array.isArray(oldMf) ? oldMf : []) oldKnown.add(e.file)
}
const userSaved = []
for (const f of fs.readdirSync(outDir).filter((f) => /^fig_\d+\.png$/.test(f))) {
  const fp = path.join(outDir, f)
  if (fs.statSync(fp).mtimeMs > oldMtime || !oldKnown.has(f)) {
    fs.mkdirSync(path.join(outDir, "_user_saved"), { recursive: true })
    fs.renameSync(fp, path.join(outDir, "_user_saved", f))
    userSaved.push(f)
  } else {
    fs.unlinkSync(fp)
  }
}
if (userSaved.length) console.log(`[render] 保护性转移 ${userSaved.length} 个手动修改/新增图（新于上次 manifest）-> _user_saved/: ${userSaved.join(", ")}`)
const manifest = []
let n = 0
for (const f of figs) {
  n++
  const file = `fig_${n}.png`
  const out = path.join(outDir, file)
  if (f.png) fs.writeFileSync(out, f.png)
  else if (f.rotate) await sharp(f.tmpFile).rotate(f.rotate).png().toFile(out)
  else fs.copyFileSync(f.tmpFile, out)
  manifest.push({ file, page: f.page, origin: f.origin, caption: f.caption })
}
fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8")
const md = ["# 提图清单", "", "| 文件 | 页码 | 来源 | caption |", "|---|---|---|---|"]
for (const m of manifest) md.push(`| ${m.file} | p${m.page} | ${m.origin} | ${(m.caption || "未抓到").replace(/\|/g, "/").slice(0, 120)} |`)
fs.writeFileSync(path.join(outDir, "manifest.md"), md.join("\n"), "utf8")
fs.writeFileSync(path.join(outDir, "issues.json"), JSON.stringify(issues, null, 2), "utf8") // 异常登记落盘，整页/裁剪条目人工过目排障先查它（审核 J2）
fs.rmSync(tmpDir, { recursive: true, force: true })
const tally = {}
for (const m of manifest) tally[m.origin] = (tally[m.origin] || 0) + 1
console.log(`[render 4/4] RENDER-DONE: ${manifest.length} figs ${JSON.stringify(tally)} -> ${outDir}`)
