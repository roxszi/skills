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

// ============== Markdown 字符常量（避免 esbuild 0.28 反引号 lexer edge case）==============
const BT = String.fromCharCode(96);  // 反引号

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
  // frontmatter 必须以三个连字符起、三个连字符止；本仓库 SKILL.md 全部合规
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) throw new Error("未找到 frontmatter：" + filePath);
  const out: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    // 去掉包住的引号
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
  const trimmed = desc.replace(/\s+/g, " ").trim();
  const m = trimmed.match(/^[^。.!?！？\n]+/);
  const head = m ? m[0].trim() : trimmed;
  if (head.length <= maxLen) return head;
  return head.slice(0, maxLen - 1) + "…";
}

// ============== 渲染块 ==============

/** README.md 的「Skills 总览」表 — 含锚点（带版本号） */
export function renderSkillsTable(skills: SkillInfo[]): string {
  const lines: string[] = [];
  lines.push("| Skill | 版本 | 触发一句话 | 依赖 |");
  lines.push("|---|---|---|---|");
  for (const s of skills) {
    // 锚点 = # <skill-名-slug>--<中文名>-v<版本号去掉点>
    // 例如：#-local-kb--本地信息资源数据库-v152
    const verAnchor = s.version.replace(/\./g, "");
    const anchor = "#-" + s.slug + "--" + s.name + "-v" + verAnchor;
    // 用 String.fromCharCode 构造 markdown 链接（避免 esbuild 反引号 lexer edge case）
    const LB = String.fromCharCode(91);  // 左方括号
    const RB = String.fromCharCode(93);  // 右方括号
    const LP = String.fromCharCode(40);  // 左圆括号
    const RP = String.fromCharCode(41);  // 右圆括号
    const link = LB + BT + s.slug + BT + RB + LP + anchor + RP;
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
    lines.push("| " + BT + "skills/" + s.slug + "/" + BT + " | " + s.name + " | " + s.version + " | " + s.compatibility + " |");
  }
  return lines.join("\n");
}

/** README.md 的「目录结构」块 — 按真实 ls 渲染（深度 2） */
export function renderDirTree(skills: SkillInfo[]): string {
  const lines: string[] = [];
  lines.push(BT + BT + BT);
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
  lines.push(BT + BT + BT);
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
  const beginRe = new RegExp(`<!-- BEGIN: ${key}(?:\\s*\\([^)]*\\))?\\s*-->`, "g");
  const endRe = new RegExp(`<!-- END: ${key}\\s*-->`, "g");
  const beginMatch = beginRe.exec(text);
  if (!beginMatch) return false;
  // 从 BEGIN 之后开始找 END
  const beginEnd = beginMatch.index + beginMatch[0].length;
  const rest = text.slice(beginEnd);
  endRe.lastIndex = 0;
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