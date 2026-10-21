// schema.mjs — papers_meta.json 与 summaries/*.json 的校验契约（唯一正本）
// 设计思路：与 SKILL.md、references\条目字段契约.md 双向同步——改一处即改三处。
// 契约分两层：error（拦截交付，缺失/非法）与 warning（提示人工复核，超长/越界）。
// 领域扩展字段（system_zh / spec_evidence_zh / performance_metrics / validation_zh）
// 按化学／光谱领域定制；其他领域可按同一模式增删，须与本文件 REQUIRED/LIMITS 双向同步。

/** 阅读深度四态（与宿主精读技能词汇对齐；机器枚举，对用户转述一律用中文含义） */
export const READ_STATUSES = ["full_read", "partial_read", "abstract_only", "missing"]

/** papers_meta.json 单篇字段 */
const META_REQUIRED = ["id", "title"]
const META_OPTIONAL = [
  "title_zh", "authors", "doi", "pmid", "pmcid", "kind", "kind_zh",
  "journal", "year", "notes", "manual_urls", "download_overrides", "read_depth",
]

/** summaries 单篇字段全集（超出全集的字段不校验长度，允许携带，但素材包不保证收录） */
const SUMMARY_REQUIRED = [
  "id", "title_en", "title_zh", "journal", "year", "read_status",
  "background_zh", "question_zh", "method_zh", "results_zh",
  "innovation_zh", "limitation_zh", "tags", "reviewed_at",
]

/** 内容字段长度上限（error 级只拦必填缺失；超长为 warning，先删水话再落盘，不改上限迁就内容） */
const SUMMARY_LIMITS = {
  background_zh: 300,
  question_zh: 200,
  method_zh: 600,
  results_zh: 600,
  innovation_zh: 300,
  limitation_zh: 300,
  system_zh: 200,
  spec_evidence_zh: 400,
  validation_zh: 200,
}

/** 校验 papers_meta.json，返回 { errors, warnings } */
export function validateMeta(data) {
  const errors = []
  const warnings = []
  if (!data || typeof data !== "object" || !Array.isArray(data.papers)) {
    return { errors: ["papers_meta.json 必须是对象且含 papers 数组"], warnings }
  }
  if (!data.papers.length) errors.push("papers 数组为空")
  const seen = new Set()
  data.papers.forEach((p, idx) => {
    const where = `papers[${idx}]`
    if (!p || typeof p !== "object") {
      errors.push(`${where} 不是对象`)
      return
    }
    const pid = p.id
    if (pid === undefined || pid === null || String(pid).trim() === "") {
      errors.push(`${where} 缺少 id`)
    } else if (seen.has(String(pid))) {
      errors.push(`${where} id=${pid} 重复`)
    } else {
      seen.add(String(pid))
    }
    for (const key of META_REQUIRED) {
      const v = p[key]
      if (v === undefined || v === null || (typeof v === "string" && !v.trim())) {
        errors.push(`${where} 缺少必填字段 ${key}`)
      }
    }
    if (p.year !== undefined && p.year !== null && !Number.isInteger(p.year)) {
      errors.push(`${where} year 应为整数，当前为 ${JSON.stringify(p.year)}`)
    }
    if (p.read_depth !== undefined && p.read_depth !== null &&
        !["brief", "targeted", "full"].includes(p.read_depth)) {
      errors.push(`${where} read_depth 非法：应为 brief/targeted/full`)
    }
    for (const key of ["manual_urls", "download_overrides"]) {
      const v = p[key]
      if (v === undefined || v === null) continue
      if (!Array.isArray(v)) {
        errors.push(`${where} ${key} 应为数组`)
        continue
      }
      v.forEach((item, i) => {
        const ok = typeof item === "string" && item.trim() !== ""
        const okObj = item && typeof item === "object" && typeof item.url === "string" && item.url.trim() !== ""
        if (!ok && !okObj) errors.push(`${where} ${key}[${i}] 非法：需字符串或 {url, referer}`)
      })
    }
  })
  return { errors, warnings }
}

/** 校验单篇 summary，返回 { errors, warnings } */
export function validateSummary(s) {
  const errors = []
  const warnings = []
  if (!s || typeof s !== "object") return { errors: ["summary 不是对象"], warnings }
  for (const key of SUMMARY_REQUIRED) {
    const v = s[key]
    const empty = v === undefined || v === null || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && !v.length)
    if (empty) errors.push(`缺少字段 ${key}`)
  }
  const status = s.read_status
  if (status !== undefined && !READ_STATUSES.includes(status)) {
    errors.push(`read_status 非法：${JSON.stringify(status)}，允许值 ${READ_STATUSES.join(" / ")}`)
  }
  if (status === "full_read" || status === "partial_read") {
    for (const field of ["evidence_pages", "evidence_figs"]) {
      const v = s[field]
      if (!Array.isArray(v) || !v.length) {
        errors.push(`${field} 缺失：已读全文或部分章节的论文必须给出证据链`)
      }
    }
  }
  if (s.year !== undefined && s.year !== null && !Number.isInteger(s.year)) {
    errors.push(`year 应为整数`)
  } else if (Number.isInteger(s.year) && (s.year < 1900 || s.year > 2100)) {
    errors.push(`year 越界（1900–2100）`)
  }
  if (errors.length) return { errors, warnings }
  // 内容长度（warning 级）
  for (const [key, limit] of Object.entries(SUMMARY_LIMITS)) {
    const v = s[key]
    if (typeof v === "string" && v.length > limit) warnings.push(`${key} 超长 ${v.length}/${limit}`)
  }
  if (Array.isArray(s.tags)) {
    if (s.tags.length < 3 || s.tags.length > 8) warnings.push(`tags 应为 3–8 个（当前 ${s.tags.length}）`)
    if (s.tags.some(t => !String(t).trim())) warnings.push(`tags 含空元素`)
  }
  if (s.performance_metrics !== undefined && s.performance_metrics !== null) {
    if (!Array.isArray(s.performance_metrics)) {
      errors.push(`performance_metrics 应为数组`)
    } else {
      s.performance_metrics.forEach((m, i) => {
        if (!m || typeof m !== "object" || !String(m.label ?? "").trim() || !String(m.value ?? "").trim()) {
          errors.push(`performance_metrics[${i}] 需非空 {label, value}`)
        }
      })
      if (s.performance_metrics.length > 5) warnings.push(`performance_metrics 超过 5 条（当前 ${s.performance_metrics.length}）`)
    }
  }
  if (s.reviewed_at && typeof s.reviewed_at === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(s.reviewed_at)) {
    warnings.push(`reviewed_at 应为 YYYY-MM-DD`)
  }
  return { errors, warnings }
}
