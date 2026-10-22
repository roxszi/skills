// run-tests.mjs — paper-review-writer 常驻回归测试（零外部依赖；node 或 bun 直接跑）
// 设计思路：不依赖网络——网络层只测纯函数与降级逻辑，真实 API 调用属首次实战验证范围。
// 每个用例建临时目录自清理，跑完即删；任一断言失败立即标 FAIL 并累计，最后汇总退出。

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { validateMeta, validateSummary } from "../scripts/schema.mjs"
import { cmdAssemble, cmdDigest, cmdBrief, cmdMaterial, cmdCheck, cmdValidate, cmdInitSummaries, figureIndex, figureContexts } from "../scripts/pipeline.mjs"
import { writeJson, writeText, readText, readJson } from "../scripts/lib.mjs"

const results = []
function assert(name, cond) {
  results.push({ name, ok: !!cond })
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`)
}

function tmpProj() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "prw-test-"))
}

const GOOD_SUMMARY = {
  id: "01", title_en: "Good paper", title_zh: "好条目", journal: "J", year: 2024,
  doi: "10.1/x", read_status: "partial_read",
  evidence_pages: ["p1", "p3"], evidence_figs: ["Fig. 1"],
  background_zh: "背景", question_zh: "问题", method_zh: "方法", results_zh: "结果",
  innovation_zh: "创新", limitation_zh: "局限",
  tags: ["a", "b", "c"], reviewed_at: "2026-10-21",
  depth_reassessment: { verdict: "keep", reason: "预判准确" },
}

/** 完整合规综述 fixture：9 章齐全、局限与未来两章带（综述者判断）、映射节覆盖传入编号（供交付自检各用例变形） */
function fullReview(ids = ["01", "02", "03"]) {
  const mapping = ids.map(i => `- [${i}] 文献条目 ${i}`).join("\n")
  return [
    "# 调研综述",
    "## 1. 研究背景与问题定义",
    "背景正文 [01]。",
    "## 2. 领域全景与研究方向分类",
    "全景正文。",
    "## 3. 代表性方法与技术路线",
    "方法正文。",
    "## 4. 关键结果与性能对比",
    "结果正文。",
    "## 5. 研究范式演进",
    "范式正文。",
    "## 6. 现有局限与挑战",
    "局限正文（综述者判断）。",
    "## 7. 未来方向与开放问题",
    "未来正文（综述者判断）。",
    "## 8. 对用户研究的相关点",
    "相关点正文。",
    "## 9. 文献映射",
    mapping,
    "",
  ].join("\n")
}

/** 三篇素材包 fixture（与 fullReview 默认映射编号配套） */
const MATERIAL_3 = "## [01] 甲篇\n- 方法：x\n## [02] 乙篇\n- 方法：y\n## [03] 丙篇\n- 方法：z\n"

/* 1. schema：good 条目 0 error */
{
  const { errors } = validateSummary(GOOD_SUMMARY)
  assert("good 条目 0 error", errors.length === 0)
}
/* 2. schema：partial_read 缺 evidence_pages 必须 error */
{
  const bad = { ...GOOD_SUMMARY, id: "02", evidence_pages: [] }
  const { errors } = validateSummary(bad)
  assert("部分精读缺页码证据被拦", errors.some(e => e.includes("evidence_pages")))
}
/* 3. schema：year 越界 / tags 越界 / metrics 缺 label */
{
  const { errors: e1 } = validateSummary({ ...GOOD_SUMMARY, id: "03", year: 1800 })
  const { warnings: w2 } = validateSummary({ ...GOOD_SUMMARY, id: "04", tags: ["a"] })
  const { errors: e3 } = validateSummary({ ...GOOD_SUMMARY, id: "05", performance_metrics: [{ label: "", value: "1" }] })
  assert("year 越界报 error", e1.some(e => e.includes("1900")))
  assert("tags 越界报 warning", w2.some(w => w.includes("tags")))
  assert("metrics 缺 label 报 error", e3.some(e => e.includes("performance_metrics")))
}
/* 4. schema：meta 重复 id 被拦 */
{
  const { errors } = validateMeta({ papers: [{ id: "01", title: "a" }, { id: "01", title: "b" }] })
  assert("meta 重复 id 报 error", errors.some(e => e.includes("重复")))
}
/* 5. digest：页切块与图题索引 */
{
  const proj = tmpProj()
  writeText(path.join(proj, "papers_txt", "01.txt"),
    "===PAGE 1===\nTitle of paper. Abstract: we did things.\n\n===PAGE 2===\n2. Methods We used Raman spectroscopy with 785 nm laser.\n\n===PAGE 3===\n3. Results Fig. 1 shows spectra. Good signal.\n")
  cmdDigest(proj, {})
  const digest = readText(path.join(proj, "digests", "01.md")) || ""
  assert("digest 产出且含方法节", digest.includes("Methods"))
  assert("digest 含图题索引且页码正确", digest.includes("Fig. 1(p3)"))
  assert("digest ≤2600 字符", digest.length <= 2700)
  const figs = readText(path.join(proj, "digests", "01.figs.md")) || ""
  assert("figs 上下文含图题后文", figs.includes("Fig. 1") && figs.includes("shows spectra"))
  const kf = readText(path.join(proj, "digests", "keyfacts.md")) || ""
  assert("keyfacts 含篇号与方法节片段", kf.includes("### 01") && kf.includes("methods:"))
  fs.rmSync(proj, { recursive: true, force: true })
}
/* 6. figureIndex 归一化：Figure 2 与 Fig. 2 同图不重复 */
{
  const idx = figureIndex(["Figure 2 shown here", "compare Fig. 2 again"].map(t => t))
  const idx2 = figureIndex(["Scheme 3 at p3"])
  assert("图题归一化去重", idx.filter(s => s.startsWith("Fig. 2")).length === 1 && idx2[0] === "Scheme 3(p1)")
}
/* 7. save→validate→brief→material 往返 */
{
  const proj = tmpProj()
  writeJson(path.join(proj, "summaries", "summary_01.json"), GOOD_SUMMARY)
  writeJson(path.join(proj, "summaries", "summary_02.json"), { ...GOOD_SUMMARY, id: "02", read_status: "partial_read", evidence_figs: [] })
  writeJson(path.join(proj, "summaries", "summary_03.json"), {
    ...GOOD_SUMMARY, id: "03", read_status: "abstract_only", evidence_pages: [], evidence_figs: [],
    abstract_en: "A Raman study of paeonol in emulsions.", depth_reassessment: { verdict: "downgrade", reason: "边缘" },
  })
  cmdBrief(proj)
  const brief = readText(path.join(proj, "digests", "brief.md")) || ""
  assert("brief 含中文阅读深度", brief.includes("部分精读"))
  assert("brief 每篇 ≤320 字符块", brief.split(/\n(?=\[\d\d\|)/).every(b => b.length <= 340))
  cmdMaterial(proj)
  const material = readText(path.join(proj, "review-material.md")) || ""
  assert("素材包含好条目", material.includes("[01]"))
  assert("坏条目被素材包拦截", !material.includes("[02]") && material.includes("未通过"))
  assert("仅摘要条目附摘要节选", material.includes("[03]") && material.includes("paeonol in emulsions"))
  fs.rmSync(proj, { recursive: true, force: true })
}
/* 8. check：合法 / 非法 / 代码块与链接剔除 */
{
  const proj = tmpProj()
  writeText(path.join(proj, "review-material.md"), "## [01] 题名\n- 方法：x\n")
  writeText(path.join(proj, "deliverables", "调研综述.md"), "正文 [01]；代码 `[99]`；链接 [x](https://a.com) 不算；真非法 [88]。")
  cmdCheck(proj, {})
  const report1 = readJson(path.join(proj, "review_check.json"))
  assert("非法引用 88 被抓、代码与链接剔除", report1.invalid.length === 1 && report1.invalid[0] === "88" && !report1.invalid.includes("99"))
  // 完整合规 fixture：新版 ok 收紧为「引用合法 + 章节齐 + 映射齐」，原单行综述不再能 ok=true
  writeText(path.join(proj, "deliverables", "调研综述.md"), fullReview(["01"]))
  cmdCheck(proj, {})
  const report2 = readJson(path.join(proj, "review_check.json"))
  assert("全合法引用通过", report2.ok === true)
  fs.rmSync(proj, { recursive: true, force: true })
}
/* 9. validate 命令级：0 error exit 0 / 有 error exit 1 */
{
  const proj = tmpProj()
  writeJson(path.join(proj, "summaries", "summary_01.json"), GOOD_SUMMARY)
  const code0 = await runCmd(() => cmdValidate(proj, {}))
  assert("validate 全好 exit 0", code0 === 0)
  writeJson(path.join(proj, "summaries", "summary_02.json"), { ...GOOD_SUMMARY, id: "02", year: 1850 })
  const code1 = await runCmd(() => cmdValidate(proj, {}))
  assert("validate 含坏条目 exit 1", code1 === 1)
  fs.rmSync(proj, { recursive: true, force: true })
}

/* 10. schema：depth_reassessment 二次评估（缺失 warning 分级、verdict 枚举） */
{
  const bad = validateSummary({ ...GOOD_SUMMARY, id: "06", depth_reassessment: { verdict: "higher", reason: "x" } })
  assert("二次评估 verdict 非法报 error", bad.errors.some(e => e.includes("depth_reassessment")))
  const ok = validateSummary({ ...GOOD_SUMMARY, id: "07", depth_reassessment: { verdict: "downgrade", reason: "边缘文献" } })
  assert("二次评估合法 0 error 0 相关 warning", ok.errors.length === 0 && !ok.warnings.some(w => w.includes("depth_reassessment")))
  const obj08 = { ...GOOD_SUMMARY, id: "08" }
  delete obj08.depth_reassessment
  const noWarn = validateSummary(obj08)
  assert("非未获取条目缺二次评估报 warning", noWarn.warnings.some(w => w.includes("depth_reassessment")))
  const obj09 = { ...GOOD_SUMMARY, id: "09", read_status: "missing", evidence_pages: [], evidence_figs: [] }
  delete obj09.depth_reassessment
  const miss = validateSummary(obj09)
  assert("未获取条目缺二次评估不报", !miss.errors.length && !miss.warnings.some(w => w.includes("depth_reassessment")))
}
/* 11. assemble：章节文件拼装 */
{
  const proj = tmpProj()
  writeText(path.join(proj, "deliverables", "sections", "00_结论先行.md"), "# 结论\nA")
  writeText(path.join(proj, "deliverables", "sections", "01_背景.md"), "# 背景\nB")
  cmdAssemble(proj, {})
  const out = readText(path.join(proj, "deliverables", "综述.md")) || ""
  assert("assemble 按序拼装两章节", out.includes("A") && out.includes("B") && out.indexOf("A") < out.indexOf("B"))
  fs.rmSync(proj, { recursive: true, force: true })
}

/* 12. figureContexts：图题首现上下文提取与归一化 */
{
  const ctx = figureContexts(["Intro text only.", "3. Results Fig. 1 shows spectra. Good signal."])
  assert("图题上下文含页码与后文", ctx.length === 1 && ctx[0][0] === "Fig. 1" && ctx[0][1].startsWith("p2:") && ctx[0][1].includes("shows spectra"))
  const ctx2 = figureContexts(["Scheme 3 overall route.", "compare Fig. 2 data"])
  assert("多图题各自归一化去重", ctx2.length === 2 && ctx2.some(([k]) => k === "Scheme 3") && ctx2.some(([k]) => k === "Fig. 2"))
}
/* 13. init-summaries：摘要回填（新建模板写入 + 已有条目补填） */
{
  const proj = tmpProj()
  writeJson(path.join(proj, "papers_meta.json"), { papers: [{ id: "01", title: "T" }] })
  writeJson(path.join(proj, "papers_meta.verified.json"), { papers: [{ id: "01", title: "T", verified: { europepmc: { abstract: "An abstract about Raman." } } }] })
  cmdInitSummaries(proj)
  const s = readJson(path.join(proj, "summaries", "summary_01.json"))
  assert("init-summaries 建模板写入 abstract_en", s.abstract_en === "An abstract about Raman.")
  delete s.abstract_en
  writeJson(path.join(proj, "summaries", "summary_01.json"), s)
  cmdInitSummaries(proj)
  const s2 = readJson(path.join(proj, "summaries", "summary_01.json"))
  assert("已存在条目补填 abstract_en", s2.abstract_en === "An abstract about Raman.")
  fs.rmSync(proj, { recursive: true, force: true })
}

/* 14. check 交付自检：完整合规综述三数组全空 */
{
  const proj = tmpProj()
  writeText(path.join(proj, "review-material.md"), MATERIAL_3)
  writeText(path.join(proj, "deliverables", "调研综述.md"), fullReview())
  cmdCheck(proj, {})
  const report = readJson(path.join(proj, "review_check.json"))
  assert("完整合规综述自检全过", report.ok === true && report.sections_missing.length === 0 && report.mapping_missing.length === 0 && report.judgment_warnings.length === 0)
  fs.rmSync(proj, { recursive: true, force: true })
}
/* 15. check 交付自检：缺章 FAIL（删第 5 章） */
{
  const proj = tmpProj()
  writeText(path.join(proj, "review-material.md"), MATERIAL_3)
  writeText(path.join(proj, "deliverables", "调研综述.md"), fullReview().replace("## 5. 研究范式演进\n范式正文。\n", ""))
  cmdCheck(proj, {})
  const report = readJson(path.join(proj, "review_check.json"))
  assert("缺章被抓且 ok=false", report.sections_missing.includes("研究范式演进") && report.ok === false)
  fs.rmSync(proj, { recursive: true, force: true })
}
/* 16. check 交付自检：映射缺编号 FAIL（删 [02] 一行） */
{
  const proj = tmpProj()
  writeText(path.join(proj, "review-material.md"), MATERIAL_3)
  writeText(path.join(proj, "deliverables", "调研综述.md"), fullReview().replace("- [02] 文献条目 02\n", ""))
  cmdCheck(proj, {})
  const report = readJson(path.join(proj, "review_check.json"))
  assert("映射缺编号被抓且 ok=false", report.mapping_missing.length === 1 && report.mapping_missing[0] === "02" && report.ok === false)
  fs.rmSync(proj, { recursive: true, force: true })
}
/* 17. check 交付自检：判断标注缺失仅 WARN（不拦交付） */
{
  const proj = tmpProj()
  writeText(path.join(proj, "review-material.md"), MATERIAL_3)
  writeText(path.join(proj, "deliverables", "调研综述.md"), fullReview().replaceAll("（综述者判断）", ""))
  cmdCheck(proj, {})
  const report = readJson(path.join(proj, "review_check.json"))
  const warnOk = report.judgment_warnings.length === 2 && report.judgment_warnings.includes("现有局限与挑战") && report.judgment_warnings.includes("未来方向与开放问题")
  assert("两章缺判断标注报两条 WARN 且 ok 仍 true", warnOk && report.ok === true)
  const code = await runCmd(() => cmdCheck(proj, {}))
  assert("纯 WARN 不设非零退出码", code === 0)
  fs.rmSync(proj, { recursive: true, force: true })
}
/* 18. check 交付自检：optional_sections 豁免裁剪章节 */
{
  const proj = tmpProj()
  writeText(path.join(proj, "review-material.md"), MATERIAL_3)
  writeJson(path.join(proj, "project.json"), { report: { optional_sections: ["研究范式演进"] } })
  writeText(path.join(proj, "deliverables", "调研综述.md"), fullReview().replace("## 5. 研究范式演进\n范式正文。\n", ""))
  cmdCheck(proj, {})
  const report = readJson(path.join(proj, "review_check.json"))
  assert("豁免章缺失不再 FAIL 且 ok=true", report.sections_missing.length === 0 && report.ok === true)
  fs.rmSync(proj, { recursive: true, force: true })
}

/** 运行一个会自行设置 exitCode 的命令函数，返回进程退出码 */
async function runCmd(fn) {
  const prev = process.exitCode
  process.exitCode = undefined
  try { await fn() } catch { /* 命令内部已处理 */ }
  const code = process.exitCode ?? 0
  process.exitCode = prev
  return code
}

const failed = results.filter(r => !r.ok)
console.log(`\n${failed.length ? "FAIL" : "ALL PASS"}：${results.length - failed.length}/${results.length} 断言通过`)
// 退出码统一收口：用例内 cmdCheck 等命令会按 FAIL 场景设置进程级 exitCode（如故意造非法引用、缺章），
// 直接调用不走 runCmd 包装的用例会泄漏到进程——汇总时无论全过还是有败都显式置值，防历史与未来用例复发
process.exitCode = failed.length ? 1 : 0
