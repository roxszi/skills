/**
 * local-kb 清洗脚本：把原始 markdown / HTML 里的噪音剥掉。
 *
 * 用法：
 *   bun run scripts/clean.ts <input.md> [output.md]            # 文件→文件
 *   bun run scripts/clean.ts --stdin                          # stdin→stdout
 *   bun run scripts/clean.ts --stdin --from-mcp               # stdin 是 mcp 工具的 JSON 包装
 *   cat raw.md | bun run scripts/clean.ts --stdin > clean.md
 *
 * 处理内容（按顺序）：
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

function parseArgs(): {
  input: string | null;
  output: string | null;
  useStdin: boolean;
  fromMcp: boolean;
} {
  let input: string | null = null;
  let output: string | null = null;
  let useStdin = false;
  let fromMcp = false;
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    const next = process.argv[i + 1];
    if (a === "--stdin") useStdin = true;
    else if (a === "--from-mcp") fromMcp = true;
    else if (a === "--out" && next) {
      output = next;
      i++;
    } else if (a === "--help" || a === "-h") {
      console.log(`用法: clean.ts <input.md> [output.md] | --stdin
  --stdin                从 stdin 读，输出到 stdout
  --from-mcp             自动识别 mcp 工具返回的 JSON 包装
  --out <path>           显式指定输出路径
  --help, -h             本帮助

默认：<input>.cleaned.md
`);
      process.exit(0);
    } else if (!input) {
      input = resolve(a);
    } else if (!output) {
      output = resolve(a);
    }
  }
  return { input, output, useStdin, fromMcp };
}

const args = parseArgs();

if (args.useStdin) {
  const text = await Bun.stdin.text();
  const unwrapped = args.fromMcp ? unwrapMcpResponse(text) : text;
  const cleaned = cleanMarkdown(unwrapped);
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
  const cleaned = cleanMarkdown(unwrapped);
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