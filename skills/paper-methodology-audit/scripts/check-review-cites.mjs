#!/usr/bin/env node
/**
 * check-review-cites.mjs — 校验综述 Markdown 的引用编号是否都来自素材包。
 *
 * 设计思路：
 *   综述闭环的最后一道闸：综述中每个 [slug] 引用必须能在素材包中找到对应条目，
 *   防止"张冠李戴式引用归属错"（引用编号与文献事实错位）。剔除 markdown 链接
 *   与围栏代码块后再匹配，避免把 [text](url) 的链接文字、代码示例误判为引用。
 *
 * 退出码：0 = OK / WARN（无引用）；1 = FAIL（存在非法引用）。
 *
 * 用法：node check-review-cites.mjs <综述.md> <素材包.md>（bun 亦可，脚本零外部依赖）
 */
import { readFileSync } from "node:fs"

/** 素材包条目标题行：## [slug] 题名 —— 合法引用集的唯一来源 */
const HEAD_RE = /^## \[([A-Za-z0-9_-]+)\]/gm
/** 综述引用：[slug]；匹配前先剔除链接、代码块、行内代码 */
const CITE_RE = /\[([A-Za-z0-9_-]+)\]/g

/** 读取文件内容（去 BOM） */
function readText(path) {
  return readFileSync(path, "utf8").replace(/^\uFEFF/, "")
}

/** 剔除围栏代码块、行内代码、markdown 链接——这些位置的 [xx] 不是引用语义 */
function stripNonCite(text) {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/\[[^\]]*\]\([^)]*\)/g, " ")
}

function main() {
  const args = process.argv.slice(2)
  const [reviewPath, materialPath] = args.filter((a) => !a.startsWith("-"))
  if (!reviewPath || !materialPath) {
    console.error("用法：bun check-review-cites.mjs <综述.md> <素材包.md>")
    process.exit(2)
  }

  // 合法集来自素材包条目标题
  const valid = new Set()
  for (const m of readText(materialPath).matchAll(HEAD_RE)) valid.add(m[1])
  if (valid.size === 0) {
    console.error("FAIL 素材包中未发现任何条目标题（## [slug]），请确认传的是 gen-review-material.mjs 的产物")
    process.exit(1)
  }

  // 综述引用集合
  const reviewStripped = stripNonCite(readText(reviewPath))
  const cited = new Set()
  for (const m of reviewStripped.matchAll(CITE_RE)) cited.add(m[1])

  const invalid = [...cited].filter((c) => !valid.has(c)).sort()
  if (invalid.length > 0) {
    console.log(`FAIL 非法引用 ${invalid.length} 个：${invalid.join(", ")}（不在素材包中，回改综述或补条目）`)
    process.exit(1)
  }
  if (cited.size === 0) {
    console.log("WARN 综述中没有任何 [slug] 引用——综述须逐论断标注来源，补引用后重跑")
    process.exit(0)
  }
  console.log(`OK 引用 ${cited.size}/${valid.size} 篇全部合法`)
}

main()
