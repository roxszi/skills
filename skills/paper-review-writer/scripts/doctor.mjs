// doctor.mjs — doctor 子命令：环境健康自检（node 版本 + 五依赖子进程冒烟）
// 设计思路：五依赖中 sharp / @napi-rs/canvas / pdfjs 渲染链是原生敏感路径，存在「依赖装着、
// 一跑就崩」的静默失败形态（node_modules 残留旧版副本段错误，0.5.1 实录）；装完依赖能否跑，
// 只能等业务命令撞上才知道，排障成本高。doctor 把体检前移为一条命令：所有依赖冒烟在子进程
// 执行（doctor_smoke.mjs），父进程只收退出码与 stderr 尾行——原生段错误拖不垮自检编排；
// 段错误类失败给专属修复提示（删整个 node_modules 重装，只改 package.json 版本不够）。
// 冒烟样张：程序化构造的最小单页 PDF（含文本 SMOKE-OK），xref 偏移逐对象实算，pdfjs 渲染链
// 与 pdf-parse 文本提取共用同一份；不随 skill 分发二进制 fixture。
// 依赖纪律：本文件与 review.mjs 入口层一样零外部依赖（只 import node 内置 + lib.mjs），
// 保证「依赖坏掉」的场景下 doctor 本身仍能启动——这是体检命令的先决条件。

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"
import { spawnSync } from "node:child_process"
import { log } from "./lib.mjs"

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url))
const SMOKE_PATH = path.join(SCRIPTS_DIR, "doctor_smoke.mjs")
const SKILL_ROOT = path.resolve(SCRIPTS_DIR, "..")

/** Windows 访问违例（0xC0000005）的两种退出码形态：无符号 3221225477 / 有符号 -1073741819 */
const ACCESS_VIOLATION_CODES = new Set([3221225477, -1073741819])

/** 冒烟清单：mode 与 doctor_smoke.mjs 分支一一对应；pkg 供版本读取 */
const SMOKE_ITEMS = [
  { mode: "marked", name: "marked", pkg: "marked" },
  { mode: "pdf-parse", name: "pdf-parse", pkg: "pdf-parse" },
  { mode: "sharp", name: "sharp（原生）", pkg: "sharp" },
  { mode: "canvas", name: "@napi-rs/canvas（原生）", pkg: "@napi-rs/canvas" },
  { mode: "pdfjs", name: "pdfjs-dist 渲染链（wasm + canvas + sharp）", pkg: "pdfjs-dist" },
]

/** 构造最小合法单页 PDF（文本 SMOKE-OK）；全 ASCII 用 latin1 保证 1 字符 = 1 字节，xref 偏移实算 */
export function buildMinimalPdf() {
  const stream = "BT /F1 12 Tf 20 80 Td (SMOKE-OK) Tj ET"
  const objects = [
    "",
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 120]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>",
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
    `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`,
  ]
  const head = "%PDF-1.4\n"
  let body = ""
  const offsets = [0]
  for (let i = 1; i < objects.length; i++) {
    offsets[i] = head.length + body.length
    body += `${i} 0 obj\n${objects[i]}\nendobj\n`
  }
  const xrefStart = head.length + body.length
  let xref = `xref\n0 ${objects.length}\n0000000000 65535 f \n`
  for (let i = 1; i < objects.length; i++) xref += String(offsets[i]).padStart(10, "0") + " 00000 n \n"
  const trailer = `trailer\n<</Size ${objects.length}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF\n`
  return Buffer.from(head + body + xref + trailer, "latin1")
}

/** 读依赖版本；读不到返回空串（部分包 exports 不暴露 package.json，不算异常） */
function pkgVersion(req, pkg) {
  try {
    return JSON.parse(fs.readFileSync(req.resolve(`${pkg}/package.json`), "utf8")).version || ""
  } catch {
    return ""
  }
}

/** 单项冒烟：spawn 子进程跑 doctor_smoke.mjs，把退出码 / 信号 / stderr 尾行归因为健康表行 */
function smokeOne(req, item, pdfB64, pdfjsDir) {
  const env = { ...process.env, SMOKE_PDF_B64: pdfB64, SMOKE_PDFJS_DIR: pdfjsDir }
  const r = spawnSync(process.execPath, [SMOKE_PATH, item.mode], { cwd: SKILL_ROOT, env, encoding: "utf8", timeout: 60000 })
  if (r.status === 0 && !r.error) {
    const v = pkgVersion(req, item.pkg)
    return { name: item.name, ok: true, detail: `${v ? "v" + v + "，" : ""}冒烟通过`, fix: "" }
  }
  const tail = String(r.stderr || r.stdout || "").trim().split(/\r?\n/).filter(Boolean).pop() || ""
  let detail
  let fix
  if (r.error && r.error.code === "ENOENT") {
    detail = `无法启动子进程：${r.error.message}`
    fix = "确认 node 可用后重跑 doctor"
  } else if (ACCESS_VIOLATION_CODES.has(r.status) || r.signal === "SIGSEGV" || r.signal === "SIGILL") {
    detail = "原生段错误（进程被信号终止 / 访问违例）"
    fix = "原生模块副本损坏（多见 node_modules 残留旧版）：删除整个 node_modules 后在本 skill 目录重装（npm install / pnpm install / bun install 任一），只改 package.json 版本不够"
  } else if (r.signal === "SIGTERM") {
    detail = "冒烟超时（60s）被终止"
    fix = "重跑一次确认；仍超时则检查机器负载，或删除 node_modules 重装依赖"
  } else {
    detail = tail || `退出码 ${r.status}`
    fix = "在本 skill 目录重装依赖（npm install / pnpm install / bun install 任一）后重跑 doctor"
  }
  return { name: item.name, ok: false, detail, fix }
}

/** node 版本下限比较（三段数值逐段比，非完整 semver 语义） */
function nodeVersionAtLeast(v, min) {
  const a = String(v).split(".").map(n => parseInt(n, 10) || 0)
  const b = String(min).split(".").map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true
    if (a[i] < b[i]) return false
  }
  return true
}

/** doctor 子命令：打印健康表，返回 { allOk, rows }（返回值供测试断言） */
export function cmdDoctor() {
  log("环境健康自检（doctor）——node 版本 + 五依赖子进程冒烟")
  const req = createRequire(path.join(SKILL_ROOT, "package.json"))
  const rows = []
  const nodeVer = process.versions.node
  const nodeOk = nodeVersionAtLeast(nodeVer, "22.13")
  rows.push({
    name: "node（要求 ≥ 22.13）",
    ok: nodeOk,
    detail: `v${nodeVer}`,
    fix: nodeOk ? "" : "升级 Node.js ≥ 22.13 后重跑（pdfjs-dist 6 的硬要求）",
  })
  // 样张为代码内置构造，失败属代码缺陷直接抛；pdfjs 包目录解析失败留给冒烟项给修复指引
  const pdfB64 = buildMinimalPdf().toString("base64")
  let pdfjsDir = ""
  try {
    pdfjsDir = path.dirname(req.resolve("pdfjs-dist/package.json"))
  } catch {
    pdfjsDir = ""
  }
  for (const item of SMOKE_ITEMS) rows.push(smokeOne(req, item, pdfB64, pdfjsDir))
  for (const r of rows) {
    console.log(`  ${r.ok ? "✓" : "✗"} ${r.name}｜${r.detail}${r.ok ? "" : `\n      处置：${r.fix}`}`)
  }
  const bad = rows.filter(r => !r.ok)
  if (bad.length) console.log(`[review] doctor 结论：${bad.length} 项异常，按处置修复后重跑本命令复查`)
  else console.log("[review] doctor 结论：全部健康，各子命令可用")
  return { allOk: bad.length === 0, rows }
}
