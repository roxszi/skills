// pipeline.mjs — 文本层：提取（extract）→ 精读缓冲（digest）→ 路由简报（brief）→
// 条目落盘（save）→ 素材包（material）→ 引用校验（check）→ 项目骨架（init / init-summaries）
// 设计思路：token 四层分层——主会话只读 brief（≤320 字/篇）；子会话读 digest（≤2.6KB/篇）+
// 按 ===PAGE n=== 标记定向回查全文；图按图题索引页码用宿主 pdf 能力按页读。素材包是综述
// 写作时数字与结论的唯一合法来源，check 子命令做引用编号闭环校验。

import fs from "node:fs"
import path from "node:path"
import { clean, clip, DIRS, ensureDir, log, pPath, readJson, readText, slugify, writeJson, writeText } from "./lib.mjs"
import { validateSummary, validateMeta } from "./schema.mjs"
import { fetchEpmcXmlText, loadProject } from "./sources.mjs"

/* ---------- extract：PDF → 逐页文本 ---------- */

/** 逐页提取单篇 PDF（pdfjs-dist legacy 构建；Node 下禁 worker；依赖未安装时给明确指引） */
async function extractPdfPages(pdfFile) {
  let mod
  try {
    mod = await import("pdfjs-dist/legacy/build/pdf.mjs")
  } catch {
    throw new Error("pdfjs-dist 未安装：在本 skill 目录安装依赖后重跑（npm install / pnpm install / bun install 任一，见 SKILL.md 宿主适配表）")
  }
  const { getDocument } = mod
  const data = new Uint8Array(fs.readFileSync(pdfFile))
  const doc = await getDocument({ data, useWorkerFetch: false, isEvalSupported: false, disableFontFace: true }).promise
  const pages = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const tc = await page.getTextContent()
    const text = tc.items.map(it => it.str).join(" ").replace(/\s+/g, " ").trim()
    pages.push(`===PAGE ${i}===\n${text}`)
  }
  const n = doc.numPages
  try { await doc.destroy?.() } catch { /* v6 起 destroy 可选；清理失败不影响主流程 */ }
  return { pages, numPages: n }
}

/** 从全文文本收集图题索引（Fig./Scheme/Table 首现页码），供按页看图与 evidence_figs 定位；导出供测试 */
export function figureIndex(pages) {
  const seen = new Map()
  pages.forEach((body, i) => {
    for (const m of body.matchAll(/\b(Fig(?:ure)?\.?|Scheme|Table)\s+(\d+[A-Za-z]?)/gi)) {
      // 归一化前缀词（figure/Fig./fig → Fig.），同图只记首现页
      const word = /^scheme/i.test(m[1]) ? "Scheme" : /^table/i.test(m[1]) ? "Table" : "Fig."
      const key = `${word} ${m[2]}`
      if (!seen.has(key)) seen.set(key, i + 1)
    }
  })
  return [...seen.entries()].map(([k, v]) => `${k}(p${v})`)
}

/** 图题首现上下文：每个图题在首现页命中处向后取 span 字符——caption 大多紧邻首现处（先见图后文），
 *  子会话读上下文即可掌握图意（化学 Scheme 的 caption 常完整描述合成路线），无需渲染位图；导出供测试 */
export function figureContexts(pages, maxFigures = 10, span = 400) {
  const seen = new Map()
  pages.forEach((body, i) => {
    if (seen.size >= maxFigures) return
    for (const m of body.matchAll(/\b(Fig(?:ure)?\.?|Scheme|Table)\s+(\d+[A-Za-z]?)/gi)) {
      const word = /^scheme/i.test(m[1]) ? "Scheme" : /^table/i.test(m[1]) ? "Table" : "Fig."
      const key = `${word} ${m[2]}`
      if (!seen.has(key)) seen.set(key, `p${i + 1}: ${clean(body.slice(m.index, m.index + span))}`)
    }
  })
  return [...seen.entries()]
}

/** extract 子命令：全部 PDF → papers_txt/{id}.txt；无 PDF 且有 PMCID 的走 EPMC XML 降级 */
export async function cmdExtract(root, args) {
  const cfg = loadProject(root)
  const verified = readJson(pPath(root, "papers_meta.verified.json"))
  const meta = verified || readJson(pPath(root, "papers_meta.json"))
  if (!meta?.papers) throw new Error("缺 papers_meta（先建清单）")
  const papersDir = pPath(root, DIRS.papers)
  const txtDir = ensureDir(pPath(root, DIRS.txt))
  const extra = {}
  let found = 0
  const targets = args.id ? meta.papers.filter(p => String(p.id) === String(args.id)) : meta.papers
  for (const p of targets) {
    const pid = String(p.id)
    const pdf = fs.existsSync(papersDir)
      ? fs.readdirSync(papersDir).find(n => n.startsWith(pid + "_") && n.toLowerCase().endsWith(".pdf"))
      : null
    if (pdf) {
      const { pages, numPages } = await extractPdfPages(pPath(papersDir, pdf))
      writeText(pPath(txtDir, `${pid}.txt`), pages.join("\n\n"))
      const first = pages[0] || ""
      extra[pid] = {
        file: pdf, pages: numPages,
        doi_reg: first.match(/10\.\d{4,9}\/[^\s,;)\]]+/)?.[0] || null,
        abstract_snippet: first.slice(0, 900),
      }
      log(`[${pid}] ${numPages} 页 → papers_txt/${pid}.txt`)
      found++
      continue
    }
    // PDF 缺失：EPMC XML 全文降级（无页码概念，整文落盘并标注来源）
    const pmcid = p.pmcid || p.verified?.europepmc?.pmcid
    if (pmcid) {
      const text = await fetchEpmcXmlText(pmcid, cfg)
      if (text) {
        writeText(pPath(txtDir, `${pid}.txt`), `===SOURCE: europepmc-fullTextXML===\n${text}`)
        extra[pid] = { file: `EPMC XML ${pmcid}`, pages: 0 }
        log(`[${pid}] EPMC XML 降级成功（${text.length} 字符，无页码标记）`)
        found++
        continue
      }
    }
    log(`[${pid}] 无 PDF 且 XML 降级失败，跳过（条目将标 abstract_only）`)
  }
  writeJson(pPath(root, "papers_meta_extra.json"), extra)
  log(`DONE：提取 ${found}/${targets.length} 篇`)
}

/* ---------- digest：全文 → 精读缓冲 ---------- */

const SECTION_KEYS = [
  ["abstract", ["abstract"]],
  ["introduction", ["introduction"]],
  ["methods", ["methods", "materials and methods", "experimental", "method"]],
  ["results", ["results", "result"]],
  ["discussion", ["discussion"]],
  ["conclusion", ["conclusion"]],
]
const DIGEST_MAX = 2600
const SECTION_MAX = 700
const HEAD_MAX = 1200

/** digest 子命令：每篇生成 ≤2.6KB 精读缓冲，尾部带图题索引 */
export function cmdDigest(root, args) {
  const txtDir = pPath(root, DIRS.txt)
  const digDir = ensureDir(pPath(root, DIRS.digests))
  const names = args.id ? [`${args.id}.txt`] : fs.existsSync(txtDir) ? fs.readdirSync(txtDir).filter(n => n.endsWith(".txt")) : []
  if (!names.length) log("papers_txt/ 无文本，先跑 extract")
  for (const name of names) {
    const pid = path.basename(name, ".txt")
    const raw = readText(pPath(txtDir, name))
    if (!raw) continue
    const isXml = raw.startsWith("===SOURCE:")
    const body = isXml ? raw.replace(/^===SOURCE:[^\n]*===\n/, "") : raw
    // 按页标记切块；XML 降级源无页标记，整文视为单块
    const pages = []
    if (isXml) {
      pages.push(body)
    } else {
      const re = /===PAGE (\d+)===\n?/g
      let m
      const marks = []
      while ((m = re.exec(body))) marks.push({ no: Number(m[1]), contentStart: m.index + m[0].length, markerStart: m.index })
      // 每页内容 = 本标记结束到下一标记开始（含页与页之间的空行，无害）
      marks.forEach((mk, i) => {
        const end = i + 1 < marks.length ? marks[i + 1].markerStart : body.length
        pages.push(body.slice(mk.contentStart, Math.max(mk.contentStart, end)))
      })
      if (!marks.length) pages.push(body)
    }
    const parts = [`### ${pid} digest\n`, `\n## Page 1 (head)\n${clip(pages[0], HEAD_MAX)}\n`]
    const seen = new Set()
    for (const [section, keys] of SECTION_KEYS) {
      if (seen.has(section)) continue
      for (let i = 1; i < pages.length; i++) {
        // 词边界匹配，防前缀误命中（abstract → abstraction）；命中即取该处起 700 字符
        const hit = keys
          .map(k => pages[i].match(new RegExp(`\\b${k}\\b`, "i"))?.index ?? -1)
          .find(idx => idx >= 0)
        if (hit !== undefined) {
          parts.push(`\n## page ${i + 1} [${section}]\n${clean(pages[i].slice(hit, hit + SECTION_MAX))}\n`)
          seen.add(section)
          break
        }
      }
    }
    // 图题索引追加在尾部（图题行通常含 Fig. x 短语，首现页码即所在页的强线索）
    const figs = figureIndex(pages)
    if (figs.length) parts.push(`\n## 图题索引（首现页码）\n${figs.slice(0, 20).join("；")}\n`)
    let digest = parts.join("")
    if (digest.length > DIGEST_MAX) digest = digest.slice(0, DIGEST_MAX) + "\n## (truncated)\n"
    writeText(pPath(digDir, `${pid}.md`), digest)
    // 图题首现上下文独立落盘（不进 digest 防 token 膨胀，≤10 图 × 400 字符；子会话需要图意时按需读）
    const ctx = figureContexts(pages)
    if (ctx.length) {
      writeText(pPath(digDir, `${pid}.figs.md`), `# ${pid} 图题首现上下文（按需读，不整读）\n\n` + ctx.map(([k, v]) => `- ${k}：${v}`).join("\n") + "\n")
    }
    log(`[${pid}] digest ${digest.length} 字符`)
  }
  // keyfacts：全库精读前一览（每篇 ≤1200 字符；定位为按需查段不整读——主会话写任务卡与裁决二次评估升级申报时查段用）
  const kfFiles = fs.readdirSync(digDir).filter(n => n.endsWith(".md") && !n.endsWith(".figs.md") && n !== "keyfacts.md" && n !== "brief.md").sort()
  const chunks = []
  for (const n of kfFiles) {
    const raw = readText(pPath(digDir, n)) || ""
    const pid = path.basename(n, ".md")
    const head = raw.match(/## Page 1 \(head\)\n([\s\S]*?)(?=\n## |$)/)?.[1] || ""
    let text = `### ${pid}\n摘要: ${clip(clean(head), 600)}\n`
    for (const key of ["methods", "results", "discussion", "conclusion"]) {
      const seg = raw.match(new RegExp(`## page \\d+ \\[${key}\\]\\n([\\s\\S]*?)(?=\\n## |$)`))?.[1]
      if (seg) text += `${key}: ${clip(clean(seg), 400)}\n`
    }
    chunks.push(text.slice(0, 1250))
  }
  if (chunks.length) writeText(pPath(digDir, "keyfacts.md"), chunks.join("\n"))
}

/* ---------- brief：summaries → 主会话路由简报 ---------- */

const BRIEF_MAX = 320

/** brief 子命令：每篇 ≤320 字符路由简报；主会话只读它，不读 digest 与全文 */
export function cmdBrief(root) {
  const sumDir = pPath(root, DIRS.summaries)
  const digDir = ensureDir(pPath(root, DIRS.digests))
  const files = fs.existsSync(sumDir) ? fs.readdirSync(sumDir).filter(n => n.endsWith(".json")).sort() : []
  const lines = []
  for (const name of files) {
    const s = readJson(pPath(sumDir, name))
    if (!s || typeof s !== "object") continue
    const statusZh = { full_read: "全文已读", partial_read: "部分精读", abstract_only: "仅摘要", missing: "未获取" }[s.read_status] || s.read_status
    const one = (field, n) => (s[field] ? clip(s[field], n) : "—")
    const m0 = Array.isArray(s.performance_metrics) && s.performance_metrics[0]
    const metric = m0 ? clip(`${m0.label}: ${m0.value}`, 40) : "—"
    let block = `[${s.id}|${statusZh}] ${clip(s.title_zh || s.title_en, 40)} · ${clip(s.tags?.[0] || "", 12)}\n方法: ${one("method_zh", 70)}\n结果: ${one("results_zh", 70)}\n指标: ${metric}\n价值: ${one("innovation_zh", 60)}\n`
    if (block.length > BRIEF_MAX) block = block.slice(0, BRIEF_MAX).replace(/\n[^\n]*$/, "\n…\n")
    lines.push(block)
  }
  const out = writeText(pPath(digDir, "brief.md"), lines.join("\n"))
  log(`wrote ${out}（${lines.length} 篇）`)
}

/* ---------- save：子会话条目落盘 ---------- */

/** save 子命令：stdin JSON → 校验 → summaries/summary_{id}.json（单行输出防回显全文） */
export async function cmdSave(root, args) {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString("utf8")
  let data
  try {
    data = JSON.parse(raw)
  } catch (e) {
    console.log(`ERROR invalid json: ${e.message}`)
    process.exitCode = 1
    return
  }
  if (!data || typeof data !== "object") {
    console.log("ERROR summary must be object")
    process.exitCode = 1
    return
  }
  data.id = String(args.id)
  const { errors, warnings } = validateSummary(data)
  if (errors.length && !args.allowErrors) {
    console.log("ERROR " + errors.join("; "))
    process.exitCode = 1
    return
  }
  const file = writeJson(pPath(root, DIRS.summaries, `summary_${args.id}.json`), data)
  let msg = `saved ${path.basename(file)}（${raw.length} 字符）`
  if (warnings.length) msg += ` warnings=${warnings.slice(0, 3).join("; ")}`
  if (errors.length) msg += ` errors=${errors.slice(0, 3).join("; ")}`
  console.log(msg)
}

/* ---------- material：综述素材包 ---------- */

const MATERIAL_MAX = {
  background_zh: 90, question_zh: 80, method_zh: 250, results_zh: 250,
  innovation_zh: 90, limitation_zh: 90, system_zh: 60,
}

/** material 子命令：summaries → review-material.md（综述写作唯一合法数字来源） */
export function cmdMaterial(root) {
  const sumDir = pPath(root, DIRS.summaries)
  const files = fs.existsSync(sumDir) ? fs.readdirSync(sumDir).filter(n => n.endsWith(".json")).sort() : []
  if (!files.length) {
    log("summaries/ 为空，先完成精读落盘")
    process.exitCode = 1
    return
  }
  const statusZh = { full_read: "全文已读", partial_read: "部分精读", abstract_only: "仅摘要", missing: "未获取" }
  const blocks = []
  const skipped = []
  for (const name of files) {
    const s = readJson(pPath(sumDir, name))
    if (!s || typeof s !== "object") continue
    const { errors, warnings } = validateSummary(s)
    if (errors.length) {
      // 带 error 的条目不进素材包：综述引用一个坏条目会污染全篇结论
      skipped.push(`${s.id}（${errors[0]}）`)
      continue
    }
    const pid = String(s.id)
    const dr = s.depth_reassessment
    const drText = dr && dr.verdict && dr.verdict !== "keep"
      ? `｜二次评估：${dr.verdict === "upgrade" ? "升级" : dr.verdict === "downgrade" ? "降级" : dr.verdict}${dr.reason ? `（${clip(dr.reason, 30)}）` : ""}`
      : ""
    const lines = [
      `\n## [${pid}] ${clip(s.title_zh || s.title_en, 60)}`,
      `- 方向：${clip((s.tags || []).join("、"), 40)}｜阅读深度：${statusZh[s.read_status] || s.read_status}${drText}｜${s.journal} ${s.year}${s.doi ? `｜doi:${s.doi}` : ""}`,
    ]
    if (s.read_status === "abstract_only" && s.abstract_en) {
      lines.push(`- 摘要（原文节选，仅可摘要级转述）：${clip(s.abstract_en, 220)}`)
    }
    if (warnings.length) lines.push(`- ⚠️ 复核提醒：${warnings.slice(0, 2).join("；")}`)
    for (const [label, field] of [["背景", "background_zh"], ["问题", "question_zh"], ["体系", "system_zh"], ["方法", "method_zh"], ["结果", "results_zh"], ["创新", "innovation_zh"], ["局限", "limitation_zh"]]) {
      const v = s[field]
      if (v) lines.push(`- ${label}：${clip(v, MATERIAL_MAX[field] || 80)}`)
    }
    const m0 = Array.isArray(s.performance_metrics) && s.performance_metrics[0]
    if (m0) lines.push(`- 指标：${clip(`${m0.label}：${m0.value}`, 50)}`)
    const refs = (s.evidence_figs || []).slice(0, 3)
    const pages = (s.evidence_pages || []).slice(0, 5)
    if (refs.length || pages.length) {
      lines.push(`- 图/证据：${refs.length ? refs.join(", ") : "—"}；页码：${pages.length ? pages.join(", ") : "—"}`)
    }
    blocks.push(lines.join("\n"))
  }
  const header = "# 综述素材包\n\n本文由脚本从精读条目生成，供综述写作引用；所有数字与结论必须来自以下素材，禁止编造。" +
    (skipped.length ? `\n\n以下条目因校验未通过未收入：${skipped.join("；")}` : "")
  const out = writeText(pPath(root, "review-material.md"), header + "\n" + blocks.join("\n"))
  log(`wrote ${out}（${blocks.length} 篇入库${skipped.length ? `，${skipped.length} 篇被拦` : ""}）`)
}

/* ---------- assemble：章节文件拼装综述 ---------- */

/** assemble 子命令：deliverables/sections/{NN}_*.md 按文件名序拼装为单文件综述；
 *  章节文件化是增量更新的前提：补拉循环只重写涉及章节，再重新拼装，不全篇重写 */
export function cmdAssemble(root, args) {
  const secDir = pPath(root, DIRS.deliverables, "sections")
  if (!fs.existsSync(secDir)) {
    console.log("FAIL sections/ 不存在：综述按章节写 deliverables/sections/{NN}_{章节名}.md 后再拼装")
    process.exitCode = 1
    return
  }
  const files = fs.readdirSync(secDir).filter(n => n.toLowerCase().endsWith(".md")).sort()
  if (!files.length) {
    console.log("FAIL sections/ 无 .md 章节文件")
    process.exitCode = 1
    return
  }
  const parts = []
  for (const n of files) {
    const body = readText(pPath(secDir, n))
    if (body === null) throw new Error(`章节文件读取失败：${n}`)
    parts.push(body.trimEnd())
  }
  const outPath = args.out || pPath(root, DIRS.deliverables, "综述.md")
  writeText(outPath, parts.join("\n\n") + "\n")
  log(`wrote ${outPath}（${files.length} 个章节，共 ${parts.reduce((a, b) => a + b.length, 0)} 字符）`)
}

/* ---------- check：综述引用编号校验 + 交付自检 ---------- */

/** 内置章节关键词表：章名 → 匹配词（命中综述任一 ^#{1,3} 标题即算该章存在），顺序 = 模板章节顺序；
 *  匹配词按章名就近映射（如「对用户研究的相关点」容忍「启示」写法），标题匹配前先剥编号前缀 */
const REVIEW_SECTIONS = [
  ["研究背景与问题定义", ["背景"]],
  ["领域全景与研究方向分类", ["全景", "分类"]],
  ["代表性方法与技术路线", ["技术路线", "方法"]],
  ["关键结果与性能对比", ["结果", "性能"]],
  ["研究范式演进", ["范式"]],
  ["现有局限与挑战", ["局限", "挑战"]],
  ["未来方向与开放问题", ["未来", "开放"]],
  ["对用户研究的相关点", ["相关点", "启示"]],
  ["文献映射", ["文献映射", "参考文献"]],
]

/** 判断标注（WARN 级）必查的两章章名；匹配词复用 REVIEW_SECTIONS 表 */
const JUDGMENT_SECTION_NAMES = ["现有局限与挑战", "未来方向与开放问题"]

/** 文献映射节的行首编号提取（容忍 -/* 列表符号）；映射节内素材包外编号由 invalid 全文校验覆盖，此处不单报 */
const MAPPING_ID_RE = /^\s*[-*]?\s*\[([0-9A-Za-z_-]+)\]/gm

/** 查章名对应的匹配词表（REVIEW_SECTIONS 反查） */
function sectionWords(name) {
  return REVIEW_SECTIONS.find(([n]) => n === name)[1]
}

/** 综述章节扫描：识别 ^#{1,3} 标题并切块，内容取到下一个同级或更高级标题为止（低级子标题归入父章）。
 *  设计思路：交付自检三项（章节齐全性 / 映射一致性 / 判断标注）都依赖「标题定位 + 章内容」，一次
 *  扫描切块后三处复用；标题剥掉「9.」「1.2」「一、」等编号前缀，使关键词匹配不依赖编号写法 */
function splitSections(reviewText) {
  const lines = reviewText.split(/\r?\n/)
  const heads = []
  lines.forEach((line, i) => {
    const m = line.match(/^(#{1,3})(?!#)\s*(.*)$/)
    if (!m) return
    const title = m[2].replace(/^(?:\d+(?:\.\d+)*|[一二三四五六七八九十]+)[.、．:：]?\s*/, "").trim()
    heads.push({ level: m[1].length, title, line: i })
  })
  return heads.map((h, i) => {
    // findIndex 返回 heads 下标，切片需要行号：换算成命中标题的 line 行号再切
    const endIdx = heads.findIndex((n, j) => j > i && n.level <= h.level)
    const endLine = endIdx === -1 ? lines.length : heads[endIdx].line
    return { level: h.level, title: h.title, body: lines.slice(h.line + 1, endLine).join("\n") }
  })
}

/** check 子命令：引用编号闭环校验（综述 [id] 必须全在素材包，剔除代码块与链接后匹配）+ 三项交付自检——
 *  1）章节齐全性（FAIL）2）文献映射一致性（FAIL）3）「（综述者判断）」标注存在性（WARN，不拦交付）；
 *  project.json 的 report.optional_sections 是用户合法裁剪章节的豁免通道 */
export function cmdCheck(root, args) {
  const cfg = loadProject(root)
  const optional = new Set(cfg.optionalSections)
  const materialFile = args.material || pPath(root, "review-material.md")
  const reviewFile = args.review || pPath(root, DIRS.deliverables, "调研综述.md")
  const materialText = readText(materialFile)
  const reviewText = readText(reviewFile)
  if (materialText === null) {
    console.log("FAIL 素材包不存在，先跑 material 子命令")
    process.exitCode = 1
    return
  }
  if (reviewText === null) {
    console.log(`FAIL 综述不存在：${reviewFile}`)
    process.exitCode = 1
    return
  }
  const validIds = new Set([...materialText.matchAll(/^## \[([^\]]+)\]/gm)].map(m => m[1]))
  // 剔除围栏代码块、行内代码、markdown 链接，防止代码/链接里的方括号被误当引用
  const scrubbed = reviewText
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]*`/g, "")
    .replace(/\[[^\]]*\]\([^)]*\)/g, "")
  const cited = [...scrubbed.matchAll(/\[([0-9A-Za-z_-]+)\]/g)].map(m => m[1])
  const citedSet = new Set(cited)
  const invalid = [...citedSet].filter(id => !validIds.has(id))
  // —— 交付自检 1：章节齐全性（豁免章剔除出必查表；任一标题命中匹配词即算存在）——
  const sections = splitSections(reviewText)
  const sections_missing = []
  for (const [name, words] of REVIEW_SECTIONS) {
    if (optional.has(name)) continue
    if (!sections.some(s => words.some(w => s.title.includes(w)))) sections_missing.push(name)
  }
  // —— 交付自检 2：文献映射一致性（映射节缺失时由自检 1 的缺章覆盖，此处不双报）——
  const mapping_missing = []
  const mapBlock = sections.find(s => sectionWords("文献映射").some(w => s.title.includes(w)))
  if (mapBlock) {
    const mapped = new Set([...mapBlock.body.matchAll(MAPPING_ID_RE)].map(m => m[1]))
    for (const id of validIds) if (!mapped.has(id)) mapping_missing.push(id)
  }
  // —— 交付自检 3：「（综述者判断）」标注存在性（章不存在时不报，缺失已由自检 1 抓）——
  const judgment_warnings = []
  for (const name of JUDGMENT_SECTION_NAMES) {
    if (optional.has(name)) continue
    const block = sections.find(s => sectionWords(name).some(w => s.title.includes(w)))
    if (block && !block.body.includes("综述者判断")) judgment_warnings.push(name)
  }
  const report = {
    review: reviewFile, material: materialFile,
    cited: [...citedSet].sort(), valid: [...validIds].sort(), invalid, total: citedSet.size,
    sections_missing, mapping_missing, judgment_warnings,
    ok: !invalid.length && citedSet.size > 0 && !sections_missing.length && !mapping_missing.length,
  }
  writeJson(pPath(root, "review_check.json"), report)
  if (invalid.length) {
    console.log(`FAIL 非法引用：${invalid.join("、")}（素材包中没有这些编号）`)
    process.exitCode = 1
  } else if (!citedSet.size) {
    console.log("WARN 综述中没有任何 [编号] 引用")
  } else {
    console.log(`OK 引用校验通过：${citedSet.size}/${validIds.size} 篇被引用，全部合法`)
  }
  // 交付自检逐条行：缺章与映射缺失是 FAIL（拦交付），标注缺失是 WARN（不拦交付）
  for (const name of sections_missing) console.log(`FAIL 缺少章节：「${name}」`)
  if (mapping_missing.length) console.log(`FAIL 文献映射缺 ${mapping_missing.length} 篇：${mapping_missing.join("、")}`)
  for (const name of judgment_warnings) console.log(`WARN 「${name}」章未见（综述者判断）标注`)
  if (sections_missing.length || mapping_missing.length) process.exitCode = 1
  // 全部干净时打一行自检汇总；有 FAIL/WARN 时逐条行已表达，不打 OK 汇总
  if (report.ok && !judgment_warnings.length) {
    const secTotal = REVIEW_SECTIONS.filter(([n]) => !optional.has(n)).length
    const judgeTotal = JUDGMENT_SECTION_NAMES
      .filter(n => !optional.has(n) && sections.some(s => sectionWords(n).some(w => s.title.includes(w)))).length
    const judgePart = judgeTotal ? `、判断标注 ${judgeTotal}/${judgeTotal}` : ""
    console.log(`OK 交付自检通过：章节 ${secTotal - sections_missing.length}/${secTotal}、文献映射 ${validIds.size - mapping_missing.length}/${validIds.size}${judgePart}`)
  }
}

/* ---------- init / init-summaries：项目骨架 ---------- */

const EMPTY_PAPERS_META = { title: "", topic: "", range: "", papers: [{ id: "01", title: "论文题名（必填）", doi: "", pmcid: "", kind: "", kind_zh: "", notes: "" }] }
const EMPTY_PROJECT = { apis: { mailto: "researcher@example.com" }, compliance: { allow_third_party: false, tier3_allowlist: [] }, download: { workers: 4, max_mb: 60, timeout: 45 } }

/** init 子命令：建目录骨架与模板文件（已存在的不覆盖） */
export function cmdInit(root) {
  for (const dir of Object.values(DIRS)) ensureDir(pPath(root, dir))
  const created = []
  for (const [file, tpl] of [["papers_meta.json", EMPTY_PAPERS_META], ["project.json", EMPTY_PROJECT]]) {
    const f = pPath(root, file)
    if (!fs.existsSync(f)) {
      writeJson(f, tpl)
      created.push(file)
    }
  }
  log(`项目骨架就绪${created.length ? `（新建 ${created.join("、")}）` : "（模板文件已存在，未覆盖）"}；下一步：填写 papers_meta.json 论文清单 → verify`)
}

/** init-summaries 子命令：按清单初始化条目模板（read_status: missing；已存在不覆盖） */
export function cmdInitSummaries(root) {
  const metaPath = pPath(root, "papers_meta.json")
  const meta = readJson(metaPath)
  if (!meta?.papers) throw new Error("papers_meta.json 不存在")
  const errors = validateMeta(meta).errors
  if (errors.length) throw new Error("papers_meta.json 校验失败：" + errors.join("; "))
  const sumDir = ensureDir(pPath(root, DIRS.summaries))
  // 摘要回填源：verify 产物里 EPMC/Crossref 已带 abstract（init-summaries 建模板时写入，已有条目缺则补填）
  const verified = readJson(pPath(root, "papers_meta.verified.json"))
  const vMap = new Map((verified?.papers || []).map(p => [String(p.id), p]))
  let n = 0
  let backfill = 0
  for (const p of meta.papers) {
    const pid = String(p.id)
    const f = pPath(sumDir, `summary_${pid}.json`)
    const vp = vMap.get(pid)
    const abstractEn = vp?.verified?.europepmc?.abstract || vp?.verified?.crossref?.abstract || ""
    if (fs.existsSync(f)) {
      // 已存在：仅补填缺失的 abstract_en，不动其他字段
      if (abstractEn) {
        const s = readJson(f)
        if (s && typeof s === "object" && !s.abstract_en) {
          s.abstract_en = abstractEn
          writeJson(f, s)
          backfill++
        }
      }
      continue
    }
    writeJson(f, {
      id: pid,
      title_en: p.title, title_zh: "", journal: p.journal || "", year: p.year || null, doi: p.doi || "",
      read_status: "missing", evidence_pages: [], evidence_figs: [],
      abstract_en: abstractEn,
      background_zh: "", question_zh: "", system_zh: "", method_zh: "", spec_evidence_zh: "",
      results_zh: "", performance_metrics: [], validation_zh: "",
      innovation_zh: "", limitation_zh: "", tags: [], key_figure: "", reviewed_at: "",
    })
    n++
  }
  log(`初始化 ${n} 篇条目模板（已有 ${meta.papers.length - n} 篇未覆盖）${backfill ? `；回填 abstract_en ${backfill} 篇` : ""}`)
}

/** validate 子命令：全量或单篇校验 summaries；0 error 才 exit 0 */
export function cmdValidate(root, args) {
  const sumDir = pPath(root, DIRS.summaries)
  const names = args.id ? [`summary_${args.id}.json`] : fs.existsSync(sumDir) ? fs.readdirSync(sumDir).filter(n => n.endsWith(".json")).sort() : []
  if (!names.length) {
    log("summaries/ 为空")
    process.exitCode = 1
    return
  }
  let bad = 0
  for (const name of names) {
    const s = readJson(pPath(sumDir, name))
    const { errors, warnings } = validateSummary(s)
    if (errors.length) bad++
    const tag = errors.length ? "ERROR" : warnings.length ? "WARN" : "OK"
    const detail = [...errors, ...warnings].join("; ")
    console.log(`[${tag}] ${name}${detail ? `：${detail}` : ""}`)
  }
  if (bad) {
    console.log(`FAIL ${bad}/${names.length} 篇有 error，回改后重跑`)
    process.exitCode = 1
  } else {
    console.log(`OK ${names.length} 篇全部通过（warning 须逐条人工判断）`)
  }
}
