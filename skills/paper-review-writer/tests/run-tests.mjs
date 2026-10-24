// run-tests.mjs — paper-review-writer 常驻回归测试（零外部依赖；node 或 bun 直接跑）
// 设计思路：不依赖网络——网络层只测纯函数与降级逻辑，真实 API 调用属首次实战验证范围。
// 每个用例建临时目录自清理，跑完即删；任一断言失败立即标 FAIL 并累计，最后汇总退出。

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { validateMeta, validateSummary } from "../scripts/schema.mjs"
import { cmdAssemble, cmdDigest, cmdBrief, cmdMaterial, cmdCheck, cmdValidate, cmdInitSummaries, cmdMap, cmdDispatch, figureIndex, figureContexts } from "../scripts/pipeline.mjs"
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
  // 缺省路径三分支：用不同内容区分实际读到的文件（缺省名命中 / 唯一候选回退 / 多候选拒绝）
  writeText(path.join(proj, "deliverables", "综述.md"), fullReview(["01"]))
  writeText(path.join(proj, "deliverables", "调研综述.md"), "正文 [88]。")
  cmdCheck(proj, {})
  assert("check 缺省名 综述.md 命中（非回退）", (readJson(path.join(proj, "review_check.json")) || {}).ok === true)
  fs.unlinkSync(path.join(proj, "deliverables", "综述.md"))
  cmdCheck(proj, {})
  const r3 = readJson(path.join(proj, "review_check.json")) || {}
  assert("check 唯一候选 调研综述.md 回退命中", r3.ok === false && (r3.invalid || []).includes("88"))
  writeText(path.join(proj, "deliverables", "旧稿.md"), "x")
  const codeMulti = await runCmd(() => cmdCheck(proj, {}))
  assert("check 多候选拒绝 exit 1", codeMulti === 1)
  fs.unlinkSync(path.join(proj, "deliverables", "旧稿.md"))
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

/* 19. map：文献映射章生成（条目定收录、题录定作者、未获取跳过、异常分支抛错） */
{
  const proj = tmpProj()
  writeJson(path.join(proj, "papers_meta.verified.json"), { title: "t", range: "", papers: [
    { id: "01", title: "Paper One", doi: "10.1/1", year: 2024, journal: "J One", verified: { crossref: { authors: "Holly J Butler; Lorna Ashton" } } },
    { id: "02", title: "Paper Two", doi: "10.1/2", year: 2023, journal: "J Two", verified: {} },
    { id: "03", title: "Paper Three", doi: "10.1/3", year: 2022, journal: "J Three", verified: { crossref: { authors: "Solo Author" } } },
  ] })
  writeJson(path.join(proj, "summaries", "summary_01.json"), GOOD_SUMMARY)
  writeJson(path.join(proj, "summaries", "summary_02.json"), { ...GOOD_SUMMARY, id: "02", read_status: "missing", evidence_pages: [], evidence_figs: [], depth_reassessment: { verdict: "keep", reason: "未获取不评" } })
  writeJson(path.join(proj, "summaries", "summary_03.json"), { ...GOOD_SUMMARY, id: "03" })
  cmdMap(proj, {})
  const mapText = readText(path.join(proj, "deliverables", "sections", "09_文献映射.md")) || ""
  assert("map 多作者首作者加 et al.", mapText.includes("[01] Holly J Butler et al. Paper One. J One, 2024. doi:10.1/1"))
  assert("map 跳过未获取条目", !mapText.includes("[02]"))
  assert("map 单作者不加 et al.", mapText.includes("[03] Solo Author. Paper Three"))
  fs.rmSync(proj, { recursive: true, force: true })
  // 异常分支：verified 缺失 / 清单为空数组 / summaries 为空 → 全部抛错拒绝静默产出
  const bad = tmpProj()
  let threw = false
  try { cmdMap(bad, {}) } catch { threw = true }
  assert("map verified 缺失抛错", threw)
  writeJson(path.join(bad, "papers_meta.verified.json"), { title: "t", range: "", papers: [] })
  threw = false
  try { cmdMap(bad, {}) } catch { threw = true }
  assert("map 空清单抛错", threw)
  writeJson(path.join(bad, "papers_meta.verified.json"), { title: "t", range: "", papers: [{ id: "01", title: "P" }] })
  threw = false
  try { cmdMap(bad, {}) } catch { threw = true }
  assert("map summaries 为空抛错", threw)
  fs.rmSync(bad, { recursive: true, force: true })
  // 全 missing → 空映射章 + exitCode 1（不静默成功）
  const allMiss = tmpProj()
  writeJson(path.join(allMiss, "papers_meta.verified.json"), { title: "t", range: "", papers: [{ id: "01", title: "P" }] })
  writeJson(path.join(allMiss, "summaries", "summary_01.json"), { ...GOOD_SUMMARY, read_status: "missing", evidence_pages: [], evidence_figs: [], depth_reassessment: { verdict: "keep", reason: "未获取不评" } })
  const missCode = await runCmd(() => cmdMap(allMiss, {}))
  assert("map 全 missing 空章且 exitCode 1", missCode === 1 && !(readText(path.join(allMiss, "deliverables", "sections", "09_文献映射.md")) || "").includes("[01]"))
  fs.rmSync(allMiss, { recursive: true, force: true })
}
/* 20. dispatch：任务单生成（回收状态 + 本批任务卡 + batch 控制 + 待修分类 + 异常分支） */
{
  const proj = tmpProj()
  writeJson(path.join(proj, "papers_meta.json"), { title: "t", range: "", papers: [
    { id: "01", title: "P1" }, { id: "02", title: "P2" }, { id: "03", title: "P3" },
  ] })
  writeJson(path.join(proj, "summaries", "summary_01.json"), GOOD_SUMMARY)
  cmdDispatch(proj, { batch: "2", context: "测试上下文" })
  const d = readText(path.join(proj, "deliverables", "dispatch.md")) || ""
  assert("dispatch 本批含任务卡要素", d.includes("## 任务卡 02｜P2") && d.includes("## 任务卡 03｜P3") && d.includes("测试上下文") && d.includes("--id 02"))
  assert("dispatch 回收与队列正确", d.includes("已回收 1/3") && d.includes("已回收：01") && d.includes("队列剩余：无"))
  assert("dispatch digest 缺失任务卡带 ⚠ 标注", d.includes("⚠") && d.includes("digest --id 02"))
  fs.rmSync(proj, { recursive: true, force: true })
  // 待修分类：条目存在但 validate 有 error → 不计已回收，单列待修；batch 非法值统一回落 2（需 pending ≥ 2 才能测出回落）
  const proj2 = tmpProj()
  writeJson(path.join(proj2, "papers_meta.json"), { title: "t", range: "", papers: [
    { id: "01", title: "P1" }, { id: "02", title: "P2" }, { id: "03", title: "P3" },
  ] })
  writeJson(path.join(proj2, "summaries", "summary_01.json"), { ...GOOD_SUMMARY, read_status: "partial_read", evidence_pages: [], evidence_figs: [] })
  cmdDispatch(proj2, { batch: "-1", context: "x" })
  const d2 = readText(path.join(proj2, "deliverables", "dispatch.md")) || ""
  assert("dispatch 待修条目不计已回收", d2.includes("已回收 0/3") && d2.includes("待修（条目存在但校验有 error，重修后自动计入已回收）：01"))
  assert("dispatch batch 非法值回落 2 张", d2.includes("本批任务卡 2 张：02、03") && d2.includes("队列剩余：无"))
  // 空清单：非数组或空数组 → 抛错拒绝静默产出
  const bad = tmpProj()
  let threw = false
  try { cmdDispatch(bad, {}) } catch { threw = true }
  assert("dispatch 清单缺失抛错", threw)
  writeJson(path.join(bad, "papers_meta.json"), { title: "t", range: "", papers: [] })
  threw = false
  try { cmdDispatch(bad, {}) } catch { threw = true }
  assert("dispatch 空清单抛错", threw)
  fs.rmSync(bad, { recursive: true, force: true })
}

// ---------- export_html（第 5 步引擎）----------
{
  const dir = tmpProj()
  // 1x1 PNG（最小合法位图，硬编码 base64 避免二进制 fixture）
  const pngB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
  fs.writeFileSync(path.join(dir, "fig.png"), Buffer.from(pngB64, "base64"))
  const md = [
    "# 测试综述",
    "![图一](fig.png)",
    "![远程](https://example.com/x.png)",
    "![缺失](figures/09_x/fig_9.png)",
    '<script src="https://cdn.example.com/x.js"></script>',
    "",
  ].join("\n")
  const mdPath = path.join(dir, "综述.md")
  fs.writeFileSync(mdPath, md, "utf8")
  const { buildStandaloneHtml } = await import("../scripts/export_html.mjs")
  const outPath = path.join(dir, "综述.html")
  const r = await buildStandaloneHtml(mdPath, outPath)
  assert("export-html 内嵌数=1", r.embedded === 1)
  assert("export-html 外链数=1", r.external.length === 1)
  assert("export-html 缺失数=1", r.missing.length === 1)
  const html = readText(outPath)
  assert("export-html 含 base64 data URI", html.includes("data:image/png;base64,"))
  assert("export-html raw script 原样保留", html.includes('<script src="https://cdn.example.com/x.js"></script>'))
  assert("export-html 引擎不新增脚本", (html.match(/<script/g) || []).length === 1)
  assert("export-html 缺失引用原样保留", html.includes('src="figures/09_x/fig_9.png"'))
  fs.rmSync(dir, { recursive: true, force: true })
}

// ---------- export_html：B1 项目根基准（缺省 deliverables/ 布局）+ W5 畸形 % 降级 ----------
{
  const dir = tmpProj()
  const pngB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
  // 缺省布局：图在 <项目根>/figures/，综述在 <项目根>/deliverables/（md 引用相对项目根书写）
  fs.mkdirSync(path.join(dir, "figures", "03_x"), { recursive: true })
  fs.writeFileSync(path.join(dir, "figures", "03_x", "fig_1.png"), Buffer.from(pngB64, "base64"))
  fs.mkdirSync(path.join(dir, "deliverables"), { recursive: true })
  const md2Path = path.join(dir, "deliverables", "综述.md")
  fs.writeFileSync(md2Path, "# t\n\n![图](figures/03_x/fig_1.png)\n", "utf8")
  const { buildStandaloneHtml } = await import("../scripts/export_html.mjs")
  const r2 = await buildStandaloneHtml(md2Path, path.join(dir, "deliverables", "综述.html"), { imgBaseDir: dir })
  assert("export-html imgBaseDir 项目根基准", r2.embedded === 1)
  assert("export-html imgBaseDir 零缺失", r2.missing.length === 0)
  // 畸形 % 序列：decodeURIComponent 抛 URIError，须单图降级为 missing 而非炸整次导出
  const md3Path = path.join(dir, "综述3.md")
  fs.writeFileSync(md3Path, "# t\n\n![坏](fig.png%zz)\n", "utf8")
  let threw3 = false
  let r3
  try { r3 = await buildStandaloneHtml(md3Path, path.join(dir, "综述3.html")) } catch { threw3 = true }
  assert("export-html 畸形%不炸导出", !threw3)
  assert("export-html 畸形%降级 missing", r3 && r3.missing.length === 1)
  fs.rmSync(dir, { recursive: true, force: true })
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
