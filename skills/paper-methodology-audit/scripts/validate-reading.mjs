#!/usr/bin/env node
/**
 * validate-reading.mjs — 精读条目校验器（paper-methodology-audit skill 的证据强制执行者）。
 *
 * 设计思路：
 *   精读条目是长期资产，写错一处会污染未来所有综述。本脚本把 SKILL.md 第 3 节（read_status 与证据锚点）
 *   与 references\精读条目字段契约.md（字段与长度上限）固化为可执行校验：error 拦截交付（证据链缺失、必填缺失、
 *   枚举非法），warning 提示人工判断（超长、日期格式、slug 与文件名不一致）。
 *   退出码：0 = 无 error；1 = 有 error（流程中必须回改重跑）。
 *
 * 用法：node validate-reading.mjs <条目.json> [--quiet]（bun 亦可，脚本零外部依赖）
 *   --quiet  只输出单行 OK/FAIL 结果（供流程内调用）。
 */
import { readFileSync } from "node:fs"
import { basename } from "node:path"

// ---- 契约定义（与 references\精读条目字段契约.md 保持一致，改动须双向同步） ----

/** 必填字段：缺失或空白 → error */
const REQUIRED = [
  "slug", "title_en", "title_zh", "journal", "year", "read_status",
  "background_zh", "question_zh", "system_zh", "method_zh",
  "spec_evidence_zh", "results_zh", "innovation_zh", "limitation_zh",
  "insight_zh", "tags", "reviewed_at",
]

/** read_status 四态枚举：申报阅读深度，防止低档位冒充高档位（partial_read = L1-C 核心档 / 部分章节已读） */
const READ_STATUS = ["full_read", "partial_read", "abstract_only", "missing"]

/** 内容字段长度上限（中文字符数）：超限 → warning（不破坏事实完整性，人工删水话） */
const MAX_LEN = {
  background_zh: 300, question_zh: 200, system_zh: 200, method_zh: 600,
  spec_evidence_zh: 400, results_zh: 600, performance_zh: 300,
  innovation_zh: 300, limitation_zh: 300, insight_zh: 300, validation_zh: 200,
}

// ---- 工具函数 ----

/** 读文件并去掉可能的 UTF-8 BOM（PowerShell 写过的文件常带 BOM）；导出供 gen-review-material 复用 */
export function readJsonLoose(path) {
  const raw = readFileSync(path, "utf8").replace(/^\uFEFF/, "")
  return JSON.parse(raw)
}

/** 判断字段"实际为空"：null / undefined / 空白串 / 空数组 */
const isEmpty = (v) =>
  v == null || (typeof v === "string" && v.trim() === "") ||
  (Array.isArray(v) && v.length === 0)

// ---- 主校验 ----

/**
 * 校验单个精读条目。
 * @param {object} s 条目对象
 * @param {string} [fileName] 条目文件名（用于 slug 一致性检查，可缺省）
 * @returns {{errors: string[], warnings: string[]}}
 */
export function validateReading(s, fileName) {
  const errors = []
  const warnings = []
  if (typeof s !== "object" || s === null || Array.isArray(s)) {
    return { errors: ["条目不是 JSON 对象"], warnings }
  }

  // 1) 必填字段
  for (const key of REQUIRED) {
    if (isEmpty(s[key])) errors.push(`缺少必填字段 ${key}`)
  }
  if (errors.length > 0) return { errors, warnings } // 缺必填时不再往下，避免连锁误报

  // 2) read_status 枚举
  if (!READ_STATUS.includes(s.read_status)) {
    errors.push(`read_status 非法：${JSON.stringify(s.read_status)}，允许值 ${READ_STATUS.join(" | ")}`)
  }

  // 3) 证据强制：full_read / partial_read 必附证据清单（灵魂条款）
  if (s.read_status === "full_read" || s.read_status === "partial_read") {
    for (const field of ["evidence_pages", "evidence_figs"]) {
      const v = s[field]
      if (!Array.isArray(v) || v.length === 0) {
        errors.push(`${field} 缺失：${s.read_status} 条目必须给出证据链（页码 / 章节号 / 图表号），给不出请降级 abstract_only`)
      }
    }
  }

  // 4) 题录类型：year 整数、合理范围
  if (!Number.isInteger(s.year) || s.year < 1900 || s.year > 2100) {
    errors.push(`year 应为 1900–2100 整数，当前 ${JSON.stringify(s.year)}`)
  }

  // 5) 长度契约（超限 warning）
  for (const [key, limit] of Object.entries(MAX_LEN)) {
    const v = s[key]
    if (typeof v === "string" && v.length > limit) {
      warnings.push(`${key} 超长 ${v.length}/${limit}，先删水话再落盘`)
    }
  }

  // 6) tags：3–8 个字符串
  if (Array.isArray(s.tags)) {
    if (s.tags.length < 3 || s.tags.length > 8) {
      errors.push(`tags 应为 3–8 个，当前 ${s.tags.length} 个`)
    }
    if (s.tags.some((t) => typeof t !== "string" || t.trim() === "")) {
      errors.push("tags 存在非字符串或空白元素")
    }
  }

  // 7) performance_metrics：≤5 条，每条含非空 label + value
  if (s.performance_metrics != null) {
    const pm = s.performance_metrics
    if (!Array.isArray(pm)) {
      errors.push("performance_metrics 应为数组")
    } else {
      if (pm.length > 5) warnings.push(`performance_metrics 超过 5 条（当前 ${pm.length}），只保留最关键的`)
      for (const [i, m] of pm.entries()) {
        if (typeof m !== "object" || m === null || isEmpty(m.label) || isEmpty(m.value)) {
          errors.push(`performance_metrics[${i}] 须为含非空 label 与 value 的对象`)
        }
      }
    }
  }

  // 8) reviewed_at：非空已查；格式 YYYY-MM-DD 宽松校验
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s.reviewed_at))) {
    warnings.push(`reviewed_at 建议格式 YYYY-MM-DD，当前 ${JSON.stringify(s.reviewed_at)}`)
  }

  // 9) slug 与文件名一致性（文件名即双向锚点，不一致会让"条目↔库"互查断链）
  if (fileName) {
    const base = basename(fileName).replace(/\.json$/i, "")
    if (base !== s.slug) warnings.push(`slug(${s.slug}) 与文件名(${base}) 不一致，会断开条目↔库双向锚点`)
  }

  return { errors, warnings }
}

// ---- CLI 入口 ----

function main() {
  const args = process.argv.slice(2)
  const quiet = args.includes("--quiet")
  const file = args.find((a) => !a.startsWith("--"))
  if (!file) {
    console.error("用法：node validate-reading.mjs <条目.json> [--quiet]")
    process.exit(2)
  }

  let result
  try {
    result = validateReading(readJsonLoose(file), file)
  } catch (e) {
    // JSON 解析失败是最严重的结构错误，直接 FAIL
    if (quiet) { console.log(`FAIL ${file}: JSON 无法解析（${e.message}）`) }
    else { console.error(`JSON 无法解析：${e.message}`) }
    process.exit(1)
  }

  const { errors, warnings } = result
  if (quiet) {
    const w = warnings.length > 0 ? `（${warnings.length} warning）` : ""
    console.log(errors.length === 0 ? `OK ${file} ${w}`.trim() : `FAIL ${file}: ${errors.length} error — ${errors[0]}`)
  } else {
    for (const e of errors) console.error(`[error] ${e}`)
    for (const w of warnings) console.warn(`[warn] ${w}`)
    if (errors.length === 0 && warnings.length === 0) console.log("OK：0 error，0 warning")
    else if (errors.length === 0) console.log(`OK：0 error，${warnings.length} warning（逐条人工判断）`)
    else console.log(`FAIL：${errors.length} error，回改后重跑`)
  }
  process.exit(errors.length === 0 ? 0 : 1)
}

// 直接运行时进 CLI；被 import 时只导出 validateReading（供测试或批处理复用）
if (process.argv[1] && basename(process.argv[1]) === "validate-reading.mjs") {
  main()
}
