// sources.mjs — 网络层：元数据核验（verify）与合规下载（download）与 EPMC XML 降级
// 设计思路：核验链 Crossref→OpenAlex→Semantic Scholar→Europe PMC→Unpaywall 逐源回填，防题录
// 张冠李戴；下载链 manual_urls→S2 机构库副本→EPMC render→PMC→出版商直链→OpenAlex OA→EPMC
// 全文，全部为 OA／已授权渠道；第三方转载渠道（Sci-Hub 类）默认关闭，仅命令行显式授权才尝试。
// 网络层假设与 API 契约（教育网 2026-10-26 实跑复盘沉淀）统一记录在 references/external-api-notes.md，
// 改网络相关代码前先读该表；verify 产物带清单指纹，下游命令读核验产物前必须过 assertFreshVerify。

import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { ensureDir, fetchWithTimeout, log, pool, pPath, readJson, slugify, writeJson } from "./lib.mjs"

const SCI_HUB_MIRRORS = ["https://sci-hub.se/", "https://sci-hub.st/", "https://sci-hub.ru/"]

/** ③档白名单已知渠道映射（新增渠道须同步 SKILL.md §2 与 acquisition-playbook §4） */
const TIER3_CHANNEL_MIRRORS = { "sci-hub": SCI_HUB_MIRRORS }

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"

/** 读取 project.json（全可选；缺省值在此集中） */
export function loadProject(root) {
  const cfg = readJson(pPath(root, "project.json")) || {}
  return {
    mailto: cfg?.apis?.mailto || "researcher@example.com",
    // OpenAlex API key（可选）：无 key 免费预算按网络出口 IP 全网共享（教育网整校一池），带 key 日预算约 ×10
    openalexKey: cfg?.apis?.openalex_key || "",
    workers: cfg?.download?.workers ?? 4,
    maxMb: cfg?.download?.max_mb ?? 60,
    timeoutMs: (cfg?.download?.timeout ?? 45) * 1000,
    allowThirdParty: cfg?.compliance?.allow_third_party === true,
    // ③档白名单：项目所有者显式写入即视为持久授权，命中已知渠道即自动尝试（SKILL.md §2）
    tier3: Array.isArray(cfg?.compliance?.tier3_allowlist) ? cfg.compliance.tier3_allowlist : [],
    // 交付自检豁免章节（check 用）：用户合法裁剪的章从必查表剔除，缺失不再报 FAIL
    optionalSections: Array.isArray(cfg?.report?.optional_sections) ? cfg.report.optional_sections : [],
  }
}

function apiHeaders(mailto) {
  return { "User-Agent": `paper-review-writer/0.1 (mailto:${mailto})`, Accept: "application/json" }
}

/** 剥 HTML 标签与多余空白为纯文本（EPMC/Crossref 摘要回填用） */
function stripHtml(s) {
  return String(s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
}

async function getJson(url, cfg, params) {
  const u = new URL(url)
  if (params) for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue // 可选参数（如未配 api_key）不产生空值查询
    u.searchParams.set(k, String(v))
  }
  const r = await fetchWithTimeout(u, { headers: apiHeaders(cfg.mailto) }, Math.min(cfg.timeoutMs, 30000))
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

/* ---------- 元数据核验 ---------- */

/** DOI 归一化：去协议前缀、去空白、转小写（清单与产物/条目间的 DOI 比对统一走此函数） */
export function normalizeDoi(doi) {
  return String(doi || "").trim().toLowerCase().replace(/^https?:\/\/doi\.org\//, "")
}

/** 清单指纹：id+title+doi 稳定序列化的 16 位短哈希。verify 写入产物顶部，下游命令读核验产物前
 *  与当前清单重算比对——清单在 verify 后被增删/改号时立即报错，杜绝「同 id 不同 DOI」的静默错位
 *  （2026-10-26 教育网实跑暴露：117→106 修剪改号后 113/117 条错位，save/validate/check 全绿但引用张冠李戴）。 */
export function metaFingerprint(papers) {
  const canon = JSON.stringify((papers || []).map(p => [String(p?.id ?? ""), String(p?.title ?? ""), String(p?.doi ?? "")]))
  return createHash("sha256").update(canon).digest("hex").slice(0, 16)
}

/** 核验产物新鲜度守护：papers_meta.verified.json 必须与当前 papers_meta.json 同源，错位即抛错。
 *  新产物（≥0.6.0）带 meta_fingerprint 直接比对；旧产物退化为逐篇比对 DOI 与题名前缀。
 *  download / extract / init-summaries / map / dispatch / figures 读核验产物前都必须过这道闸。 */
export function assertFreshVerify(root) {
  const verified = readJson(pPath(root, "papers_meta.verified.json"))
  if (!verified?.papers) return verified
  const meta = readJson(pPath(root, "papers_meta.json"))
  if (!meta?.papers) return verified
  if (verified.meta_fingerprint) {
    if (verified.meta_fingerprint !== metaFingerprint(meta.papers)) {
      throw new Error("papers_meta.verified.json 与当前 papers_meta.json 不一致（清单在 verify 后被增删/改号/改题名）：重跑 verify，再按新清单重跑 extract 与 digest，已派读条目按编号复核")
    }
    return verified
  }
  const vMap = new Map(verified.papers.map(p => [String(p.id), p]))
  for (const p of meta.papers) {
    const v = vMap.get(String(p.id))
    if (!v) throw new Error(`papers_meta.verified.json 缺当前清单编号 ${p.id}（清单在 verify 后被改动）：重跑 verify 后再继续`)
    if (p.doi && v.doi && normalizeDoi(p.doi) !== normalizeDoi(v.doi)) {
      throw new Error(`编号 ${p.id} 的 DOI 在清单与核验产物中不一致（${p.doi} ≠ ${v.doi}）：核验产物已过期，重跑 verify`)
    }
    const t1 = String(p.title || "").trim().toLowerCase().slice(0, 80)
    const t2 = String(v.title || "").trim().toLowerCase().slice(0, 80)
    if (t1 && t2 && t1 !== t2) throw new Error(`编号 ${p.id} 的题名在清单与核验产物中不一致：核验产物已过期，重跑 verify`)
  }
  return verified
}

/** Crossref：DOI → 题名/期刊/年份/作者。契约注意：/works/{doi} 本端点不支持 select 参数
 *  （任何组合都 400 parameter-not-allowed，2026-10-26 实测），取完整记录即可，勿「优化」成 select。 */
async function crossrefDoi(doi, cfg) {
  const m = (await getJson(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, cfg)).message
  const year = pickYear(m)
  return {
    title: (m.title || [""])[0],
    journal: (m["container-title"] || [""])[0],
    year,
    authors: (m.author || []).slice(0, 12).map(a => `${a.given || ""} ${a.family || ""}`.trim()).join("; "),
    abstract: stripHtml(m.abstract),
    // MDPI 存档域直链所需结构字段（publisherUrls 消费；卷号/文章号必须来自题录，不从 DOI 尾段硬拆）
    volume: m.volume || "",
    article_number: m["article-number"] || "",
    page: m.page || "",
    // 刊名缩写（如 IJMS）：MDPI 存档域目录名用缩写，container-title 全拼拼链恒 404（2026-10-26 实测 5 刊 short 小写去非字母 = 存档域名）
    short_container_title: (m["short-container-title"] || [])[0] || "",
  }
}

/** Crossref 各日期字段按优先级取年份（旧版 year=None 的修复） */
function pickYear(m) {
  for (const key of ["published-print", "published-online", "published", "issued", "created"]) {
    const parts = (m[key] || {})["date-parts"] || []
    if (parts[0] && parts[0][0]) return Number.parseInt(parts[0][0], 10) || null
  }
  return null
}

// abstract_inverted_index 一并取回：OpenAlex 摘要覆盖与 EPMC 互补（教育网实测 117 篇中 66 vs 72，并集 99）
const OA_SELECT = "id,doi,title,display_name,publication_year,cited_by_count,open_access,best_oa_location,primary_location,abstract_inverted_index"

/** OpenAlex 倒排索引 → 摘要文本（word → 出现位置数组，按位置重排拼接） */
export function invertedToAbstract(inv) {
  if (!inv || typeof inv !== "object") return ""
  const pairs = []
  for (const [word, positions] of Object.entries(inv)) {
    if (!Array.isArray(positions)) continue
    for (const pos of positions) pairs.push([pos, word])
  }
  pairs.sort((a, b) => a[0] - b[0])
  return pairs.map(([, w]) => w).join(" ")
}

/** OpenAlex 批量 OR 过滤串：单 filter 内 | 至多 100 值（官方限制），调用方按 50/批分块留余量 */
export function openalexBatchFilter(dois) {
  return "doi:" + dois.map(normalizeDoi).map(d => "https://doi.org/" + d).join("|")
}

/** OpenAlex：DOI → 题录 + OA 链接 + 被引 + 摘要 */
async function openalexDoi(doi, cfg) {
  const w = await getJson(`https://api.openalex.org/works/https://doi.org/${encodeURIComponent(doi)}`, cfg, { mailto: cfg.mailto, select: OA_SELECT, api_key: cfg.openalexKey || undefined })
  return openalexRow(w)
}

/** OpenAlex：题名搜索 → 命中列表（补 DOI 用） */
async function openalexByTitle(title, cfg) {
  const d = await getJson("https://api.openalex.org/works", cfg, {
    search: title, "per-page": 5, sort: "cited_by_count:desc", mailto: cfg.mailto, select: OA_SELECT, api_key: cfg.openalexKey || undefined,
  })
  return (d.results || []).map(openalexRow)
}

/** OpenAlex 批量 OR 补拉：教育网共享免费预算下单条路径大面积 429/504 时的降级路径（一批 ≤50 DOI） */
async function openalexBatch(dois, cfg) {
  const rows = []
  for (let i = 0; i < dois.length; i += 50) {
    const chunk = dois.slice(i, i + 50)
    const d = await getJson("https://api.openalex.org/works", cfg, {
      filter: openalexBatchFilter(chunk), "per-page": 100, mailto: cfg.mailto, select: OA_SELECT, api_key: cfg.openalexKey || undefined,
    })
    rows.push(...(d.results || []))
    if (i + 50 < dois.length) await new Promise(r => setTimeout(r, 300))
  }
  return rows
}

function openalexRow(w) {
  const loc = w.best_oa_location || {}
  const source = (w.primary_location || {}).source || {}
  return {
    doi: String(w.doi || "").replace("https://doi.org/", ""),
    title: w.title || w.display_name || "",
    journal: source.display_name || "",
    year: w.publication_year || null,
    citations: w.cited_by_count,
    is_oa: (w.open_access || {}).is_oa,
    oa_status: (w.open_access || {}).oa_status,
    oa_pdf: loc.pdf_url || "",
    oa_landing: loc.landing_page_url || "",
    abstract: invertedToAbstract(w.abstract_inverted_index),
  }
}

/** Semantic Scholar：DOI → 题录 + openAccessPdf。S2 的机构库副本是 closed 文献合法开放版本的唯一
 *  系统来源（多为作者接受稿，页码与出版版可能不符，按 EPMC XML 无页码源口径处理）；公开配额对单 IP
 *  极紧，429 即会话级熔断——本轮剩余篇目直接跳过不空烧，下次 verify 新进程自动重试。 */
let s2Disabled = false
async function s2Doi(doi, cfg) {
  if (s2Disabled) return null
  try {
    const d = await getJson(`https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(doi)}`, cfg, { fields: "title,isOpenAccess,openAccessPdf" })
    return { title: d.title || "", is_oa: !!d.isOpenAccess, oa_pdf: d?.openAccessPdf?.url || "" }
  } catch (e) {
    if (/\b429\b/.test(String(e.message))) {
      s2Disabled = true
      log("  [s2] HTTP 429（IP 级限流），本轮停用 Semantic Scholar，下次运行自动重试")
      return null
    }
    throw e
  }
}

/** Europe PMC：pmcid/pmid → 题录 + 全文链接集 */
async function epmcById(pmcid, pmid, cfg) {
  if (!pmcid && !pmid) return null
  const q = pmcid ? `PMCID:${pmcid}` : `EXT_ID:${pmid}`
  const d = await getJson("https://www.ebi.ac.uk/europepmc/webservices/rest/search", cfg, { query: q, format: "json", resultType: "core" })
  const r = (d.resultList || {}).result?.[0]
  if (!r) return null
  const jinfo = (r.journalInfo || {}).journal || {}
  return {
    title: r.title, journal: jinfo.title || "", year: r.pubYear ? Number.parseInt(r.pubYear, 10) : null,
    doi: r.doi, pmid: r.pmid, pmcid: r.pmcid,
    abstract: stripHtml(r.abstractText),
    fulltexts: ((r.fullTextUrlList || {}).fullTextUrl || []).map(u => u.url),
  }
}

/** Unpaywall：DOI → OA 状态与最佳 PDF 链接（email 必填参数） */
async function unpaywallDoi(doi, cfg) {
  const d = await getJson(`https://api.unpaywall.org/v2/${encodeURIComponent(doi)}`, cfg, { email: cfg.mailto })
  const loc = d.best_oa_location || {}
  return { is_oa: d.is_oa, oa_status: d.oa_status, pdf_url: loc.url_for_pdf, landing: loc.url, version: loc.version }
}

/** 用源数据回填目标条目的空字段（已有值不覆盖） */
function fillFrom(target, source, map) {
  if (!source) return
  for (const [dst, src] of Object.entries(map)) {
    const v = source[src]
    if (v !== undefined && v !== null && v !== "" && (target[dst] === undefined || target[dst] === null || target[dst] === "")) {
      target[dst] = v
    }
  }
}

/** verify 子命令：逐篇核验并输出 papers_meta.verified.json */
export async function cmdVerify(root, args) {
  const cfg = loadProject(root)
  const metaPath = pPath(root, "papers_meta.json")
  const meta = readJson(metaPath)
  if (!meta || !Array.isArray(meta.papers)) throw new Error("papers_meta.json 不存在或格式错误")
  const out = { title: meta.title || "", range: meta.range || "", meta_fingerprint: metaFingerprint(meta.papers), papers: [] }
  let nDoi = 0
  let openalexDegraded = false // 429/504 即置位：教育网整校共享免费预算，单条路径继续烧只会更多失败，收尾改批量补拉
  const pendingBatch = [] // 降级期间跳过/失败的 {id, doi}，收尾批量补拉
  for (const p of meta.papers) {
    const pid = p.id
    log(`核验 [${pid}] ${String(p.title || "").slice(0, 60)}`)
    const v = { ...p, verified: {} }
    try {
      if (p.doi) {
        const cr = await crossrefDoi(p.doi, cfg)
        v.verified.crossref = cr
        fillFrom(v, cr, { journal: "journal", authors: "authors", year: "year" })
      }
    } catch (e) { log(`  [crossref] ${e.message}`) }
    if (p.doi && openalexDegraded) pendingBatch.push({ id: pid, doi: p.doi })
    try {
      if (p.doi && !openalexDegraded) {
        const row = await openalexDoi(p.doi, cfg)
        v.verified.openalex = row
        fillFrom(v, row, { journal: "journal", year: "year" })
      }
    } catch (e) {
      log(`  [openalex-doi] ${e.message}`)
      if (/HTTP (429|504)/.test(e.message)) {
        openalexDegraded = true
        pendingBatch.push({ id: pid, doi: p.doi })
        log("  [openalex] 预算受限（429/504），后续篇目转批量补拉模式")
      }
    }
    try {
      if (v.doi) {
        const s2 = await s2Doi(v.doi, cfg)
        if (s2 && (s2.oa_pdf || s2.title)) v.verified.s2 = s2
      }
    } catch (e) { log(`  [s2] ${e.message}`) }
    try {
      if (!v.doi) {
        // 无 DOI：OpenAlex 题名搜索补 DOI（前 80 字符精确匹配才算命中，避免张冠李戴）
        for (const r of await openalexByTitle(p.title, cfg)) {
          if (r.doi && r.title && r.title.trim().toLowerCase().slice(0, 80) === String(p.title).trim().toLowerCase().slice(0, 80)) {
            v.doi = r.doi
            v.verified.openalex_title_lookup = r
            fillFrom(v, r, { journal: "journal", year: "year" })
            break
          }
        }
      }
    } catch { /* 题名补查失败不阻塞 */ }
    try {
      const ep = await epmcById(p.pmcid, p.pmid, cfg)
      if (ep) {
        v.verified.europepmc = ep
        fillFrom(v, ep, { journal: "journal", year: "year", doi: "doi", pmid: "pmid", pmcid: "pmcid" })
      }
    } catch (e) { log(`  [europepmc] ${e.message}`) }
    try {
      if (v.doi) v.verified.unpaywall = await unpaywallDoi(v.doi, cfg)
    } catch (e) { log(`  [unpaywall] ${e.message}`) }
    if (v.doi) nDoi++
    out.papers.push(v)
    await new Promise(r => setTimeout(r, 300)) // 礼貌间隔，尊重公共 API
  }
  // 批量补拉：单条路径被预算拒掉的篇目按批 OR 查询一次取回（2026-10-26 实测 filter=doi:a|b 命中正确）
  if (pendingBatch.length) {
    const byDoi = new Map(pendingBatch.filter(x => x.doi).map(x => [normalizeDoi(x.doi), x]))
    let done = 0
    try {
      for (const w of await openalexBatch([...byDoi.keys()], cfg)) {
        const x = byDoi.get(normalizeDoi(w.doi))
        if (!x) continue
        const v = out.papers.find(t => String(t.id) === String(x.id))
        if (v && !v.verified.openalex) {
          const row = openalexRow(w)
          v.verified.openalex = row
          fillFrom(v, row, { journal: "journal", year: "year" })
          done++
        }
      }
    } catch (e) { log(`  [openalex-batch] 批量补拉失败（不阻塞核验产物落盘）：${e.message}`) }
    if (done) log(`[openalex] 批量补拉成功 ${done}/${byDoi.size} 篇`)
  }
  const outPath = writeJson(pPath(root, "papers_meta.verified.json"), out)
  log(`DONE：${nDoi}/${out.papers.length} 篇有 DOI → ${path.basename(outPath)}（含清单指纹；清单增删/改号后须重跑 verify）`)
}

/* ---------- 合规下载 ---------- */

/** 出版商直链 pattern 表（OA/订阅页直取；403 常见，仅作候选之一）。端点规则的实测依据与新增流程
 *  见 references/external-api-notes.md §B——先实测再进表进代码。crMeta = verify 产物中的 Crossref
 *  题录（MDPI 存档域直链需要卷号/文章号，DOI 尾段不可硬拆：coatings8110394 是卷 8 文章 0394 非「卷 81」）。 */
export function publisherUrls(doi, crMeta) {
  const urls = []
  if (!doi) return urls
  const tail = doi.split("/")[1]
  if (doi.startsWith("10.1038/")) urls.push(`https://www.nature.com/articles/${tail}.pdf`)
  if (doi.startsWith("10.1007/")) {
    urls.push(`https://link.springer.com/content/pdf/${doi}.pdf`) // 2026-10-26 实测直连 200
    urls.push(`https://link.springer.com/article/${doi}.pdf`)
  }
  if (doi.startsWith("10.3389/")) urls.push(`https://www.frontiersin.org/articles/${doi}/pdf`) // 2026-10-26 实测 200
  if (doi.startsWith("10.3390/")) {
    // MDPI：主站对脚本 UA 常见 403（浏览器可读，浏览器路线净增益）；存档域直链按 Crossref 卷号/文章号拼，缺题录结构字段时放弃（不猜）
    // 刊名优先取 short_container_title：存档域目录用缩写（ijms-24-08490），container-title 全拼拼链恒 404（Coatings 200 只是全拼=缩写巧合）
    const vol = String(crMeta?.volume || "").replace(/\D/g, "")
    const art = String(crMeta?.article_number || String(crMeta?.page || "").split(/[-–—]/).pop() || "").replace(/\D/g, "")
    const j = String(crMeta?.short_container_title || crMeta?.journal || "").toLowerCase().replace(/[^a-z]/g, "")
    if (vol && art && j) {
      const stem = `${j}-${vol.padStart(2, "0")}-${art.padStart(5, "0")}`
      urls.push(`https://mdpi-res.com/d_attachment/${j}/${stem}/article_deploy/${stem}.pdf`)
    }
  }
  if (doi.startsWith("10.1002/")) {
    urls.push(`https://onlinelibrary.wiley.com/doi/pdfdirect/${doi}`)
    urls.push(`https://onlinelibrary.wiley.com/doi/pdf/${doi}`)
  }
  if (doi.startsWith("10.1021/")) urls.push(`https://pubs.acs.org/doi/pdf/${doi}`)
  if (doi.startsWith("10.1039/")) urls.push(`https://pubs.rsc.org/en/content/articlepdf/${doi.replace("10.1039/", "")}`)
  if (doi.startsWith("10.1063/")) urls.push(`https://pubs.aip.org/aip/pof/article-pdf/doi/${doi}/${tail}.pdf`)
  // 10.1016（Elsevier）不进直链表：DOI 尾段不是 PII，旧实现的 sciencedirect 拼链从未成立过；且
  // ScienceDirect 对教育网校园 IP 段整段封禁（CPE00001 拒绝页，放行无用，换网络出口是第一处置）
  // —— 2026-10-26 实测，处置详见 external-api-notes §B 与 acquisition-playbook §5/§7
  return urls
}

/** manual_urls / download_overrides 统一展开为 [url, referer] 候选对 */
function manualCandidates(p) {
  const out = []
  for (const key of ["manual_urls", "download_overrides"]) {
    for (const item of p[key] || []) {
      if (typeof item === "string" && item.trim()) out.push([item, null])
      else if (item && typeof item === "object" && item.url) out.push([item.url, item.referer || null])
    }
  }
  return out
}

/** 单 URL 流式下载 + PDF 魔数校验 + 原子改名；失败返回 null（候选链继续） */
async function tryDownload(url, dest, cfg, referer) {
  const maxBytes = cfg.maxMb * 1_000_000
  const tmp = dest + ".part"
  try {
    const headers = {
      "User-Agent": BROWSER_UA,
      "Accept": "application/pdf,text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    }
    if (referer) headers.Referer = referer
    const r = await fetchWithTimeout(url, { headers, redirect: "follow" }, cfg.timeoutMs)
    if (!r.ok) return null
    const type = (r.headers.get("content-type") || "").toLowerCase()
    if (type.includes("text/html")) return null // 出版商把 landing 页当 PDF 返回 → 视为失败
    const buf = Buffer.from(await r.arrayBuffer())
    if (buf.length < 1000) return null
    if (buf.length > maxBytes) return null
    if (!buf.subarray(0, 5).toString("latin1").startsWith("%PDF")) return null
    fs.writeFileSync(tmp, buf)
    fs.renameSync(tmp, dest)
    return { url, bytes: buf.length }
  } catch {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) } catch { /* 清理失败不影响主流程 */ }
    return null
  }
}

/** 下载单篇：按候选链依次尝试，返回结果记录；tier3 = ③档白名单（自动），allowThirdParty = ④档临时授权 */
async function downloadOne(p, cfg, allowThirdParty, tier3Allowlist, papersDir) {
  const pid = String(p.id)
  const candidates = []
  for (const c of manualCandidates(p)) candidates.push({ url: c[0], referer: c[1], src: "manual" })
  const vmeta = p.verified || {}
  // S2 机构库副本排第二（仅次用户手给）：closed 文献的合法开放版本唯一系统来源，2026-10-26 实测可命中
  if (vmeta.s2?.oa_pdf) candidates.push({ url: vmeta.s2.oa_pdf, src: "s2-oa" })
  if (p.pmcid || vmeta.europepmc?.pmcid) {
    const pmcid = p.pmcid || vmeta.europepmc.pmcid
    candidates.push({ url: `https://europepmc.org/articles/${pmcid}?pdf=render`, src: "epmc-render" })
    candidates.push({ url: `https://www.ncbi.nlm.nih.gov/pmc/articles/${pmcid}/pdf/`, src: "pmc" })
  }
  for (const u of publisherUrls(vmeta.doi || p.doi, vmeta.crossref)) candidates.push({ url: u, src: "publisher" })
  if (vmeta.openalex?.oa_pdf) candidates.push({ url: vmeta.openalex.oa_pdf, src: "openalex-oa" })
  if (vmeta.unpaywall?.pdf_url) candidates.push({ url: vmeta.unpaywall.pdf_url, src: "unpaywall" })
  for (const u of vmeta.europepmc?.fulltexts || []) {
    if (String(u).toLowerCase().includes("pdf")) candidates.push({ url: u, src: "epmc-fulltext" })
  }
  const doi3 = vmeta.doi || p.doi
  if (doi3 && Array.isArray(tier3Allowlist)) {
    for (const name of tier3Allowlist) {
      const mirrors = TIER3_CHANNEL_MIRRORS[String(name).toLowerCase()]
      if (mirrors) for (const m of mirrors) candidates.push({ url: m + doi3, src: `tier3-${name}` })
    }
  }
  if (allowThirdParty && (vmeta.doi || p.doi)) {
    for (const m of SCI_HUB_MIRRORS) candidates.push({ url: m + (vmeta.doi || p.doi), src: "third-party" })
  }
  const dest = pPath(papersDir, `${pid}_${slugify(vmeta.doi || p.title)}.pdf`)
  for (const c of candidates) {
    const hit = await tryDownload(c.url, dest, cfg, c.referer)
    if (hit) return { id: pid, ok: true, file: path.basename(dest), source: c.src, url: c.url, bytes: hit.bytes, tried: candidates.length }
  }
  return { id: pid, ok: false, source: null, tried: candidates.length, candidates: candidates.map(c => c.src).join(",") }
}

/** download 子命令：并发下载全部（或 --id 指定单篇），输出 papers/results.json */
export async function cmdDownload(root, args) {
  const cfg = loadProject(root)
  const verified = assertFreshVerify(root)
  const meta = verified || readJson(pPath(root, "papers_meta.json"))
  if (!meta?.papers) throw new Error("缺 papers_meta.verified.json（先跑 verify）或 papers_meta.json")
  const allowThirdParty = cfg.allowThirdParty || args.allowThirdParty === true
  const papersDir = ensureDir(pPath(root, "papers"))
  const targets = args.id ? meta.papers.filter(p => String(p.id) === String(args.id)) : meta.papers
  if (!targets.length) throw new Error(`--id ${args.id} 无匹配论文`)
  log(`下载 ${targets.length} 篇（并发 ${cfg.workers}，③档白名单 ${cfg.tier3.length} 条，④档${allowThirdParty ? "已授权开启" : "关闭"}）`)
  const results = await pool(targets, cfg.workers, async p => {
    const r = await downloadOne(p, cfg, allowThirdParty, cfg.tier3, papersDir)
    log(`[${r.id}] ${r.ok ? `OK ${r.file}（${r.source}）` : `FAIL（已试 ${r.tried} 个候选）`}`)
    return r
  })
  const prev = readJson(pPath(papersDir, "results.json"), {})
  for (const r of results) prev[r.id] = r // 增量合并：重试不改写历史成功记录
  writeJson(pPath(papersDir, "results.json"), prev)
  const okN = results.filter(r => r.ok).length
  log(`DONE：${okN}/${results.length} 篇成功；失败篇走 extract 的 EPMC XML 降级或标 abstract_only`)
}

/* ---------- EPMC XML 全文降级 ---------- */

/** 取 Europe PMC fullTextXML 并剥标签为纯文本（PDF 拿不到时的全文降级源） */
export async function fetchEpmcXmlText(pmcid, cfg) {
  const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/${encodeURIComponent(pmcid)}/fullTextXML`
  // Accept 必须兼容 XML：该端点对 Accept: application/json 返回 406（2026-10-22 实测），不能复用 apiHeaders
  const r = await fetchWithTimeout(url, { headers: { "User-Agent": `paper-review-writer/0.1 (mailto:${cfg.mailto})`, Accept: "application/xml" } }, Math.min(cfg.timeoutMs, 30000))
  if (!r.ok) return null
  const xml = await r.text()
  if (!xml.trim()) return null
  // 剥标签：块级元素转段落换行，其余标签删除，实体还原
  const text = xml
    .replace(/<(title|p|sec|abstract|tr|td)[\s>]/gi, "\n<$1>")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#x?\w+;/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  return text.length > 500 ? text : null
}
