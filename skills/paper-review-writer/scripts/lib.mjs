// lib.mjs — 共享 IO 与通用工具（零外部依赖）
// 设计思路：所有子命令共享同一套项目路径解析与 JSON 读写；路径一律由 --project 显式指定
// （缺省为当前工作目录），脚本不依赖进程 cwd 的隐式状态，方便子会话在任何目录调用。

import fs from "node:fs"
import path from "node:path"

/** 项目内固定子目录名（流水线各阶段产物落点，SKILL.md 与本表双向同步） */
export const DIRS = {
  papers: "papers",
  txt: "papers_txt",
  digests: "digests",
  summaries: "summaries",
  deliverables: "deliverables",
}

/** 解析项目根目录：--project 优先，缺省当前目录；返回绝对路径 */
export function projectRoot(args) {
  const p = args.project || "."
  return path.resolve(p)
}

/** 项目内路径拼接（不创建目录） */
export function pPath(root, ...seg) {
  return path.join(root, ...seg)
}

/** 确保目录存在（递归） */
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 读 JSON；文件不存在或解析失败返回 default（调用方决定是否视为致命）；自动剝 UTF-8 BOM */
export function readJson(file, defaultValue = null) {
  try {
    const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "") // Windows PowerShell 5.1 Out-File utf8 带 BOM，不剝则 JSON.parse 炸
    return JSON.parse(raw)
  } catch (e) {
    if (e.code === "ENOENT") return defaultValue
    throw new Error(`JSON 解析失败 ${file}: ${e.message}`)
  }
}

/** 写 JSON（utf8 无 BOM，两空格缩进 + 尾换行；先确保父目录存在） */
export function writeJson(file, data) {
  ensureDir(path.dirname(file))
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8")
  return file
}

/** 读文本文件；不存在返回 null */
export function readText(file) {
  try {
    return fs.readFileSync(file, "utf8")
  } catch (e) {
    if (e.code === "ENOENT") return null
    throw e
  }
}

/** 写文本文件（utf8 无 BOM；先确保父目录存在） */
export function writeText(file, text) {
  ensureDir(path.dirname(file))
  fs.writeFileSync(file, text, "utf8")
  return file
}

/** 压缩空白为一格并去首尾（digest 与素材包的字段裁剪基础） */
export function clean(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim()
}

/** 裁剪到 n 字符，超长以省略号收尾（长度契约的执行器） */
export function clip(s, n) {
  const t = clean(s)
  if (t.length <= n) return t
  return t.slice(0, n).replace(/[\s,.;:，。；]+$/, "") + "…"
}

/** 论文 id → 文件名安全短串（DOI 尾段或题名），小写短横线 */
export function slugify(text, maxLen = 48) {
  const s = String(text ?? "").replace(/[^0-9A-Za-z]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase()
  return s.slice(0, maxLen) || "paper"
}

/** 读取并校验 papers_meta.json；失败直接抛错终止流水线 */
export function loadMeta(root, schema) {
  const file = pPath(root, "papers_meta.json")
  const meta = readJson(file)
  if (!meta) throw new Error(`papers_meta.json 不存在：${file}（先建清单，见 SKILL.md 第 2 节）`)
  const errors = schema.validateMeta(meta)
  if (errors.length) throw new Error("papers_meta.json 校验失败：\n  - " + errors.join("\n  - "))
  return meta
}

/** 简单并发池：按上限并发执行异步任务集合（下载器用；保持结果与输入同序） */
export async function pool(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  async function runner() {
    while (next < items.length) {
      const i = next++
      results[i] = await worker(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner))
  return results
}

/** 带超时的 fetch（Node 内置 fetch 无默认总超时，网络层统一包一层） */
export async function fetchWithTimeout(url, options = {}, timeoutMs = 45000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new Error(`超时 ${timeoutMs}ms`)), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** 打印阶段头（流水线日志格式统一） */
export function log(msg) {
  console.log(`[review] ${msg}`)
}
