#!/usr/bin/env node
/**
 * 仓库级 index 维护脚本。
 *
 * 职责：扫描 skills 下各 SKILL.md 的 YAML frontmatter，把 README.md / AGENTS.md
 * 中标记为「自动渲染」区间的硬事实（版本号 / slug / 触发场景 / 目录结构）
 * 一次性同步成与 SKILL.md 一致的最新值。
 *
 * 叙事性描述、技术细节、段落正文 → 不动，保留人工写作意图。
 *
 * 运行：
 *   pnpm build:index         # 实际写入
 *   pnpm build:index:dry     # 只打印，不改文件（调试用）
 *
 * 公共 API（给 check-index-sync.ts 复用）：
 *   - parseFrontmatter(filePath)
 *   - loadSkills()
 *   - firstSentence(desc)
 *   - renderSkillsTable(skills)
 *   - renderOverviewTable(skills)
 *   - renderDirTree(skills)
 *   - replaceSentinel(filePath, key, newContent)
 *
 * Sentinel 标记语法：
 *   <!-- BEGIN: SKILLS-TABLE (auto) -->
 *   ...（自动内容）...
 *   <!-- END: SKILLS-TABLE -->
 *
 * 可用区间（section 名 = BEGIN/END 注释里的 KEY）：
 *   - SKILLS-TABLE  → README.md 的「Skills 总览」表
 *   - SKILLS-OVERVIEW → AGENTS.md 的「仓库概述」表
 *   - DIR-TREE         → README.md 的「目录结构」块（按真实 ls 渲染）
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

// ============== 路径常量 ==============

const REPO_ROOT = process.cwd();
const SKILLS_DIR = join(REPO_ROOT, "skills");
const README_PATH = join(REPO_ROOT, "README.md");
const AGENTS_PATH = join(REPO_ROOT, "AGENTS.md");

// ============== Markdown 字符常量 ==============
//
// 为什么用 String.fromCharCode 而不是直接写字面量？
// 本脚本由 tsx 通过 esbuild 即时编译执行；esbuild 0.28 对某些含反引号
// ` ` 的特定源码组合存在 lexer edge case，会误判为未闭合模板字符串。
// 统一用 charcode 拼接规避，全模块只有这几处用法，集中放这里便于维护。
//
// 字面量对照：
//   BT  = `` ` ``（反引号）
//   LB  = `[`   （左方括号）
//   RB  = `]`   （右方括号）
//   LP  = `(`   （左圆括号）
//   RP  = `)`   （右圆括号）
//
const BT = String.fromCharCode(96);  // 反引号 `
const LB = String.fromCharCode(91);  // 左方括号 [
const RB = String.fromCharCode(93);  // 右方括号 ]
const LP = String.fromCharCode(40);  // 左圆括号 (
const RP = String.fromCharCode(41);  // 右圆括号 )

/** 构造 markdown 链接 `[text](url)` */
function mdLink(text: string, url: string): string {
  return LB + text + RB + LP + url + RP;
}

/** 构造 markdown 内联代码 `` `text` `` */
function code(text: string): string {
  return BT + text + BT;
}

/** 构造 markdown 围栏代码块起始 / 结束的 ```` ``` ```` */
function fence(): string {
  return BT + BT + BT;
}

// ============== GitHub 锚点算法模拟 ==============
//
// [html-pipeline](https://github.com/jch/html-pipeline)（GitHub 内部用）的锚点生成
// 正则：`[^\w -]`（保留 `\w` + 空格 + `-`，其余删除），随后空格转 `-`、压缩、trim。
//
// 为什么不用现成的 github-slugger？那个库是**近似模拟**，对 emoji / 一些 Unicode
// 字符的处理与 GitHub 真实算法仍有出入（如 issue #54、#56）。本仓库只关心"如何把
// frontmatter 的 slug + name 转成锚点"，逻辑很窄，自己写更可控。

/**
 * 模拟 GitHub 锚点算法处理一段文本：
 *   1. 删除所有不在"字母/数字 + `_` + 空格 + `-`"范围内的字符（emoji / 中文破折号 / 标点等）
 *   2. 每个空白 → `-`（必须用 `\s` 而非 `\s+`，否则连续空白会被压成单个 `-`）
 *   3. 去除首尾 `-`（避免 slug 前后多余空格产生的孤立 `-` 出现）
 *
 * ⚠️ **不要加"连续 `-` 压缩"步骤！** GitHub 算法不做这个。
 *    真实标题 `## \`local-kb\` — 本地名` 处理后是 `local-kb--本地名`（slug 末尾 `b` + 破折号删后
 *    合并的 2 个空格 → 2 个 `-`），保留 2 个 `-`，压缩会变成 `local-kb-本地名` 与真实算法不符。
 *
 * ⚠️ **JS 正则 `\w` 即使加 `u` 标志也只匹配 ASCII `[A-Za-z0-9_]`，不匹配汉字！**
 *    GitHub 用的 Ruby `\w` 带 u 标志匹配 Unicode word（含汉字）——但 JS 没这行为。
 *    本仓库踩过这个坑：用 `\w` 会让汉字被当非 `\w` 删除，锚点只剩 slug。
 *    正确做法：用 `\p{L}\p{N}` 显式匹配 Unicode 字母/数字（必须加 `u` 标志）。
 *    `\p{L}` = 任意语言字母（含汉字）；`\p{N}` = 任意数字。
 */
function slugify(text: string): string {
  return text
    .replace(/[^\p{L}\p{N}_ -]/gu, "")  // 步骤 1：删除非 Unicode 字母/数字 + ASCII _/空格/- 的字符
    .replace(/\s/gu, "-")               // 步骤 2：每个空白 → `-`（无 `+`，避免连续空白压成单个）
    .replace(/^-+|-+$/gu, "");          // 步骤 3：trim 首尾孤立 `-`
}

/**
 * 模拟真实标题结构生成 GitHub 锚点。
 *
 * 真实标题样例：`## 📚 `local-kb` — 本地信息资源数据库`
 * 拆解结构：emoji + 空格 + `<slug>` + 空格 + 中文破折号 + 空格 + `<name>`
 *
 * 直接拼 `"#" + slug + "--" + name` 会出错：
 *   - 不处理 name 里的空格（如 `OCR 工具箱`）→ 锚点里出现空格，GitHub 不识别
 *   - 不会自动产生 slug 与 name 之间的 `--`（需要真实算法里的"破折号被删→前后空格合并→变 2 个 -"）
 *
 * 正确做法：构造一个 fakeTitle 还原真实标题的关键结构（emoji 可省，反引号必加，
 * 破折号必加），整体跑 slugify，再加 `#` 前缀。
 *
 * 验证（手算）：
 *   anchorFromTitle("local-kb", "本地信息资源数据库")
 *     → slugify("`local-kb` — 本地信息资源数据库")
 *     → 删 ` 和 `—`：`local-kb  本地信息资源数据库`（注意：破折号被删后前后空格合并为 2 个）
 *     → 空格转 `-`：`local-kb--本地信息资源数据库`
 *     → 加 `#`：`#local-kb--本地信息资源数据库` ✅
 *
 *   anchorFromTitle("ocr-toolkit", "OCR 工具箱")
 *     → slugify("`ocr-toolkit` — OCR 工具箱")
 *     → `ocr-toolkit  OCR 工具箱`
 *     → `ocr-toolkit--OCR-工具箱`
 *     → `#ocr-toolkit--OCR-工具箱` ✅（空格被正确转为 `-`）
 */
function anchorFromTitle(slug: string, name: string): string {
  // fakeTitle 用 BT 拼反引号（避免源码内反引号触发 esbuild lexer edge case，见顶部注释）
  const fakeTitle = BT + slug + BT + " — " + name;
  return "#" + slugify(fakeTitle);
}

// ============== YAML frontmatter 极简解析 ==============
// 只解析 key/value 这种扁平键值对，不引 yaml 包。
// 适用本仓库 SKILL.md frontmatter（5-6 行单层结构）。

interface Frontmatter {
  name: string;
  slug: string;
  description: string;
  version: string;
  license: string;
  author?: string;
  compatibility?: string;
}

export function parseFrontmatter(filePath: string): Frontmatter {
  const raw = readFileSync(filePath, "utf-8");
  // 匹配整段 frontmatter 区段（--- 起、--- 止）：
  //   ^---          — 行首必须是三个连字符（frontmatter 起始标志）
  //   \r?\n         — 兼容 Windows (CRLF) 与 Unix (LF) 换行
  //   ([\s\S]*?)    — 捕获内容区段；非贪婪 `*?`，避免跨 frontmatter 匹配到下一处 ---
  //   \r?\n---      — 同样以换行 + 三个连字符结束
  //   \r?\n         — 末尾换行（frontmatter 后到正文之间）
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) throw new Error("未找到 frontmatter：" + filePath);
  const out: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    // 匹配单行 `key: value`：
    //   ([a-zA-Z_][a-zA-Z0-9_-]*) — key：字母 / 下划线起，后续允许字母数字下划线连字符
    //                              （兼容 `key-name`、`frontmatter_v2` 这类带连字符 / 下划线的 key）
    //   :                          — YAML 的 key/value 分隔符
    //   \s*                        — 冒号后可零或多个空白
    //   (.*)$                      — value：行尾前任意内容（不含换行）
    const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    // 去掉 value 外层包住的引号（单 / 双皆可），避免 `"中文"` 实际被存成 `"中文"`（含字面量引号）
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[kv[1]] = v;
  }
  return out as unknown as Frontmatter;
}

// ============== 扫描 skills/ ==============

interface SkillInfo {
  slug: string;
  name: string;
  version: string;
  description: string;
  compatibility: string;
  meta: Frontmatter;
  dirName: string;
}

export function loadSkills(): SkillInfo[] {
  if (!existsSync(SKILLS_DIR)) throw new Error("skills 目录不存在：" + SKILLS_DIR);
  const dirs = readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  const out: SkillInfo[] = [];
  for (const dirName of dirs) {
    const skillMd = join(SKILLS_DIR, dirName, "SKILL.md");
    if (!existsSync(skillMd)) {
      console.warn("⚠️ 跳过 " + dirName + "：未找到 SKILL.md");
      continue;
    }
    const meta = parseFrontmatter(skillMd);
    out.push({
      slug: meta.slug,
      name: meta.name,
      version: meta.version,
      description: meta.description,
      compatibility: meta.compatibility || "—",
      meta,
      dirName,
    });
  }
  return out;
}

// ============== 描述 → 一句话触发 ==============

/**
 * 从 description 字段抽取第一句作为「触发一句话」。
 * 规则：第一个句号（中英文皆可）之前的部分。
 * 例："中文 OCR + PDF 扫描件 ... 触发。" → "中文 OCR + PDF 扫描件 ..."
 */
export function firstSentence(desc: string, maxLen = 80): string {
  // 先把任意空白（含换行 / 全角空格 / 制表符）压成单空格，避免 description 跨行导致 trim 失准
  const trimmed = desc.replace(/\s+/g, " ").trim();
  // 字符类 [^...] 表示"取首个不包含以下字符的最长前缀"：
  //   。      — 中文句号
  //   .       — 英文句号
  //   ! ?     — 英文感叹号 / 问号
  //   ！？    — 中文感叹号 / 问号
  //   \n      — 换行兜底（description 通常是单行，但万一跨行也能切）
  const m = trimmed.match(/^[^。.!?！？\n]+/);
  const head = m ? m[0].trim() : trimmed;
  if (head.length <= maxLen) return head;
  // 超长截断：用省略号收尾（maxLen - 1 是给省略号留位）
  return head.slice(0, maxLen - 1) + "…";
}

// ============== 渲染块 ==============

/**
 * 渲染 README.md 的「Skills 总览」表 — 含 GitHub 锚点链接。
 *
 * 锚点必须**对齐 GitHub 真实算法**，否则表格里的链接点不开。
 * GitHub 实际用的是 [html-pipeline](https://github.com/jch/html-pipeline) 的
 * Ruby 正则 `[^\w -]`（保留 `\w` + 空格 + 连字符，其余删除），步骤：
 *   1. 移除 markdown 标记（emoji / 反引号 / 加粗等）
 *   2. 中文破折号 `—` 等标点一律**删除**（不是变 `-`，这是常见误解）
 *   3. 空格 → `-`
 *   4. 连续 `-` 压缩 + trim 首尾
 *
 * 注意点：
 * - **不嵌版本号**——主标题不带版本号，硬塞会让每次升版本都要改链接
 * - **name 中的空格也要变 `-`**——例如 `name: OCR 工具箱` 必须处理成 `OCR-工具箱`，
 *   否则锚点里会出现空格（点不开）。这是 anchorFromTitle() 的核心职责
 * - **必须整体模拟标题结构**——不能用 `"#" + slug + "--" + name` 硬拼，
 *   那样会忽略"破折号前后空格→两个连字符"的细节
 */
export function renderSkillsTable(skills: SkillInfo[]): string {
  const lines: string[] = [];
  lines.push("| Skill | 版本 | 触发一句话 | 依赖 |");
  lines.push("|---|---|---|---|");
  for (const s of skills) {
    const anchor = anchorFromTitle(s.slug, s.name);
    const link = mdLink(code(s.slug), anchor);
    lines.push(
      "| " + link + " | " + s.version + " | " +
        '"' + firstSentence(s.description) + '" | ' +
        s.compatibility + " |",
    );
  }
  return lines.join("\n");
}

/** AGENTS.md 的「仓库概述」表 — 简版，无锚点 */
export function renderOverviewTable(skills: SkillInfo[]): string {
  const lines: string[] = [];
  lines.push("| 目录 | Skill | 版本 | 运行时依赖 |");
  lines.push("|---|---|---|---|");
  for (const s of skills) {
    // 用 code() 把路径包成 `` `skills/<slug>/` ``，鼠标悬停可看到等宽字体的完整路径
    lines.push("| " + code("skills/" + s.slug + "/") + " | " + s.name + " | " + s.version + " | " + s.compatibility + " |");
  }
  return lines.join("\n");
}

/** README.md 的「目录结构」块 — 按真实 ls 渲染（深度 2） */
export function renderDirTree(skills: SkillInfo[]): string {
  const lines: string[] = [];
  lines.push(fence());  // 围栏代码块起始 ```（避免子目录里有 markdown 标记被误解析）
  lines.push("skills/");
  lines.push("├── LICENSE                      # 木兰宽松许可证 v2");
  lines.push("├── README.md                    # 本文件（自动渲染 Skills 总览）");
  lines.push("├── AGENTS.md                    # 仓库维护者指南（自动渲染仓库概述）");
  lines.push("├── .gitignore");
  lines.push("├── scripts/                     # 仓库级脚本（pnpm build:index 等）");
  lines.push("└── skills/");
  for (let i = 0; i < skills.length; i++) {
    const s = skills[i];
    const isLast = i === skills.length - 1;
    const prefix = isLast ? "    └── " : "    ├── ";
    const subEntries = listSubDir(s.dirName);
    lines.push(prefix + s.slug + "/");
    for (let j = 0; j < subEntries.length; j++) {
      const e = subEntries[j];
      const subLast = j === subEntries.length - 1;
      const subPrefix = isLast ? "        " : "    │   ";
      lines.push(subPrefix + (subLast ? "└── " : "├── ") + e);
    }
  }
  lines.push(fence());  // 围栏代码块结束 ```
  return lines.join("\n");
}

export function listSubDir(slugDir: string): string[] {
  const dir = join(SKILLS_DIR, slugDir);
  if (!existsSync(dir)) return [];
  const items = readdirSync(dir, { withFileTypes: true });
  // 顶级条目：先目录再文件，目录标正斜杠
  const dirs: string[] = [];
  const files: string[] = [];
  for (const it of items) {
    if (it.name.startsWith(".")) continue; // 跳过 .git 等
    if (it.isDirectory()) {
      dirs.push(it.name + "/");
    } else if (it.isFile()) {
      files.push(it.name);
    }
  }
  return [...dirs.sort(), ...files.sort()];
}

// ============== sentinel 替换 ==============

/**
 * 在文件中查找：
 *   <!-- BEGIN: <KEY> (auto) -->
 *   ...任意内容...
 *   <!-- END: <KEY> -->
 * 把 BEGIN/END 之间的内容替换成 newContent（不含标记本身）。
 */
export function replaceSentinel(filePath: string, key: string, newContent: string): boolean {
  const text = readFileSync(filePath, "utf-8");
  // BEGIN 标记正则：`<!-- BEGIN: <KEY> (auto|manual|...) -->`
  //   \\s*\\([^)]*\\) — 可选的 `(...)` 注释（任意非 `)` 字符），比如本仓库的 `(auto)`
  //                   注意 `[^)]*` 而非 `.*?`：不允许嵌套括号，但本仓库的 sentinel 不会出现
  //   \\s*            — `-->` 前可有空白
  const beginRe = new RegExp(`<!-- BEGIN: ${key}(?:\\s*\\([^)]*\\))?\\s*-->`, "g");
  // END 标记正则：`<!-- END: <KEY> -->` — 约定 END 不带 `(auto)` 等注释，比 BEGIN 更严格
  const endRe = new RegExp(`<!-- END: ${key}\\s*-->`, "g");
  const beginMatch = beginRe.exec(text);
  if (!beginMatch) return false;
  // 从 BEGIN 标记末尾之后开始找 END，避免误把更早的 END 标记当当前区间的结束
  const beginEnd = beginMatch.index + beginMatch[0].length;
  const rest = text.slice(beginEnd);
  endRe.lastIndex = 0;  // 重置 lastIndex：新字符串上重新搜索
  const endMatch = endRe.exec(rest);
  if (!endMatch) {
    throw new Error("sentinel 未闭合：" + key + " in " + filePath);
  }
  const endStart = beginEnd + endMatch.index;
  const endEnd = endStart + endMatch[0].length;
  const replaced =
    text.slice(0, beginEnd) +
    "\n" + newContent + "\n" +
    text.slice(endStart);
  writeFileSync(filePath, replaced, "utf-8");
  return true;
}

// ============== 主流程 ==============

export function runBuild() {
  const dryRun = process.argv.includes("--dry") || process.argv.includes("--dry-run");
  if (dryRun) console.log("🔍 DRY RUN 模式（不写文件）\n");

  console.log("🔍 扫描 skills/ ...");
  const skills = loadSkills();
  console.log("   发现 " + skills.length + " 个 skill:");
  for (const s of skills) {
    console.log("   - " + s.slug + " " + s.version + " (" + s.compatibility + ")");
  }

  console.log("\n📝 README.md 的 SKILLS-TABLE:");
  console.log("---");
  console.log(renderSkillsTable(skills));
  console.log("---");

  console.log("\n📝 README.md 的 DIR-TREE:");
  console.log("---");
  console.log(renderDirTree(skills));
  console.log("---");

  console.log("\n📝 AGENTS.md 的 SKILLS-OVERVIEW:");
  console.log("---");
  console.log(renderOverviewTable(skills));
  console.log("---");

  if (dryRun) {
    console.log("\n✅ DRY RUN 完成（未修改任何文件）。去掉 --dry 真正写入。");
    return;
  }

  console.log("\n📝 写入 README.md ...");
  if (replaceSentinel(README_PATH, "SKILLS-TABLE", renderSkillsTable(skills))) {
    console.log("   ✅ Skills 总览表 已更新");
  } else {
    console.warn("   ⚠️ 未找到 SKILLS-TABLE sentinel，跳过");
  }
  if (replaceSentinel(README_PATH, "DIR-TREE", renderDirTree(skills))) {
    console.log("   ✅ 目录结构 已更新");
  } else {
    console.warn("   ⚠️ 未找到 DIR-TREE sentinel，跳过");
  }

  console.log("\n📝 写入 AGENTS.md ...");
  if (replaceSentinel(AGENTS_PATH, "SKILLS-OVERVIEW", renderOverviewTable(skills))) {
    console.log("   ✅ 仓库概述表 已更新");
  } else {
    console.warn("   ⚠️ 未找到 SKILLS-OVERVIEW sentinel，跳过");
  }

  console.log("\n✨ 完毕。下一步：");
  console.log("   git diff README.md AGENTS.md  # 检查渲染结果");
  console.log("   git add README.md AGENTS.md");
  console.log("   git commit -m 'docs: 自动同步 skills/ 元数据'");
}

// ============== CLI 入口守卫 ==============
// 仅当本文件被直接执行（`tsx scripts/build-index.ts`）时跑 runBuild；
// 被 check-index-sync.ts import 时不跑（避免副作用污染 stdout）
import { fileURLToPath } from "node:url";
const isMain = process.argv[1] && (
  process.argv[1] === fileURLToPath(import.meta.url) ||
  process.argv[1].endsWith("build-index.ts")
);
if (isMain) {
  runBuild();
}