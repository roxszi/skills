/**
 * fig-batch-run.mjs —— 单篇论文提图全链路编排器（2026-10-24）
 *
 * 设计思路：
 * 链路分两段独立进程（bug #1 规避：pdf-parse 内置 pdfjs@5 与工作区 pdfjs@6 的
 * globalThis.pdfjsWorker 全局污染，同进程混用必崩，2026-10-24 实测）：
 *   阶段 1 fig_embed.mjs —— 仅 pdf-parse，提内嵌位图（origin=embedded），魔数校验 + 小图过滤 + 去重；
 *   阶段 2 fig_render.mjs —— 仅 pdfjs-dist@6 + pdf-to-img + sharp，
 *     文本层分类（embedded / render-crop / fullpage）+ caption 定位裁剪 + 排序编号 + manifest。
 * 编排器自身不 import 任何 pdf 库，只串行 spawn 两个子进程，任一失败即停。
 *
 * 用法：node scripts/fig_run.mjs <pdf绝对路径> <输出目录> [日志目录]
 * 产物：输出目录 fig_N.png + manifest.json / manifest.md / issues.json（异常登记）；日志目录 *_embed.json
 */

import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const [, , pdfPath, outDir, logsDirArg] = process.argv
if (!pdfPath || !outDir) {
  console.error("usage: node scripts/fig_run.mjs <pdfAbsPath> <outDir> [logsDir]")
  process.exit(1)
}
const logsDir = logsDirArg || path.join(path.dirname(outDir), "_logs")
fs.mkdirSync(outDir, { recursive: true })
fs.mkdirSync(logsDir, { recursive: true })

const here = path.dirname(fileURLToPath(import.meta.url))
const steps = [
  { name: "embed", script: path.join(here, "fig_embed.mjs") },
  { name: "render", script: path.join(here, "fig_render.mjs") },
]

for (const step of steps) {
  console.log(`===== [orchestrator] step: ${step.name} =====`)
  const r = spawnSync(process.execPath, [step.script, pdfPath, outDir, logsDir], { stdio: "inherit" })
  if (r.status !== 0) {
    console.error(`[orchestrator] step ${step.name} FAILED (exit=${r.status})`)
    process.exit(r.status ?? 1)
  }
}
console.log(`[orchestrator] ALL-DONE -> ${outDir}`)
