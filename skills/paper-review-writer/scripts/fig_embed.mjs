/**
 * fig-batch-embed.mjs —— 阶段 1（v2）：pdf-parse getImage 提内嵌位图 + 垃圾位图过滤（独立进程）
 *
 * 设计思路：
 * 进程隔离纪律：pdf-parse@2.4.5 内置 pdfjs@5.4.296，与工作区 pdfjs-dist@6 的 globalThis.pdfjsWorker
 * 全局污染（v1 bug #1），本脚本只 import pdf-parse，渲染/文本层在 fig-batch-render.mjs 单独进程跑。
 * v2 新增（对应必修清单 2 / 7）：
 *   ① 垃圾过滤扩充：minSide<120 / 面积<30000 / 高宽比>8 条带 / 近纯色白图（小文件跑 sharp stats，
 *      stdev<2 判纯色）；过滤只改 entries，不改写页面分类（页面分类在阶段 2 看真图）。
 *   ② 感知哈希 phash（16x16 灰度 raw 的 sha1）：供阶段 2 做跨页重复检测（>=30% 页出现判装饰图）。
 *   ③ perPageBitmaps：逐页记录所有见到位图的尺寸（含被过滤的），供阶段 2 渲染 dpi 自适应与
 *      「页面画过位图但全被过滤」的兜底判定。
 *
 * 用法：node scripts/fig-batch-embed.mjs <pdf绝对路径> <输出目录> <日志目录>
 * 产物：<日志目录>/<目录名>_embed.json + <输出目录>/_tmp/emb_<k>.png（待阶段 2 编排改名）
 */

import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { PDFParse } from "pdf-parse"
import sharp from "sharp"

const [, , pdfPath, outDir, logsDir] = process.argv
if (!pdfPath || !outDir || !logsDir) {
  console.error("usage: node scripts/fig-batch-embed.mjs <pdfAbsPath> <outDir> <logsDir>")
  process.exit(1)
}
fs.mkdirSync(outDir, { recursive: true })
fs.mkdirSync(logsDir, { recursive: true })
const tmpDir = path.join(outDir, "_tmp")
fs.mkdirSync(tmpDir, { recursive: true })

const issues = []
/** 异常登记：全部进 embed.json 的 issues 数组（阶段 2 合并落盘） */
function issue(type, detail = {}) {
  issues.push({ type, ...detail })
  console.log(`[ISSUE] ${type} ${JSON.stringify(detail).slice(0, 240)}`)
}

/** 图片魔数嗅探（PNG / JPEG / JP2 / BMP / TIFF / GIF，其余 unknown 进 issues） */
function magicOf(buf) {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png"
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg"
  if (buf.length >= 4 && buf.slice(0, 4).toString("hex") === "0000000c") return "jp2"
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return "bmp"
  if (buf.length >= 4 && buf.slice(0, 4).toString("latin1").startsWith("II*")) return "tiff"
  if (buf.length >= 6 && buf.slice(0, 3).toString("latin1") === "GIF") return "gif"
  return "unknown"
}

/** 感知哈希：缩到 16x16 灰度 raw 字节再 sha1（同图跨页重复检测用，与字节级 sha1 互补） */
async function phashOf(png) {
  const raw = await sharp(png).greyscale().resize(16, 16, { fit: "fill" }).raw().toBuffer()
  return crypto.createHash("sha1").update(raw).digest("hex").slice(0, 12)
}

/** 近纯色判定：仅对小文件跑（防大图 stats 变慢）；stdev < 2 视为纯色，mean 偏白才算垃圾白图 */
async function isNearFlatWhite(png, bytes) {
  if (bytes > 150_000) return false
  const st = await sharp(png).grayscale().stats()
  return st.channels[0].stdev < 2 && st.channels[0].mean > 200
}

console.log(`[embed] pdf-parse getImage: ${pdfPath}`)
const parser = new PDFParse({ data: new Uint8Array(fs.readFileSync(pdfPath)) })
const imgResult = await parser.getImage()
const embPageList = imgResult.pages || []
const entries = [] // 合格内嵌图：{page, tmpFile, w, h, fmt, bytes, phash}
const perPageBitmaps = new Map() // page -> [{w,h}]（含被过滤项，封顶 60 条/页）
const failPages = new Set() // 出现过提取/转换失败的页
const seenEmb = new Set() // 同页同字节去重
let seen = 0
let k = 0
for (const pg of embPageList) {
  const pageNo = pg.pageNumber ?? pg.page
  for (const im of pg.images || []) {
    seen++
    const w0 = im.width || 0
    const h0 = im.height || 0
    if (!perPageBitmaps.has(pageNo)) perPageBitmaps.set(pageNo, [])
    const bmList = perPageBitmaps.get(pageNo)
    if (bmList.length < 60) bmList.push({ w: w0, h: h0 })
    const buf = im.buffer || im.data || (im.dataUrl ? Buffer.from(im.dataUrl.split(",")[1], "base64") : null)
    if (!buf) { issue("embed-no-buffer", { page: pageNo, keys: Object.keys(im).join(",") }); failPages.add(pageNo); continue }
    const fmt = magicOf(buf)
    let png = null
    let w = w0
    let h = h0
    if (fmt === "png") {
      png = buf
    } else {
      if (fmt === "unknown") issue("embed-magic-unknown", { page: pageNo, w, h, head: buf.slice(0, 8).toString("hex").toUpperCase(), bytes: buf.length })
      try {
        png = await sharp(buf).png().toBuffer() // jpeg 等可解码格式统一转 png，保证扩展名与字节一致
        const meta = await sharp(png).metadata()
        if (!w) w = meta.width
        if (!h) h = meta.height
      } catch (e) {
        issue("embed-convert-failed", { page: pageNo, w, h, fmt, err: String(e).slice(0, 180) })
        failPages.add(pageNo)
        continue
      }
    }
    if (!w || !h) {
      const meta = await sharp(png).metadata()
      w = meta.width; h = meta.height
    }
    // 垃圾过滤 ①：尺寸/形状（minSide<120 过小、面积<30000、高宽比>8 条带）
    const minSide = Math.min(w, h)
    const longSide = Math.max(w, h)
    if (minSide < 120 || w * h < 30000) { issue("junk-small", { page: pageNo, w, h, fmt }); continue }
    if (longSide / minSide > 8) { issue("junk-strip-aspect", { page: pageNo, w, h, fmt }); continue }
    // 垃圾过滤 ②：近纯色白图（只对小文件跑 stats，防慢）
    if (await isNearFlatWhite(png, buf.length)) { issue("junk-near-flat-white", { page: pageNo, w, h, fmt, bytes: buf.length }); continue }
    // 同页同字节去重（同一 XObject 被引用两次的情形）
    const dedupeKey = `${pageNo}:${crypto.createHash("sha1").update(buf).digest("hex").slice(0, 12)}`
    if (seenEmb.has(dedupeKey)) { issue("embed-duplicate", { page: pageNo, w, h, fmt }); continue }
    seenEmb.add(dedupeKey)
    k++
    const tmpFile = path.join(tmpDir, `emb_${k}.png`)
    fs.writeFileSync(tmpFile, png)
    const phash = await phashOf(png)
    entries.push({ page: pageNo, tmpFile, w, h, fmt, bytes: buf.length, phash })
    console.log(`embedded: p${pageNo} ${w}x${h} fmt=${fmt} phash=${phash}`)
  }
}
await parser.destroy()

const outJson = path.join(logsDir, `${path.basename(outDir)}_embed.json`)
fs.writeFileSync(
  outJson,
  JSON.stringify(
    { pdf: pdfPath, seen, kept: entries.length, entries, perPageBitmaps: Object.fromEntries(perPageBitmaps), failPages: [...failPages], issues },
    null,
    2
  ),
  "utf8"
)
console.log(`EMBED-DONE: seen=${seen} kept=${entries.length} failPages=[${[...failPages].join(",")}] -> ${outJson}`)
