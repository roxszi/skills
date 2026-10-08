/**
 * local-kb 清洗脚本：把原始 markdown / HTML 里的噪音剥掉。
 *
 * 用法：
 *   bun run scripts/clean.ts <input.md> [output.md]            # 文件→文件
 *   bun run scripts/clean.ts --stdin                          # stdin→stdout
 *   bun run scripts/clean.ts --stdin --from-mcp               # stdin 是 mcp 工具的 JSON 包装
 *   cat raw.md | bun run scripts/clean.ts --stdin > clean.md
 *   bun run scripts/clean.ts raw.md clean.md --trim-head "A" --trim-tail "B"   # v1.6.0 锚点截断
 *
 * 处理内容（按顺序）：
 *   0. 锚点截断（--trim-head / --trim-tail，在启发式清洗之前执行）
 *   1. 剥 <script>/<style>/<noscript>/<head> 整块
 *   2. 剥 ACS / Wiley / Elsevier 风格的全局导航
 *   3. 删行内残留的 HTML 注释 / iframe / 表格 div
 *   4. 合并连续空行（>2 → 2）
 *   5. 去每行尾空白
 *
 * --from-mcp 模式：
 *   mcp__ZDFU4xWpwsM5bRm8LeFCZ__fetch_markdown 等工具返回的是
 *     [{ "type": "text", "text": "..." }, ...]
 *   格式的 JSON，所有内容字符都被转义（`[` → `\[`、`"` → `\"`）。
 *   不加 --from-mcp 时按纯 markdown 处理，正则全部失配 → 0% 清理。
 *
 * **警告**：本工具是"启发式清理"，**不是完整 HTML→MD 转换器**。
 * 复杂页面（论文补充材料、表格、图表）仍可能残留 HTML 标签和少量 inline JS。
 * 强烈建议清理后用 Read 工具人工扫一遍再入库。
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function cleanMarkdown(text: string): string {
  let s = text;

  // 1. 剥 <script>/<style>/<noscript>/<head> 整块（DOTALL，跨行）
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "");
  s = s.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, "");

  // 2. 剥出版商常见的导航/UI 块（按行匹配）
  const navPatterns: RegExp[] = [
    /^window\.[a-zA-Z_$]+\s*=.*$/gm,
    /^\s*\(\s*function\s*\(.*$/gm,
    /^\s*(var|let|const)\s+[a-zA-Z_$]+\s*=\s*\(?\s*function.*$/gm,
    /^\s*\.[a-zA-Z_-]+\s*\{[^}]*\}/gm,
    /^https?:\/\/[\w./?=&-]+\s*$/gm,
    /^\s*dataLayer\.push.*$/gm,
    /^\s*googletag\.(cmd|display|pubads).*$/gm,
    /^\s*gtag\((['"]).*\1,.*$/gm,
    /^\s*\$.(cookie|get|post|ajax)\(.*$/gm,
    /^\s*document\.(addEventListener|querySelector|createElement|cookie|getElement).*$/gm,
  ];
  for (const re of navPatterns) {
    s = s.replace(re, "");
  }

  // 3. 删行内残留
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, "");
  s = s.replace(/<\/?(div|span|figure|figcaption|table|tr|td|th)\b[^>]*>/gi, "");
  // 3.5 链接剥除：保留链接文字，去掉 href 噪音
  s = s.replace(/<a\s+[^>]*href="[^"]*"[^>]*>([\s\S]*?)<\/a>/gi, "$1");
  s = s.replace(/<a\s+[^>]*>([\s\S]*?)<\/a>/gi, "$1");

  // 4. 合并连续空行
  s = s.replace(/\n{3,}/g, "\n\n");

  // 5. 去每行尾空白
  s = s.split("\n").map((line) => line.replace(/[ \t]+$/, "")).join("\n");

  return s.trim();
}

function unwrapMcpResponse(text: string): string {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("[")) return text;
  try {
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) return text;
    const parts: string[] = [];
    for (const item of arr) {
      if (item && typeof item === "object" && typeof item.text === "string") {
        parts.push(item.text);
      }
    }
    if (parts.length === 0) return text;
    return parts.join("\n\n");
  } catch {
    return text;
  }
}

/**
 * v1.6.0 NEW: 锚点截断，在启发式清洗之前执行。
 *
 * 为什么在清洗前：clean 的导航规则会整行删除纯 URL 行（如 DOI 链接），
 * 锚点若被选在会被清洗改动的行上，清洗后 trim 会误报未命中；
 * clean 不重排内容，前后截断的保留区间等价，清洗前执行还能少洗一段废文本。
 *
 * 语义：
 *   --trim-head A  保留 A 首次出现处（含 A）到末尾
 *   --trim-tail B  保留开头到 B 首次出现处（不含 B）截止
 *   双向同给且 A 在 B 之后 → 区间倒置，报错退出
 *
 * 匹配用 indexOf 字面匹配（锚点常含正则特殊字符如括号/竖线/点号）；
 * 未命中或区间倒置 → stderr 报错 exit 1（fail loud，绝不静默跳过——trim 是破坏性操作）；
 * 进度日志一律走 stderr（stdin 模式下 stdout 是管道出口，不能污染）。
 */
function applyTrim(text: string, head: string | null, tail: string | null): string {
  let start = 0;
  let end = text.length;
  if (head !== null) {
    const i = text.indexOf(head);
    if (i < 0) {
      console.error(`>>> --trim-head 锚点未命中: "${head.slice(0, 60)}"`);
      process.exit(1);
    }
    start = i;
    console.error(`>>> trim-head: 保留自 "${head.slice(0, 40)}"（丢弃前 ${start} chars）`);
  }
  if (tail !== null) {
    const j = text.indexOf(tail);
    if (j < 0) {
      console.error(`>>> --trim-tail 锚点未命中: "${tail.slice(0, 60)}"`);
      process.exit(1);
    }
    end = j;
    console.error(`>>> trim-tail: 截止于 "${tail.slice(0, 40)}"（丢弃后 ${text.length - end} chars）`);
  }
  if (start >= end) {
    console.error(
      `>>> trim 区间倒置：--trim-head 锚点位置（${start}）在 --trim-tail 锚点位置（${end}）之后`,
    );
    process.exit(1);
  }
  return text.slice(start, end);
}

function parseArgs(): {
  input: string | null;
  output: string | null;
  useStdin: boolean;
  fromMcp: boolean;
  trimHead: string | null;
  trimTail: string | null;
} {
  let input: string | null = null;
  let output: string | null = null;
  let useStdin = false;
  let fromMcp = false;
  let trimHead: string | null = null;
  let trimTail: string | null = null;
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    const next = process.argv[i + 1];
    if (a === "--stdin") useStdin = true;
    else if (a === "--from-mcp") fromMcp = true;
    else if (a === "--out" && next) {
      output = next;
      i++;
    } else if (a === "--trim-head" && next) {
      trimHead = next;
      i++;
    } else if (a === "--trim-tail" && next) {
      trimTail = next;
      i++;
    } else if (a === "--help" || a === "-h") {
      console.log(`用法: clean.ts <input.md> [output.md] | --stdin
  --stdin                从 stdin 读，输出到 stdout
  --from-mcp             自动识别 mcp 工具返回的 JSON 包装
  --out <path>           显式指定输出路径
  --trim-head <锚点>     v1.6.0：保留锚点首次出现处（含）到末尾（清洗前执行，indexOf 字面匹配）
  --trim-tail <锚点>     v1.6.0：保留开头到锚点首次出现处（不含）截止
  --help, -h             本帮助

默认：<input>.cleaned.md
锚点未命中 / 区间倒置 → stderr 报错 exit 1（fail loud）
`);
      process.exit(0);
    } else if (!input) {
      input = resolve(a);
    } else if (!output) {
      output = resolve(a);
    }
  }
  return { input, output, useStdin, fromMcp, trimHead, trimTail };
}

const args = parseArgs();

if (args.useStdin) {
  const text = await Bun.stdin.text();
  const unwrapped = args.fromMcp ? unwrapMcpResponse(text) : text;
  const trimmed = applyTrim(unwrapped, args.trimHead, args.trimTail);
  const cleaned = cleanMarkdown(trimmed);
  if (args.output) {
    writeFileSync(args.output, cleaned, "utf-8");
    console.log(`>>> cleaned → ${args.output} (${cleaned.length} chars)`);
  } else {
    process.stdout.write(cleaned);
  }
} else if (args.input) {
  if (!existsSync(args.input)) {
    console.error(`>>> 文件不存在: ${args.input}`);
    process.exit(1);
  }
  const raw = readFileSync(args.input, "utf-8");
  const unwrapped = args.fromMcp ? unwrapMcpResponse(raw) : raw;
  const trimmed = applyTrim(unwrapped, args.trimHead, args.trimTail);
  const cleaned = cleanMarkdown(trimmed);
  const outPath = args.output ?? args.input.replace(/\.md$/, ".cleaned.md");
  writeFileSync(outPath, cleaned, "utf-8");
  const before = unwrapped.length;
  const after = cleaned.length;
  const pct = ((1 - after / before) * 100).toFixed(1);
  console.log(`>>> cleaned: ${args.input} → ${outPath}`);
  console.log(`    ${before} → ${after} chars (-${pct}%)`);
} else {
  console.error("需要 <input.md> 或 --stdin，或 --help");
  process.exit(1);
}