#!/usr/bin/env node
/**
 * run-tests.mjs — paper-methodology-audit skill 的回归测试（批量断言）。
 *
 * 设计思路：
 *   skill 的灵魂是证据强制，脚本改坏会导致"假通过"（校验器失效比没有校验器更危险）。
 *   本测试用好 / 坏两个 fixture + 综述样本，对三个脚本做端到端断言：
 *     A. fixture-good   → validate 退出 0，输出 OK
 *     B. fixture-bad    → validate 退出 1，error ≥ 5（证据强制 2 条必须命中）
 *     C. gen            → 产出素材包含 [slug] 锚点与禁编造声明，坏条目被跳过
 *     D. check 坏引用   → 退出 1 且点名非法 slug（markdown 链接 / 代码块不误报）
 *     E. check 好引用   → 退出 0 输出 OK
 *   任一断言失败立即报告并整体退出 1。
 *
 * 用法：node run-tests.mjs（bun 亦可；子进程用 process.execPath，与运行时无关）
 */
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { readFileSync, writeFileSync, rmSync } from "node:fs"

const here = dirname(fileURLToPath(import.meta.url))
const scripts = join(here, "..", "scripts")
const fixtures = join(here, "fixtures")
const good = join(fixtures, "fixture-good.json")
const bad = join(fixtures, "fixture-bad.json")
const review = join(fixtures, "fixture-review.md")
const material = join(here, "_review-material.md")

let failed = 0

/** 断言封装：cond 为假则记失败并打印上下文 */
function assert(name, cond, detail = "") {
  if (cond) console.log(`PASS ${name}`)
  else { console.error(`FAIL ${name}${detail ? " — " + detail : ""}`); failed += 1 }
}

/** 跑子脚本，返回 { status, stdout, stderr } */
function run(script, args) {
  const r = spawnSync(process.execPath, [join(scripts, script), ...args], { encoding: "utf8" })
  return { status: r.status, stdout: (r.stdout ?? "") + (r.stderr ?? "") }
}

// A. 好条目 → 0 error
const a = run("validate-reading.mjs", [good])
assert("A good→OK", a.status === 0 && a.stdout.includes("OK"), `exit=${a.status} out=${a.stdout.slice(0, 200)}`)

// B. 坏条目 → FAIL 且命中预期 error（灵魂条款：证据强制 2 条）
const b = run("validate-reading.mjs", [bad])
const bErr = ["evidence_pages", "evidence_figs", "year", "tags", "performance_metrics[1]"]
  .filter((k) => b.stdout.includes(k))
assert("B bad→FAIL", b.status === 1, `exit=${b.status}`)
assert("B2 命中5处预期error", bErr.length === 5, `只命中 ${bErr.join(", ")}`)
assert("B3 超长warning", b.stdout.includes("超长"), "未见超长 warning")

// C. 素材包生成：好条目进包、坏条目跳过、锚点与声明齐全
const c = run("gen-review-material.mjs", [fixtures, "-o", material])
const matText = readFileSync(material, "utf8")
assert("C gen→OK", c.status === 0 && c.stdout.includes("OK"), `exit=${c.status} out=${c.stdout.slice(0, 200)}`)
assert("C2 含slug锚点", matText.includes("## [example-sers-ag-2025]"))
assert("C3 含禁编造声明", matText.includes("禁止编造"))
assert("C4 坏条目被跳过", c.stdout.includes("跳过 1"), c.stdout.slice(0, 200))

// D. 引用校验：非法引用 FAIL，链接 / 代码块不误报
const d = run("check-review-cites.mjs", [review, material])
assert("D 非法引用→FAIL", d.status === 1 && d.stdout.includes("nonexistent-slug"), `exit=${d.status} out=${d.stdout}`)
assert("D2 合法slug不在非法名单", !d.stdout.split("：")[1]?.includes("example-sers-ag-2025"))

// E. 引用校验：干净综述 OK
const cleanMd = join(here, "_clean-review.md")
writeFileSync(cleanMd, "结论成立 [example-sers-ag-2025]。\n", "utf8")
const e = run("check-review-cites.mjs", [cleanMd, material])
assert("E 干净综述→OK", e.status === 0 && e.stdout.includes("OK"), `exit=${e.status} out=${e.stdout}`)

// F. partial_read 四态（v0.3.0）：L1-C 核心档合法路径 + 缺证据拦截
const goodObj = JSON.parse(readFileSync(good, "utf8"))
const partialPath = join(here, "_fixture-partial.json")
const partialObj = { ...goodObj, read_status: "partial_read", evidence_pages: ["§1", "§4.2"] }
writeFileSync(partialPath, JSON.stringify(partialObj, null, 2), "utf8")
const f1 = run("validate-reading.mjs", [partialPath])
assert("F partial_read→OK", f1.status === 0 && f1.stdout.includes("OK"), `exit=${f1.status} out=${f1.stdout.slice(0, 200)}`)

const partialNoEv = { ...partialObj }
delete partialNoEv.evidence_pages
const partialNoEvPath = join(here, "_fixture-partial-noev.json")
writeFileSync(partialNoEvPath, JSON.stringify(partialNoEv, null, 2), "utf8")
const f2 = run("validate-reading.mjs", [partialNoEvPath])
assert("F2 partial缺证据→FAIL", f2.status === 1 && f2.stdout.includes("evidence_pages"), `exit=${f2.status} out=${f2.stdout.slice(0, 200)}`)

// 清理本轮临时产物（保留 fixture 与本脚本作为常驻回归资产）
for (const f of [material, cleanMd, partialPath, partialNoEvPath]) rmSync(f, { force: true })

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
