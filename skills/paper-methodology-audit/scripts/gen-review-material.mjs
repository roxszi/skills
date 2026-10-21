#!/usr/bin/env node
/**
 * gen-review-material.mjs — 从精读条目目录生成"方向综述素材包"。
 *
 * 设计思路：
 *   防"引用归属错"的流程化方案：综述 Agent 只准读本脚本产物（每篇截断控长的紧凑素材，
 *   带 [slug] 锚点），不准凭会话记忆写综述——Agent 只组织语言，不发明事实。
 *   内部复用 validate-reading.mjs 的校验逻辑：带 error 的条目不进素材包（坏条目会污染
 *   综述事实基础），warning 条目保留但素材包内标注提醒。
 *
 * 用法：node gen-review-material.mjs <reading-notes目录> [-o 输出.md]（bun 亦可，脚本零外部依赖）
 *   缺省输出：<目录>\_review-material.md（下划线开头，不会被本脚本二次扫描）。
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { validateReading, readJsonLoose } from "./validate-reading.mjs"

/** 各字段进素材包的截断上限（字符数）：素材包目标 5–10k 字符，够综述引用即可 */
const CLIP = {
  background_zh: 150, question_zh: 100, system_zh: 100, method_zh: 200,
  spec_evidence_zh: 150, results_zh: 200, performance_zh: 100,
  innovation_zh: 120, limitation_zh: 120,
}

/** 压缩空白并截断，超长以 … 收尾 */
function clip(s, n) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim()
  return t.length <= n ? t : t.slice(0, n).replace(/[\s,，;；:：]+$/, "") + "…"
}

/** 扫描目录下全部条目，返回 { ok: [{data, file, warnings}], bad: [{file, reason}] } */
function loadEntries(dir) {
  const ok = []
  const bad = []
  for (const name of readdirSync(dir).sort()) {
    if (!name.toLowerCase().endsWith(".json") || name.startsWith("_")) continue
    const file = join(dir, name)
    try {
      const data = readJsonLoose(file)
      const { errors, warnings } = validateReading(data, name)
      if (errors.length > 0) bad.push({ file: name, reason: errors.join("；") })
      else ok.push({ data, file: name, warnings })
    } catch (e) {
      bad.push({ file: name, reason: `JSON 无法解析（${e.message}）` })
    }
  }
  return { ok, bad }
}

/** 单条目 → 素材包块（[slug] 锚点是后续引用校验的合法集来源） */
function renderEntry(e) {
  const s = e.data
  const lines = [
    `## [${s.slug}] ${clip(s.title_zh || s.title_en, 60)}`,
    `- 方向：${s.tags.slice(0, 3).join(" / ")}｜read_status：${s.read_status}`,
  ]
  const rows = [
    ["背景", "background_zh"], ["问题", "question_zh"], ["体系", "system_zh"],
    ["方法", "method_zh"], ["谱证", "spec_evidence_zh"], ["结果", "results_zh"],
    ["性能", "performance_zh"], ["创新", "innovation_zh"], ["局限", "limitation_zh"],
  ]
  for (const [label, key] of rows) {
    const v = clip(s[key], CLIP[key])
    if (v) lines.push(`- ${label}：${v}`)
  }
  // 性能指标取键值对形式（最精确，防综述里换算出错）
  if (Array.isArray(s.performance_metrics) && s.performance_metrics.length > 0) {
    const ms = s.performance_metrics
      .slice(0, 5)
      .map((m) => `${m.label}=${clip(m.value, 40)}`)
      .join("；")
    lines.push(`- 指标：${ms}`)
  }
  const pages = (s.evidence_pages ?? []).join(", ")
  const figs = (s.evidence_figs ?? []).join(", ")
  if (pages || figs) lines.push(`- 证据：${figs || "—"}；页码：${pages || "—"}`)
  if (e.warnings.length > 0) lines.push(`- ⚠️ 条目校验 ${e.warnings.length} 条 warning，引用前建议复核原文`)
  return lines.join("\n")
}

function main() {
  const args = process.argv.slice(2)
  const dir = args.find((a) => !a.startsWith("-"))
  const oIdx = args.indexOf("-o")
  const out = oIdx > -1 ? args[oIdx + 1] : null
  if (!dir) {
    console.error("用法：node gen-review-material.mjs <reading-notes目录> [-o 输出.md]")
    process.exit(2)
  }

  const { ok, bad } = loadEntries(dir)
  for (const b of bad) console.warn(`[skip] ${b.file}：${b.reason}`)

  if (ok.length === 0) {
    console.error("没有可用条目（0 篇通过校验），素材包未生成")
    process.exit(1)
  }

  const header = [
    "# 综述素材包",
    "",
    `> 本文件由 gen-review-material.mjs 从精读条目生成（${new Date().toISOString().slice(0, 10)}，共 ${ok.length} 篇）。`,
    "> 写综述时：所有数字 / 结论必须来自本素材，禁止编造；论断后缀 [slug]；",
    "> 素材中没有的内容禁止出现；前瞻判断须标注（综述者判断）。",
  ]
  const body = ok.map(renderEntry).join("\n\n")
  const text = header.join("\n") + "\n\n" + body + "\n"

  const outPath = out ?? join(dir, "_review-material.md")
  writeFileSync(outPath, text, "utf8")
  console.log(`OK ${outPath}（${ok.length} 篇，${text.length} 字符；跳过 ${bad.length} 个坏条目）`)
}

// 直接运行时进 CLI；被 import 时只导出函数（与 validate-reading.mjs 同约定）
if (process.argv[1] && basename(process.argv[1]) === "gen-review-material.mjs") {
  main()
}
