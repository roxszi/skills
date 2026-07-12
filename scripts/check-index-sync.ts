#!/usr/bin/env node
/**
 * pre-commit hook 专用检查脚本。
 *
 * 职责：检查 README.md / AGENTS.md 的 sentinel 区间是否与 skills 下各 SKILL.md 的
 * frontmatter 一致。如果不一致 → exit 1，挡住 commit。
 *
 * 与 build-index.ts 的关系：
 *   - build-index.ts 负责"渲染并写入"（手动 / CI 触发）
 *   - 本脚本负责"检查一致性"（pre-commit 触发，**不写文件**）
 *
 * 运行：
 *   pnpm check:index          # 直接调用
 *   git commit                # 触发 .git/hooks/pre-commit（由 simple-git-hooks 注册）
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadSkills,
  renderSkillsTable,
  renderOverviewTable,
  renderDirTree,
} from "./build-index";

const REPO_ROOT = process.cwd();
const README_PATH = join(REPO_ROOT, "README.md");
const AGENTS_PATH = join(REPO_ROOT, "AGENTS.md");

/** 从文件中提取 sentinel BEGIN/END 之间的内容（trim 后） */
function extractSentinel(filePath: string, key: string): string | null {
  const text = readFileSync(filePath, "utf-8");
  const beginRe = new RegExp(`<!-- BEGIN: ${key}(?:\\s*\\([^)]*\\))?\\s*-->`);
  const endRe = new RegExp(`<!-- END: ${key}\\s*-->`);
  const beginMatch = beginRe.exec(text);
  if (!beginMatch) return null;  // sentinel 不存在
  const beginEnd = beginMatch.index + beginMatch[0].length;
  const rest = text.slice(beginEnd);
  const endMatch = endRe.exec(rest);
  if (!endMatch) return null;  // sentinel 未闭合
  return rest.slice(0, endMatch.index).trim();
}

interface Check {
  file: string;
  key: string;
  expected: string;
}

function main() {
  // 如果 SKILL.md 本身都没改，git status 会显示干净——这时直接放行
  // 但 pre-commit hook 已经触发意味着有改动，简单起见我们始终跑完整检查
  console.log("🔍 检查 sentinel 区间与 SKILL.md frontmatter 一致性 ...");
  const skills = loadSkills();

  const checks: Check[] = [
    { file: "README.md", key: "SKILLS-TABLE", expected: renderSkillsTable(skills) },
    { file: "README.md", key: "DIR-TREE", expected: renderDirTree(skills) },
    { file: "AGENTS.md", key: "SKILLS-OVERVIEW", expected: renderOverviewTable(skills) },
  ];

  let failed = 0;
  for (const c of checks) {
    const fullPath = c.file === "README.md" ? README_PATH : AGENTS_PATH;
    const current = extractSentinel(fullPath, c.key);
    const expectedTrim = c.expected.trim();
    if (current === null) {
      console.error("❌ " + c.file + " 缺少 " + c.key + " sentinel 区间");
      console.error("   → 从 build-index.ts 输出复制 BEGIN/END 块手动添加，或 git checkout " + c.file);
      failed++;
    } else if (current !== expectedTrim) {
      console.error("❌ " + c.file + " 的 " + c.key + " sentinel 区间与 frontmatter 不一致");
      // 给一个简单行级 diff 提示
      const curLines = current.split("\n");
      const expLines = expectedTrim.split("\n");
      console.error("   现状 " + curLines.length + " 行 vs 期望 " + expLines.length + " 行");
      if (curLines.length === expLines.length) {
        for (let i = 0; i < curLines.length; i++) {
          if (curLines[i] !== expLines[i]) {
            console.error("   第 " + (i + 1) + " 行不同：");
            console.error("     现状：" + curLines[i].slice(0, 100));
            console.error("     期望：" + expLines[i].slice(0, 100));
            break;
          }
        }
      }
      console.error("   → 跑 pnpm build:index 同步后再 commit");
      failed++;
    } else {
      console.log("✅ " + c.file + " 的 " + c.key + " 已同步");
    }
  }

  if (failed > 0) {
    console.error("\n❌ " + failed + " 处不一致，commit 被阻止");
    console.error("   修复：跑 pnpm build:index 后重新 git add README.md AGENTS.md");
    process.exit(1);
  }
  console.log("\n✨ 全部一致，commit 放行");
}

// 守卫：仅当被直接执行时跑；被 import 时不跑
import { fileURLToPath } from "node:url";
const isMain = process.argv[1] && (
  process.argv[1] === fileURLToPath(import.meta.url) ||
  process.argv[1].endsWith("check-index-sync.ts")
);
if (isMain) {
  main();
}