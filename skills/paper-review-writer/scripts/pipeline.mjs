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
    log(`[${pid}] digest ${digest.length} 字符`)
  }
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
    const lines = [
      `\n## [${pid}] ${clip(s.title_zh || s.title_en, 60)}`,
      `- 方向：${clip((s.tags || []).join("、"), 40)}｜阅读深度：${statusZh[s.read_status] || s.read_status}｜${s.journal} ${s.year}${s.doi ? `｜doi:${s.doi}` : ""}`,
    ]
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

/* ---------- check：综述引用编号校验 ---------- */

/** check 子命令：综述中 [id] 引用必须全部存在于素材包；剔除代码块与链接后匹配 */
export function cmdCheck(root, args) {
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
  const report = {
    review: reviewFile, material: materialFile,
    cited: [...citedSet].sort(), valid: [...validIds].sort(), invalid, total: citedSet.size,
    ok: !invalid.length && citedSet.size > 0,
  }
  writeJson(pPath(root, "review_check.json"), report)
  if (invalid.length) {
    console.log(`FAIL 非法引用：${invalid.join(", ")}（素材包中没有这些编号）`)
    process.exitCode = 1
  } else if (!citedSet.size) {
    console.log("WARN 综述中没有任何 [编号] 引用")
  } else {
    console.log(`OK 引用校验通过：${citedSet.size}/${validIds.size} 篇被引用，全部合法`)
  }
}

/* ---------- init / init-summaries：项目骨架 ---------- */

const EMPTY_PAPERS_META = { title: "", topic: "", range: "", papers: [{ id: "01", title: "论文题名（必填）", doi: "", pmcid: "", kind: "", kind_zh: "", notes: "" }] }
const EMPTY_PROJECT = { apis: { mailto: "researcher@example.com" }, compliance: { allow_third_party: false }, download: { workers: 4, max_mb: 60, timeout: 45 } }

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
  let n = 0
  for (const p of meta.papers) {
    const pid = String(p.id)
    const f = pPath(sumDir, `summary_${pid}.json`)
    if (fs.existsSync(f)) continue
    writeJson(f, {
      id: pid,
      title_en: p.title, title_zh: "", journal: p.journal || "", year: p.year || null, doi: p.doi || "",
      read_status: "missing", evidence_pages: [], evidence_figs: [],
      background_zh: "", question_zh: "", system_zh: "", method_zh: "", spec_evidence_zh: "",
      results_zh: "", performance_metrics: [], validation_zh: "",
      innovation_zh: "", limitation_zh: "", tags: [], key_figure: "", reviewed_at: "",
    })
    n++
  }
  log(`初始化 ${n} 篇条目模板（已有 ${meta.papers.length - n} 篇未覆盖）`)
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
