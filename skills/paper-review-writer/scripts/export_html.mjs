/**
 * export_html.mjs —— 第 5 步引擎：综述 Markdown → 单页自包含 HTML（图片 base64 内嵌，零外链）
 *
 * 设计思路：
 * 解析用 marked（主流解析器、零依赖、维护活跃）负责 md→HTML；自包含通过后处理实现——
 * <img> 的本地相对路径转 base64 data URI，CSS 内嵌进 <style>，产出单文件离线可开。
 * 不引 KaTeX/mermaid CDN：真自包含要求离线可开，公式按原样显示（局限已在 SKILL.md 声明）。
 * 本步独立可重入：只读综述 md 与其引用的本地图片，不依赖其他阶段状态——
 * 用户手动裁剪整页图并更新 md 后，重跑本步即可，不回跑精读与成文。
 *
 * 双用：既被 review.mjs 的 export-html 子命令 import，也可独立 CLI 跑：
 *   node export_html.mjs <in.md> [out.html]
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { marked } from "marked"

const MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
}

const CSS = `
  body { font-family: "Segoe UI", "Microsoft YaHei", sans-serif; color: #24292f; background: #ffffff;
         max-width: 880px; margin: 0 auto; padding: 40px 28px; line-height: 1.75; }
  h1 { border-bottom: 2px solid #d0d7de; padding-bottom: 8px; font-size: 1.7em; }
  h2 { border-bottom: 1px solid #eaeef2; padding-bottom: 5px; margin-top: 2em; }
  table { border-collapse: collapse; margin: 1em auto; width: auto; }
  th, td { border: 1px solid #d0d7de; padding: 6px 14px; }
  th { background: #f6f8fa; }
  tr:nth-child(even) { background: #fbfcfd; }
  img { max-width: 100%; display: block; margin: 1.2em auto; border: 1px solid #eaeef2; }
  p > em:only-child { display: block; text-align: center; color: #57606a; font-size: 0.9em; }
  code { background: #f6f8fa; padding: 2px 6px; border-radius: 4px; font-size: 0.92em; }
  pre { background: #f6f8fa; padding: 14px; border-radius: 8px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 4px solid #d0d7de; margin: 1em 0; padding: 0 1em; color: #57606a; }`

/**
 * 构建：markdown 文件 → 单页自包含 HTML。
 * 返回统计 { embedded, missing, external }：内嵌成功数 / 缺失本地图片列表 / 保留外链列表。
 */
export async function buildStandaloneHtml(inFile, outFile, opts = {}) {
  const md = fs.readFileSync(inFile, "utf8")
  const body = await marked.parse(md, { gfm: true })

  // 后处理：<img src="..."> 本地文件 → base64 内嵌；远程 http(s) 与 data: 保留原样并计入 external
  // 图片相对路径基准：调用方传 opts.imgBaseDir（export-html 子命令传项目根，与 §3.4 配图纪律一致）；
  // 缺省 md 所在目录（CLI 直跑兼容行为，已在 SKILL.md §5.4 声明两种基准）
  const imgDir = path.resolve(opts.imgBaseDir || path.dirname(path.resolve(inFile)))
  const missing = []
  const external = []
  let embedded = 0
  const html = body.replace(/<img src=(?:"([^"]*)"|'([^']*)')([^>]*)>/gi, (m, dsrc, ssrc, rest) => {
    const src = dsrc ?? ssrc ?? ""
    if (/^https?:\/\//.test(src) || src.startsWith("data:")) {
      if (/^https?:\/\//.test(src)) external.push(src)
      return m
    }
    let abs
    try { abs = path.resolve(imgDir, decodeURIComponent(src.split("#")[0])) }
    catch { abs = path.resolve(imgDir, src.split("#")[0]) } // 畸形 % 序列降级原串，不炸整次导出（审核 W5）
    if (!fs.existsSync(abs)) {
      missing.push(src)
      console.warn(`[warn] missing image: ${src}`)
      return m
    }
    const mime = MIME[path.extname(abs).toLowerCase()]
    if (!mime) {
      missing.push(src)
      return m
    }
    embedded++
    const b64 = fs.readFileSync(abs).toString("base64")
    return `<img src="data:${mime};base64,${b64}"${rest}>`
  })

  const doc = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${CSS}</style>
</head>
<body>
${html}
</body>
</html>`

  fs.writeFileSync(outFile, doc, "utf8")
  return { embedded, missing, external, bytes: Buffer.byteLength(doc) }
}

// ---------- CLI 双用入口 ----------
// basename 对 basename 判 CLI 直跑：盘符大小写 / 分隔符差异免疫（与 review.mjs 同法，审核 W6）
const isMain = process.argv[1] && path.basename(process.argv[1]) === path.basename(fileURLToPath(import.meta.url))
if (isMain) {
  const [, , inFile, outFileArg] = process.argv
  if (!inFile) {
    console.error("usage: node export_html.mjs <in.md> [out.html]")
    process.exit(1)
  }
  let outFile = outFileArg || inFile.replace(/\.md$/i, ".html")
  if (outFile === inFile) outFile = inFile + ".html" // 非 .md 输入追加后缀，防 HTML 覆盖写回源文件（审核 J4）
  const r = await buildStandaloneHtml(inFile, outFile)
  console.log(`done: ${outFile} (${Math.round(r.bytes / 1024)}KB, embedded: ${r.embedded}, missing: ${r.missing.length}, external: ${r.external.length})`)
  if (r.missing.length) process.exit(2)
}
