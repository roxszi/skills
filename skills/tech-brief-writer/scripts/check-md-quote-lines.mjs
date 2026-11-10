// 检查 md 引用块内"下一行会被吞并"的行：当前行是引用内容行、行尾无两个空格、下一行也是引用内容行 → 渲染时两行并一行
// 空引用行（trim 后为 ">"）渲染为分段：作当前行吞不了下一行、作下一行不会被吞，两侧均排除；
// 下一行为列表项（> - item / > 1. item）时列表中断段落不并排，同样排除（启发式规则，极少数有序列表续行场景可能漏报）
// 用法：node check-md-quote-lines.mjs <md文件1> <md文件2> ...
import fs from "fs"

const files = process.argv.slice(2)
if (files.length === 0) {
  console.error("用法: node check-md-quote-lines.mjs <md文件...>")
  process.exit(1)
}

let totalBad = 0
for (const f of files) {
  const lines = fs.readFileSync(f, "utf8").split(/\r?\n/)
  let bad = 0
  for (let i = 0; i < lines.length - 1; i++) {
    const cur = lines[i]
    const next = lines[i + 1]
    // 空引用行（trim 后为 ">"）= 引用块内分段，当前行不会吞并下一行
    const curIsBlankQuote = cur.trim() === ">"
    const curIsQuote = (cur.startsWith("> ") || cur === ">") && !curIsBlankQuote
    // 空引用行渲染为分段，不算内容行；列表项行中断段落，不会与前一行并为一行
    const nextIsQuote = next.startsWith("> ") && next.trim() !== ">" && !/^>\s*(?:[-*+]|\d+[.)])\s/.test(next)
    // 行尾已有两个空格（硬换行）→ 不会吞行
    if (curIsQuote && nextIsQuote && !cur.endsWith("  ")) bad++
  }
  console.log(`${f.split(/[\\/]/).pop()} -> 会吞并下一行的引用行: ${bad}`)
  totalBad += bad
}
console.log(`合计: ${totalBad}`)
