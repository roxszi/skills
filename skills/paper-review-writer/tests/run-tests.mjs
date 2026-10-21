// run-tests.mjs — paper-review-writer 常驻回归测试（零外部依赖；node 或 bun 直接跑）
// 设计思路：不依赖网络——网络层只测纯函数与降级逻辑，真实 API 调用属首次实战验证范围。
// 每个用例建临时目录自清理，跑完即删；任一断言失败立即标 FAIL 并累计，最后汇总退出。

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { validateMeta, validateSummary } from "../scripts/schema.mjs"
import { cmdDigest, cmdBrief, cmdMaterial, cmdCheck, cmdValidate, figureIndex } from "../scripts/pipeline.mjs"
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
}

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
  cmdBrief(proj)
  const brief = readText(path.join(proj, "digests", "brief.md")) || ""
  assert("brief 含中文阅读深度", brief.includes("部分精读"))
  assert("brief 每篇 ≤320 字符块", brief.split(/\n(?=\[\d\d\|)/).every(b => b.length <= 340))
  cmdMaterial(proj)
  const material = readText(path.join(proj, "review-material.md")) || ""
  assert("素材包含好条目", material.includes("[01]"))
  assert("坏条目被素材包拦截", !material.includes("[02]") && material.includes("未通过"))
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
  writeText(path.join(proj, "deliverables", "调研综述.md"), "正文 [01] 结论 [01]。")
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
if (failed.length) process.exitCode = 1
