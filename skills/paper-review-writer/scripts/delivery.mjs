/**
 * delivery.mjs —— 交付链路子命令实现（第 3.4 步提图 + 第 5 步 HTML 导出）
 *
 * 设计思路：
 * cmdFigures：遍历清单，对每篇有 pdf 存档的条目 spawn fig_run.mjs（两段进程隔离的提图链路），
 *   串行逐篇防渲染吃满内存；产物 figures/{id}_{slug}/fig_N.png + manifest。
 *   spawn 隔离保证 review.mjs 进程内的 pdfjs-dist@6 与 fig_embed.mjs 进程内的 pdf-parse（内置
 *   pdfjs@5）不共享 globalThis.pdfjsWorker（跨版本全局污染，2026-10-24 实测）。
 * cmdExportHtml：读综述 md → export_html.mjs 引擎产出单页自包含 HTML；只依赖 md 与其引用的
 *   本地图片，独立可重入（用户修正图片后重跑本步，不回跑精读与成文）。
 */

import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { buildStandaloneHtml } from "./export_html.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))

/** 读清单：verified 优先，回退原始清单 */
function loadMeta(root) {
  for (const name of ["papers_meta.verified.json", "papers_meta.json"]) {
    const p = path.join(root, name)
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"))
  }
  throw new Error(`清单不存在：${path.join(root, "papers_meta.json")}（先跑 init 与 verify）`)
}

/** pdf 文件名 → 输出目录 slug：去 {id}_ 前缀与 .pdf，截 40 字符 */
function slugOf(pdfBase, id) {
  let s = pdfBase.replace(/\.pdf$/i, "")
  if (s.startsWith(`${id}_`)) s = s.slice(id.length + 1)
  s = s.slice(0, 40).replace(/[-_]+$/, "")
  return s || "figs"
}

/** origin 标签 → 中文含义（对用户汇报用） */
const ORIGIN_ZH = {
  "embedded": "内嵌直提（原生分辨率）",
  "rotated-embedded": "内嵌直提（已自动转正）",
  "render-crop": "渲染裁剪",
  "fullpage": "整页截取（可手动裁剪）",
}

/**
 * 提图子命令：node review.mjs figures --project <dir> [--id <编号>]
 * 逐篇跑两段提图链路，产物 figures/{id}_{slug}/，结束后按来源标签汇总并提示人工过目项。
 */
export async function cmdFigures(root, args) {
  const meta = loadMeta(root)
  const papers = (meta.papers || meta).filter((p) => p && p.id)
  const targets = args.id ? papers.filter((p) => p.id === args.id) : papers
  if (!targets.length) {
    console.error(`清单中没有匹配的条目${args.id ? `（--id ${args.id}）` : ""}`)
    process.exit(1)
  }
  const logsDir = path.join(root, "figures", "_logs")
  fs.mkdirSync(logsDir, { recursive: true })

  const summary = []
  let failed = 0
  for (const p of targets) {
    const pdf = fs.existsSync(path.join(root, "papers"))
      ? fs.readdirSync(path.join(root, "papers")).find((f) => f.startsWith(`${p.id}_`) && f.toLowerCase().endsWith(".pdf"))
      : null
    if (!pdf) {
      console.log(`[skip] ${p.id} 无 PDF 存档（获取阶段未落 pdf），跳过提图`)
      summary.push({ id: p.id, n: 0, noPdf: true })
      continue
    }
    const outDir = path.join(root, "figures", `${p.id}_${slugOf(pdf, p.id)}`)
    console.log(`\n===== [figures] ${p.id} <- papers/${pdf} =====`)
    const r = spawnSync(process.execPath, [path.join(here, "fig_run.mjs"), path.join(root, "papers", pdf), outDir, logsDir], { stdio: "inherit" })
    if (r.status !== 0) {
      failed++
      console.error(`[figures] ${p.id} 提图失败（exit=${r.status}）。若报 Cannot find package，先在本 skill 目录安装依赖：npm install / pnpm install / bun install`)
      summary.push({ id: p.id, n: 0, failed: true })
      continue
    }
    const mf = path.join(outDir, "manifest.json")
    const entries = fs.existsSync(mf) ? JSON.parse(fs.readFileSync(mf, "utf8")) : []
    const tally = {}
    for (const e of entries) tally[e.origin] = (tally[e.origin] || 0) + 1
    summary.push({ id: p.id, n: entries.length, tally })
  }

  console.log(`\n===== [figures] 汇总 =====`)
  for (const s of summary) {
    if (!s.n) { console.log(`${s.id}: 0 图${s.failed ? "（失败，见上方指引）" : s.noPdf ? "（无 PDF 存档）" : "（有 PDF 但 0 图：查该篇目录 issues.json 与 figures/_logs 日志）"}`); continue }
    const parts = Object.entries(s.tally).map(([k, v]) => `${ORIGIN_ZH[k] || k} ×${v}`).join("，")
    console.log(`${s.id}: ${s.n} 图（${parts}）`)
    const manual = (s.tally["fullpage"] || 0) + (s.tally["render-crop"] || 0)
    if (manual) console.log(`  其中 ${manual} 张为渲染裁剪/整页截取，建议人工过目；整页图可手动裁剪后重跑 export-html`)
  }
  if (failed) process.exit(1)
}

/**
 * HTML 导出子命令：node review.mjs export-html --project <dir> [--review <综述.md>]
 * 缺省综述 = deliverables/综述.md（与 check 一致）；输出同名 .html；独立可重入。
 */
export async function cmdExportHtml(root, args) {
  const reviewPath = path.resolve(root, args.review || path.join("deliverables", "综述.md"))
  if (!fs.existsSync(reviewPath)) {
    console.error(`综述不存在：${reviewPath}（--review 指定或先完成第 4 步 assemble）`)
    process.exit(1)
  }
  let outPath = reviewPath.replace(/\.md$/i, ".html")
  if (outPath === reviewPath) outPath = reviewPath + ".html" // 非 .md 输入追加后缀，防覆盖综述源文件（审核 J4）
  const r = await buildStandaloneHtml(reviewPath, outPath, { imgBaseDir: root }) // 图路径以项目根为基准（与 §3.4 配图纪律一致，审核 B1）
  console.log(`export-html 完成：${outPath}（${Math.round(r.bytes / 1024)}KB）`)
  console.log(`图片内嵌 ${r.embedded} 张；缺失 ${r.missing.length} 张；保留外链 ${r.external.length} 个`)
  if (r.missing.length) {
    console.log(`缺失图片（md 引用但文件不存在，已原样保留引用）：`)
    for (const m of r.missing) console.log(`  - ${m}`)
    console.log(`修正图片或路径后重跑本步（export-html）即可，不回跑精读与成文。`)
    process.exit(2)
  }
  if (r.external.length) {
    console.log(`存在保留的外链图片（离线不可见）：`)
    for (const e of r.external) console.log(`  - ${e}`)
  }
}
