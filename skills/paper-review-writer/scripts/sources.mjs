// sources.mjs — 网络层：元数据核验（verify）与合规下载（download）与 EPMC XML 降级
// 设计思路：核验链 Crossref→OpenAlex→Europe PMC→Unpaywall 逐源回填，防题录张冠李戴；
// 下载链 manual_urls→EPMC render→PMC→出版商直链→OpenAlex OA→EPMC 全文，全部为 OA／已授权
// 渠道；第三方转载渠道（Sci-Hub 类）默认关闭，仅命令行显式授权才尝试。

import fs from "node:fs"
import path from "node:path"
import { ensureDir, fetchWithTimeout, log, pool, pPath, readJson, slugify, writeJson } from "./lib.mjs"

const SCI_HUB_MIRRORS = ["https://sci-hub.se/", "https://sci-hub.st/", "https://sci-hub.ru/"]

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"

/** 读取 project.json（全可选；缺省值在此集中） */
export function loadProject(root) {
  const cfg = readJson(pPath(root, "project.json")) || {}
  return {
    mailto: cfg?.apis?.mailto || "researcher@example.com",
    workers: cfg?.download?.workers ?? 4,
    maxMb: cfg?.download?.max_mb ?? 60,
    timeoutMs: (cfg?.download?.timeout ?? 45) * 1000,
    allowThirdParty: cfg?.compliance?.allow_third_party === true,
  }
}

function apiHeaders(mailto) {
  return { "User-Agent": `paper-review-writer/0.1 (mailto:${mailto})`, Accept: "application/json" }
}

async function getJson(url, cfg, params) {
  const u = new URL(url)
  if (params) for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v))
  const r = await fetchWithTimeout(u, { headers: apiHeaders(cfg.mailto) }, Math.min(cfg.timeoutMs, 30000))
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

/* ---------- 元数据核验 ---------- */

/** Crossref：DOI → 题名/期刊/年份/作者 */
async function crossrefDoi(doi, cfg) {
  const m = (await getJson(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, cfg)).message
  const year = pickYear(m)
  return {
    title: (m.title || [""])[0],
    journal: (m["container-title"] || [""])[0],
    year,
    authors: (m.author || []).slice(0, 12).map(a => `${a.given || ""} ${a.family || ""}`.trim()).join("; "),
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

const OA_SELECT = "id,doi,title,display_name,publication_year,cited_by_count,open_access,best_oa_location,primary_location"

/** OpenAlex：DOI → 题录 + OA 链接 + 被引 */
async function openalexDoi(doi, cfg) {
  const w = await getJson(`https://api.openalex.org/works/https://doi.org/${encodeURIComponent(doi)}`, cfg, { mailto: cfg.mailto, select: OA_SELECT })
  return openalexRow(w)
}

/** OpenAlex：题名搜索 → 命中列表（补 DOI 用） */
async function openalexByTitle(title, cfg) {
  const d = await getJson("https://api.openalex.org/works", cfg, {
    search: title, "per-page": 5, sort: "cited_by_count:desc", mailto: cfg.mailto, select: OA_SELECT,
  })
  return (d.results || []).map(openalexRow)
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
  const out = { title: meta.title || "", range: meta.range || "", papers: [] }
  let nDoi = 0
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
    try {
      if (p.doi) {
        const row = await openalexDoi(p.doi, cfg)
        v.verified.openalex = row
        fillFrom(v, row, { journal: "journal", year: "year" })
      }
    } catch (e) { log(`  [openalex-doi] ${e.message}`) }
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
  const outPath = writeJson(pPath(root, "papers_meta.verified.json"), out)
  log(`DONE：${nDoi}/${out.papers.length} 篇有 DOI → ${path.basename(outPath)}`)
}

/* ---------- 合规下载 ---------- */

/** 出版商直链 pattern 表（OA/订阅页直取；403 常见，仅作候选之一） */
function publisherUrls(doi) {
  const urls = []
  if (!doi) return urls
  const tail = doi.split("/")[1]
  if (doi.startsWith("10.1038/")) urls.push(`https://www.nature.com/articles/${tail}.pdf`)
  if (doi.startsWith("10.1007/")) urls.push(`https://link.springer.com/article/${doi}.pdf`)
  if (doi.startsWith("10.3389/")) urls.push(`https://www.frontiersin.org/articles/${doi}/pdf`)
  if (doi.startsWith("10.1002/")) {
    urls.push(`https://onlinelibrary.wiley.com/doi/pdfdirect/${doi}`)
    urls.push(`https://onlinelibrary.wiley.com/doi/pdf/${doi}`)
  }
  if (doi.startsWith("10.1021/")) urls.push(`https://pubs.acs.org/doi/pdf/${doi}`)
  if (doi.startsWith("10.1039/")) urls.push(`https://pubs.rsc.org/en/content/articlepdf/${doi.replace("10.1039/", "")}`)
  if (doi.startsWith("10.1063/")) urls.push(`https://pubs.aip.org/aip/pof/article-pdf/doi/${doi}/${tail}.pdf`)
  if (doi.startsWith("10.1016/")) urls.push(`https://www.sciencedirect.com/science/article/pii/${tail}`)
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

/** 下载单篇：按候选链依次尝试，返回结果记录 */
async function downloadOne(p, cfg, allowThirdParty, papersDir) {
  const pid = String(p.id)
  const candidates = []
  for (const c of manualCandidates(p)) candidates.push({ url: c[0], referer: c[1], src: "manual" })
  const vmeta = p.verified || {}
  if (p.pmcid || vmeta.europepmc?.pmcid) {
    const pmcid = p.pmcid || vmeta.europepmc.pmcid
    candidates.push({ url: `https://europepmc.org/articles/${pmcid}?pdf=render`, src: "epmc-render" })
    candidates.push({ url: `https://www.ncbi.nlm.nih.gov/pmc/articles/${pmcid}/pdf/`, src: "pmc" })
  }
  for (const u of publisherUrls(vmeta.doi || p.doi)) candidates.push({ url: u, src: "publisher" })
  if (vmeta.openalex?.oa_pdf) candidates.push({ url: vmeta.openalex.oa_pdf, src: "openalex-oa" })
  if (vmeta.unpaywall?.pdf_url) candidates.push({ url: vmeta.unpaywall.pdf_url, src: "unpaywall" })
  for (const u of vmeta.europepmc?.fulltexts || []) {
    if (String(u).toLowerCase().includes("pdf")) candidates.push({ url: u, src: "epmc-fulltext" })
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
  const verifiedPath = pPath(root, "papers_meta.verified.json")
  const verified = readJson(verifiedPath)
  const meta = verified || readJson(pPath(root, "papers_meta.json"))
  if (!meta?.papers) throw new Error("缺 papers_meta.verified.json（先跑 verify）或 papers_meta.json")
  const allowThirdParty = cfg.allowThirdParty || args.allowThirdParty === true
  const papersDir = ensureDir(pPath(root, "papers"))
  const targets = args.id ? meta.papers.filter(p => String(p.id) === String(args.id)) : meta.papers
  if (!targets.length) throw new Error(`--id ${args.id} 无匹配论文`)
  log(`下载 ${targets.length} 篇（并发 ${cfg.workers}，第三方渠道${allowThirdParty ? "已授权开启" : "关闭"}）`)
  const results = await pool(targets, cfg.workers, async p => {
    const r = await downloadOne(p, cfg, allowThirdParty, papersDir)
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
  const r = await fetchWithTimeout(url, { headers: apiHeaders(cfg.mailto) }, Math.min(cfg.timeoutMs, 30000))
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
