# AGENTS.md

> 本文件给**仓库维护者**（含未来的 AI 协作者）看的指南。
> 要查找 skill 的**使用方式**，请读对应 `skills/<name>/SKILL.md`。

---

## 1. 仓库概述

面向 AI 编程 agent 的 skills 集合。skill 数与版本由 `scripts/build-index.ts` 自动同步：

<!-- BEGIN: SKILLS-OVERVIEW (auto) -->
| 目录 | Skill | 版本 | 运行时依赖 |
|---|---|---|---|
| `skills/local-kb/` | 本地信息资源数据库 | 1.5.2 | bun |
| `skills/ocr-toolkit/` | OCR 工具箱 | 1.0.2 | python |
| `skills/tech-brief-writer/` | 技术简报撰写 | 4.1.2 | — |
<!-- END: SKILLS-OVERVIEW -->

主仓库：[AtomGit](https://atomgit.com/roxszi/skills)（作者国内主用）
镜像仓库：[GitHub](https://github.com/roxszi/skills)（自动同步，对外发布渠道）

> `npx skills add` 命令以 **GitHub 路径**为最终值（CLI 默认走 GitHub API 拉仓库）。

---

## 2. 目录约定

```
skills/
├── AGENTS.md              ← 本文件（维护者指南）
├── README.md              ← 用户门面（安装命令 + 触发场景）
├── LICENSE                ← MulanPSL v2
├── .gitignore
├── skills.sh.json         ← skills.sh 网站展示配置（分组元数据）
└── skills/
    └── <skill-name>/      ← kebab-case 命名（与 frontmatter slug 一致）
        ├── SKILL.md       ← 必选：skill 定义入口（frontmatter + 正文）
        ├── README.md      ← 推荐：人类索引（GitHub 上点开看的）
        ├── template.md    ← 按需：配置模板（如 schema.yaml 骨架）
        ├── package.json   ← 按需：仅 Bun / Node 脚本时
        ├── scripts/       ← 按需：可执行脚本
        ├── notes/         ← 按需：按需加载的引用文档
        ├── references/    ← 按需：与 notes 同义，按团队习惯
        └── test/          ← 按需：测试用例与样本输出
```

`scripts/` 命名：`scripts/<kebab-case>.ts` 或 `.py`，**绝不用下划线**。
附属资产（HTML 演示 / SVG / 图片）放在 skill 各自的 `assets/`，不进 `scripts/`。

---

## 3. 新增 skill 的流程

1. **选名字**：`kebab-case`（小写英文 + 连字符），与 frontmatter 的 `slug` 字段保持一致
2. **建目录**：`skills/<skill-name>/`
3. **写 `SKILL.md`**：包含 YAML frontmatter + 正文（规范见 §6）
4. **可选补**：`README.md` / `template.md` / `scripts/` / `notes/`
5. **本地冒烟**：用 `npx skills add ./skills/<skill-name> -y -a claude-code` 试装，验证触发词能自动唤起
6. **同步更新三个地方**（漏一个 = 文档不一致）：
   - `skills.sh.json` 的 `groupings[*].skills` 加 skill 名（**仍需手工**——这是网站分组元数据，自动脚本不接管）
   - 根 `README.md` 的「Skills 总览」表格 + 「目录结构」块：本目录的 `scripts/build-index.ts` 自动渲染，**新增 / 删除 / 改 version 只需跑一次**：
     ```bash
     pnpm build:index         # 实际写入
     pnpm build:index:dry     # 只打印渲染结果，不改文件（调试用）
     pnpm check:index         # 只检查一致性，不写文件（pre-commit 会自动跑）
     ```
   - 本文件 §1 的「仓库概述」表格：同上，由 `build:index` 自动维护
   - ⚠️ **pre-commit hook 已注册**（`.git/hooks/pre-commit` 由 `simple-git-hooks` 写入）：改了 SKILL.md frontmatter 但忘跑 `pnpm build:index` 时 commit 会被挡，提示哪一处 sentinel 不一致。紧急跳过：`SKIP_SIMPLE_GIT_HOOKS=1 git commit ...`
7. **bump README 顶部安装命令的 skill 计数**

---

## 4. 删除 skill 的流程

> ⚠️ **删除会破坏已安装该 skill 的下游用户的 agent**，须走 SemVer MAJOR（仓库整体从 `1.x.x` → `2.0.0`）。

1. **先标记 `deprecated`**：在 SKILL.md frontmatter 加 `deprecated: true`，正文开头一段说明替代方案与迁移指引
2. **至少保留 1 个 minor 版本**（让人有时间迁移）
3. **真正删除前**：
   - `git rm -r skills/<skill-name>/`
   - 同步更新 `skills.sh.json`（从 `groupings[*].skills` 移除）
   - 同步更新根 `README.md`
   - 同步更新本文件 §1
4. ⚠️ **不要直接 force-push `master`**——按 SOUL.md 红线，删除操作必须经过 PR 与人工 review

---

## 5. 修改 skill 的 SemVer 决策表

| 改动类型 | SemVer 级别 | 示例 |
|---|---|---|
| 改 frontmatter 必选字段（`name` / `description` 重写） | **MAJOR** | description 重写会改变 AI 自动触发行为 |
| 改 `scripts/*.ts` 接口（CLI 参数 / 文件名） | **MAJOR** | `--pk <slug>` → `--slug` |
| 删 SKILL.md 整章 | **MAJOR** | 删 §四 性能基准章 |
| 新增 SKILL.md 章节 | MINOR | 加 §四 性能基准 |
| 新增 `scripts/*.ts` / `*.py` 文件 | MINOR | 新加 `migrate.ts` |
| 改 `notes/` / `references/` 文档 | MINOR | 加 3.5 章节 |
| 修正错别字 / 错误示例 / 标注 | PATCH | `rapiddocr` → `rapidocr` |
| 改 `assets/` 文件名（不改引用路径） | PATCH | `xx.svg` → `yy.svg`（同步引用） |

更新原则：
- frontmatter `version` 字段同步 bump
- SKILL.md 末尾加「版本历史」段落（即使只有一行）

---

## 6. SKILL.md 硬规则

### 6.1 Frontmatter（YAML）字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | ✅ | 中英文都可；与目录名 `slug` 保持相关性 |
| `description` | ✅ | **决定 AI 是否自动触发**——写得模糊就等于失效 |
| `version` | ✅ | SemVer，MAJOR/MINOR/PATCH |
| `license` | ✅ | 本仓库统一 `MulanPSL v2` |
| `slug` | ⭕ 推荐 | 与目录名一致；缺省时 CLI 用目录名 |
| `compatibility` | ⭕ 推荐 | 运行时（如 `bun` / `python`），vercel 标准里没有，但建议保留——`scripts/build-index.ts` 会把它作为「依赖」列渲染进 README / AGENTS |
| `author` | ⭕ 推荐 | 维护者署名 |

### 6.2 Frontmatter 风格

写法 A（本仓库现状，扁平根级）：
```yaml
name: 本地信息资源数据库
slug: local-kb
description: ...
author: RoxSzi
version: 1.2.0
license: MulanPSL v2
```

写法 B（vercel-labs / anthropic 标准，嵌套 metadata）：
```yaml
name: ...
description: ...
metadata:
  author: RoxSzi
  version: 1.2.0
license: MulanPSL v2
```

**两种都能跑**（`npx skills add` 都能解析）。**新 skill 建议用 A**（与本仓库现有 3 个 skill 一致）；写 B 也不会报错，但与同仓库混用时风格不一致。

迁移：不做强制；除非 `description` 重写或 `name` 改名，否则不建议顺手迁移。

### 6.3 description 字段写法（**最关键**）

✅ 好写法（包含触发场景 + 适用 + 不适用）：
> 「OCR 工具选型与流水线构建。中文 OCR + PDF 扫描件 + 科研文献 / 体检报告 / 病历 / 发票等场景。基于 Python rapidocr-onnxruntime + pymupdf + pdfplumber 完整流水线。当涉及到『扫描件转文字』、『PDF 文字识别』、『识别图片中的字』等业务时触发。」

❌ 差写法（无触发场景）：
> 「OCR 工具」

`description` 长度建议 **100-500 字符**：太短基本不会被自动触发；太长也不会失败但会撑爆 context。

### 6.4 正文硬约束

| 约束 | 原因 |
|---|---|
| **总长 ≤ 500 行** | 长内容 agent 不愿读；拆 `notes/` / `references/` |
| **章节清晰** | 用 H1/H2 显式分段，便于 agent 按需跳读 |
| **中文为主，技术术语保留英文** | 与本仓库一致 |
| **每个命令要给可执行示例** | 不能写 `bun run scripts/xxx.ts <args>` 然后让 agent 猜参数 |
| **关键路径有行内注释** | 如 `<!-- 设计思路 -->` 或脚本里的 `//` 注释 |
| **诚实性红线** | OCR / 自动解析 / fetch 的关键数值未核实一律标 `（待核实）` |

---

## 7. 脚本（`scripts/`）要求

### 7.1 Bun / Node TypeScript 脚本（`local-kb` 类）

- 入口 `#!/usr/bin/env bun` shebang（如可执行）
- 严格模式 `"use strict"` 放文件顶
- **ESM only**，用 `import` / `export`，不用 CommonJS
- 错误信息含 `exit 1` 退出码（让 agent / shell 能判成功失败）
- 临时文件用 cleanup trap
- 输入用 Zod 校验
- 关键路径有 JSDoc（含设计思路）
- 依赖管理：`package.json` 的 `dependencies`，**不要** `bun add <pkg>` 不写依赖

### 7.2 Python 脚本（`ocr-toolkit` 类）

- 入口 `#!/usr/bin/env python` shebang（如可执行）
- 类型注解（`typing` / `dataclass`）
- 错误用 `raise` 抛出，让上层处理；**不要** `sys.exit(1)` 散落各处
- 不用 `print` 散落日志，用 `logging` 模块
- 关键函数有 docstring（含算法 / IO / 异常）
- 依赖管理：`scripts/requirements.txt` 写版本约束（如 `rapidocr-onnxruntime==1.4.4`）

### 7.3 通用约定

- **路径优先用正斜杠**（`C:/CodeProjects/...`），反斜杠在 bash 会被当成转义
- **Windows 路径含空格必须加引号**：`"C:/Program Files/..."`
- **目录存在检查**用 `test -d`，不要用 Node 的 `fs.existsSync` 跳过 type check
- **不依赖 GC 释放资源**——文件句柄 / DB 连接 / Worker 必须显式 close

---

## 8. 兼容性矩阵

| 环境 | 是否支持 | 备注 |
|---|---|---|
| Claude Code | ✅ 全功能 | 含 `allowed-tools`、hooks、`context: fork` |
| Cursor、Codex、Windsurf、Cline | ✅ 全功能 | 不含 hooks |
| GitHub Copilot | ✅ 基础 | 不含 `allowed-tools` 的部分高级字段 |
| CherryStudio | ⚠️ 不直接 | SKILL.md 内容可手动复制到 `CherryStudio/Data/Skills/<name>/` 用 |
| Claude.ai 网页版 | ⚠️ 手动 | 需打包 `.zip`（含 SKILL.md + 附属文件）上传，走 Anthropic Skills API |

---

## 9. 已知 vs 待核实红线（不可破）

| 来源 | 处理 |
|---|---|
| **用户口述的硬事实**（剂量 / 频次 / 诊断 / 数值） | **精确写入**，不做"❓ 待核实"妥协 |
| **OCR / fetch 自动解析** | 关键数值请用户对照原文核实；未核实标 `（待核实）` |
| **三者冲突**（用户口述 / OCR / 文档） | **立刻停下来问**，不自行取平均 |

入库后必跑：

```bash
grep -E "❓|待核实|未知|____" <kb-path>/<slug>/meta.yaml
```

确认已知信息没出现在"待核实"栏。

---

## 10. 镜像与发布

- **主仓库**：AtomGit（作者国内主用，推送更快）
- **镜像**：GitHub（自动同步，对外发布渠道）
- README 里的 `npx skills add <owner>/<repo>` 用 **GitHub 用户名**
- 重大发布：先推 AtomGit，验证镜像同步成功后，再在 skills.sh / 社区贴链接

---

## 11. License

本仓库整体采用 [MulanPSL v2](LICENSE)。单个 skill 的 license 在各自 SKILL.md frontmatter 声明（与仓库整体一致）。

---

## 12. 维护者

RoxSzi（SI_Cheng-Yun, 司承运）— 中国药科大学 理学院 化学实验中心
