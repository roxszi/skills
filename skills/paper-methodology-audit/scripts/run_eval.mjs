#!/usr/bin/env bun
/**
 * run_eval.mjs — paper-methodology-audit 技能触发评测器。
 *
 * 评测对象：技能的 frontmatter description 是否把请求正确路由到本技能。
 * 三种模式，各自独立：
 *   1) --lexical            离线覆盖检查：正例触发词是否写进 description，负例是否被显式排除。
 *   2) --emit-prompts <out> 生成模型探针：把技能清单与每条请求拼成探针文本，供模型逐条判断。
 *   3) --answers <in>       对模型答案打分：混淆矩阵、精确率、召回率、F1、逐条错例。
 *   4) --canary             生成环境自检探针：确认被测会话的运行环境挂着同一份技能清单。
 *
 * 用法：
 *   bun scripts/run_eval.mjs --queries tests/eval-queries.json --lexical
 *   bun scripts/run_eval.mjs --queries tests/eval-queries.json --emit-prompts out/prompts.json
 *   bun scripts/run_eval.mjs --queries tests/eval-queries.json --answers out/answers.json
 *
 * 退出码：0 = 达到阈值；1 = 未达阈值或用法错误。
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const skillDir = join(here, "..")
const skillsRoot = join(skillDir, "..")
const TARGET = "paper-methodology-audit"

/** 阈值：召回率与精确率同时达标才算通过 */
const THRESHOLD = { recall: 0.9, precision: 0.8 }

// ---------- 读取 ----------

/** 解析 SKILL.md 的 frontmatter，取 name 与 description */
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return null
  const body = m[1]
  const name = body.match(/^name:\s*(.+)$/m)?.[1]?.trim()
  const desc = body.match(/^description:\s*(.+)$/m)?.[1]?.trim()
  return name ? { name, description: desc ?? "" } : null
}

/** 扫技能根目录，返回 [{name, description}]（含本技能） */
function loadSkills() {
  const out = []
  for (const dir of readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    const f = join(skillsRoot, dir.name, "SKILL.md")
    if (!existsSync(f)) continue
    const fm = parseFrontmatter(readFileSync(f, "utf8"))
    if (fm) out.push(fm)
  }
  return out
}

/** 读评测集 */
function loadQueries(path) {
  const j = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""))
  if (!Array.isArray(j.queries)) throw new Error("评测集缺 queries 数组")
  return j.queries
}

// ---------- 探针文本 ----------

/** 技能清单块，格式对齐主流宿主运行时的技能清单（name + description 逐条列出） */
function skillsBlock(skills) {
  const items = skills.map((s) =>
    `  <skill>\n    <name>${s.name}</name>\n    <description>${s.description}</description>\n  </skill>`
  ).join("\n")
  return `<skills>\n${items}\n</skills>`
}

/** 单条探针文本：只要求路由判断，禁止执行任务与调用工具 */
function probePrompt(query, skills) {
  return [
    "【技能路由评测 · 不是真实任务】",
    "下列 <skills> 块是当前运行环境中挂载的技能清单，每项含 name 与 description。",
    "请判断：给定的用户请求是否应当加载名为 " + TARGET + " 的技能。",
    "只做路由判断，不执行请求，不调用任何工具，不读写文件。",
    "",
    skillsBlock(skills),
    "",
    "用户请求：",
    "<<<" + query.utterance + ">>>",
    "",
    "只回答一行 JSON，字段含义：",
    '  {"load": true|false, "best_skill": "<应加载的技能名，没有则 none>", "reason": "不超过 20 字"}',
    "其中 load 只针对 " + TARGET + " 这一个技能。",
  ].join("\n")
}

/** 环境自检探针：确认被测会话自身挂载的技能清单 */
function canaryPrompt(skills) {
  return [
    "【环境自检 · 不是真实任务】",
    "不要调用任何工具，不要读写文件。",
    "只回答一行 JSON：",
    '  {"mounted_skill_names": ["你运行环境里实际挂载的技能名"], "sees_block": true|false}',
    "第一项填你自身环境挂载的技能名（不是本消息里贴出来的清单）；若两者相同，sees_block 为 true。",
    "",
    "参考清单（本消息内）：",
    skillsBlock(skills),
  ].join("\n")
}

// ---------- 模式 1：离线覆盖 ----------

function lexicalCheck(queries, skills) {
  const target = skills.find((s) => s.name === TARGET)
  if (!target) throw new Error("技能清单中找不到 " + TARGET)
  const desc = target.description
  const uncovered = []
  const covered = []
  for (const q of queries) {
    if (q.label !== "positive") continue
    const groups = q.expect_any ?? []
    const hit = groups.length === 0 ? true : groups.some((t) => desc.includes(t))
    ;(hit ? covered : uncovered).push({ id: q.id, utterance: q.utterance, tokens: groups })
  }
  const negWithGuard = queries.filter((q) => q.label === "negative" && (q.expect_any ?? []).length > 0)
  console.log("== 离线覆盖检查 ==")
  console.log("description 长度：", desc.length, "字符")
  console.log("正例覆盖：", covered.length, "/", covered.length + uncovered.length)
  for (const u of uncovered) {
    console.log("  未覆盖触发词 [" + u.id + "]：" + u.utterance + "  ← 期望命中其一 " + JSON.stringify(u.tokens))
  }
  console.log("负例显式排除条目：", negWithGuard.length, "（未写排除句的负例在 description 中不得出现对应领域词，见报告）")
  return { uncovered }
}

// ---------- 模式 2：生成探针 ----------

function emitPrompts(queries, skills, outPath) {
  const prompts = {}
  for (const q of queries) {
    prompts[q.id] = { label: q.label, expect: q.expect, utterance: q.utterance, prompt: probePrompt(q, skills) }
  }
  writeFileSync(outPath, JSON.stringify(prompts, null, 2), "utf8")
  console.log("已生成 " + Object.keys(prompts).length + " 条探针 → " + outPath)
}

/** 逐条落盘：一问一文件，便于并行分批投递 */
function emitPromptsDir(queries, skills, outDir) {
  mkdirSync(outDir, { recursive: true })
  for (const q of queries) {
    writeFileSync(join(outDir, q.id + ".txt"), probePrompt(q, skills), "utf8")
  }
  console.log("已生成 " + queries.length + " 条探针文件 → " + outDir)
}

/** 模板落盘：请求部分留占位符，供外部按 id 替换后批量投递 */
function emitTemplate(queries, skills, outPath) {
  const tpl = probePrompt({ utterance: "__UTTERANCE__" }, skills)
  writeFileSync(outPath, tpl, "utf8")
  const map = {}
  for (const q of queries) map[q.id] = { utterance: q.utterance, label: q.label, expect: q.expect }
  writeFileSync(outPath.replace(/\.txt$/, ".map.json"), JSON.stringify(map, null, 2), "utf8")
  console.log("模板 → " + outPath + "；请求映射 → " + outPath.replace(/\.txt$/, ".map.json"))
}

// ---------- 模式 3：打分 ----------

function readAnswers(path) {
  const raw = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""))
  const arr = Array.isArray(raw) ? raw : Object.entries(raw).map(([id, v]) => ({ id, ...v }))
  const map = new Map()
  for (const a of arr) {
    const load = a.load === true || a.load === "true" || a.best_skill === TARGET
    map.set(a.id, { load, best_skill: a.best_skill ?? "none", reason: a.reason ?? "" })
  }
  return map
}

function score(queries, answers) {
  let tp = 0, fp = 0, fn = 0, tn = 0
  const errors = []
  const missing = []
  const routeNotes = []
  for (const q of queries) {
    const a = answers.get(q.id)
    if (!a) { missing.push(q.id); continue }
    const shouldLoad = q.label === "positive"
    if (shouldLoad && a.load) tp++
    else if (shouldLoad && !a.load) { fn++; errors.push({ ...q, got: a, kind: "漏触发" }) }
    else if (!shouldLoad && a.load) { fp++; errors.push({ ...q, got: a, kind: "误触发" }) }
    else {
      tn++
      const allowed = [q.expect.skill, q.alt_skill].filter(Boolean)
      if (allowed.length && !allowed.includes(a.best_skill)) {
        routeNotes.push({ id: q.id, utterance: q.utterance, expected: allowed.join(" 或 "), got: a.best_skill })
      }
    }
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp)
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn)
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
  const accuracy = (tp + tn) / Math.max(1, queries.length - missing.length)

  console.log("== 模型路由打分 ==")
  console.log("样本：" + (queries.length - missing.length) + "/" + queries.length + (missing.length ? "（缺答案 " + missing.join(",") + "）" : ""))
  console.log("TP=" + tp + "  FP=" + fp + "  FN=" + fn + "  TN=" + tn)
  console.log("精确率 precision = " + (precision * 100).toFixed(1) + "%（阈值 " + (THRESHOLD.precision * 100).toFixed(0) + "%）")
  console.log("召回率 recall   = " + (recall * 100).toFixed(1) + "%（阈值 " + (THRESHOLD.recall * 100).toFixed(0) + "%）")
  console.log("F1 = " + (f1 * 100).toFixed(1) + "%   准确率 = " + (accuracy * 100).toFixed(1) + "%")
  if (errors.length) {
    console.log("\n错例：")
    for (const e of errors) {
      console.log("  [" + e.id + "] " + e.kind + "：\"" + e.utterance + "\"")
      console.log("      期望 " + e.expect.skill + "，模型选 " + e.got.best_skill + "（" + e.got.reason + "）")
    }
  }
  const pass = missing.length === 0 && recall >= THRESHOLD.recall && precision >= THRESHOLD.precision
  console.log("\n判定：" + (pass ? "PASS" : "FAIL"))
  return { tp, fp, fn, tn, precision, recall, f1, accuracy, errors, missing, routeNotes, pass }
}

/** 写 Markdown 报告 */
function writeReport(queries, answers, r, outPath, meta) {
  const rows = queries.map((q) => {
    const a = answers.get(q.id)
    const got = a ? (a.load ? "加载" : "不加载") : "缺答案"
    const sel = a ? a.best_skill : "-"
    const want = q.label === "positive" ? "加载" : "不加载"
    const ok = a ? (a.load === (q.label === "positive") ? "✓" : "✗") : "—"
    return "| " + q.id + " | " + q.label + " | " + q.utterance.replace(/\|/g, "／") + " | " + want + " | " + got + " | " + sel + " | " + ok + " |"
  })
  const md = [
    "# 技能触发评测报告 · " + TARGET,
    "",
    "- 日期：" + meta.date,
    "- 评测集：`tests/eval-queries.json`（" + queries.length + " 条，正例 " + queries.filter((q) => q.label === "positive").length + "／负例 " + queries.filter((q) => q.label === "negative").length + "）",
    "- 阈值：召回率 ≥ " + (THRESHOLD.recall * 100).toFixed(0) + "%，精确率 ≥ " + (THRESHOLD.precision * 100).toFixed(0) + "%",
    "",
    "## 汇总",
    "",
    "TP=" + r.tp + "  FP=" + r.fp + "  FN=" + r.fn + "  TN=" + r.tn,
    "",
    "- 精确率 precision = " + (r.precision * 100).toFixed(1) + "%",
    "- 召回率 recall = " + (r.recall * 100).toFixed(1) + "%",
    "- F1 = " + (r.f1 * 100).toFixed(1) + "%，准确率 = " + (r.accuracy * 100).toFixed(1) + "%",
    "- 判定：" + (r.pass ? "PASS" : "FAIL"),
    "",
    "## 逐条",
    "",
    "| id | 标签 | 用户请求 | 期望 | 实测 | 选中技能 | 对 |",
    "|---|---|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n")
  writeFileSync(outPath, md, "utf8")
  console.log("报告 → " + outPath)
}

// ---------- CLI ----------

function main() {
  const args = process.argv.slice(2)
  const get = (flag) => {
    const i = args.indexOf(flag)
    return i > -1 ? args[i + 1] : null
  }
  const queriesPath = get("--queries") ?? join(skillDir, "tests", "eval-queries.json")
  if (!existsSync(queriesPath)) {
    console.error("评测集不存在：" + queriesPath)
    process.exit(2)
  }
  const queries = loadQueries(queriesPath)
  const skills = loadSkills()

  if (args.includes("--canary")) {
    const out = get("--emit-prompts") ?? join(process.cwd(), "canary-prompt.txt")
    writeFileSync(out, canaryPrompt(skills), "utf8")
    console.log("环境自检探针 → " + out)
    return
  }
  if (args.includes("--emit-prompts")) {
    const out = get("--emit-prompts")
    if (!out) { console.error("用法：--emit-prompts <out.json>"); process.exit(2) }
    emitPrompts(queries, skills, out)
    return
  }
  if (args.includes("--emit-prompts-dir")) {
    const out = get("--emit-prompts-dir")
    if (!out) { console.error("用法：--emit-prompts-dir <目录>"); process.exit(2) }
    emitPromptsDir(queries, skills, out)
    return
  }
  if (args.includes("--emit-template")) {
    const out = get("--emit-template")
    if (!out) { console.error("用法：--emit-template <out.txt>"); process.exit(2) }
    emitTemplate(queries, skills, out)
    return
  }
  if (args.includes("--answers")) {
    const inPath = get("--answers")
    if (!inPath) { console.error("用法：--answers <answers.json>"); process.exit(2) }
    const answers = readAnswers(inPath)
    const r = score(queries, answers)
    const reportPath = get("--report")
    if (reportPath) {
      const meta = { date: new Date().toISOString().slice(0, 10), sessions: answers.size }
      writeReport(queries, answers, r, reportPath, meta)
    }
    process.exit(r.pass ? 0 : 1)
  }
  const r = lexicalCheck(queries, skills)
  process.exit(r.uncovered.length === 0 ? 0 : 1)
}

main()
