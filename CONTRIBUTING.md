# CONTRIBUTING.md — 仓库维护指南

> 本文件给**仓库维护者**（含未来的 AI 协作者）看：新增 / 删除 / 修改 skill 的流程与规范。
> skill 的**使用方式**见各 `skills/<name>/SKILL.md`；安装与触发场景见 `README.md`。

> **命名由来**：本文件原名 `AGENTS.md`。`AGENTS.md` 是 [agents.md](https://agents.md) 开放标准的保留文件名，行业语义是「给 coding agent 的仓库工作指令」——Codex、Cursor、Zed 等工具打开仓库时会自动读取。本文件的实际定位是维护者手册，故改用 GitHub 生态约定俗成的 `CONTRIBUTING.md`（GitHub 会在新建 issue / PR 时自动展示此文件链接）。若未来需要给 coding agent 提供自动加载的工作指令，另建薄层 `AGENTS.md` 指向本文件即可。

[![License: MulanPSL v2](https://img.shields.io/badge/License-MulanPSL%20v2-blue.svg)](LICENSE)

---

## 1. 仓库概述

面向 AI 编程 agent 的 skills 集合。skill 数与版本由 `scripts/build-index.ts` 自动同步：

<!-- BEGIN: SKILLS-OVERVIEW (auto) -->
| 目录 | Skill | 版本 | 运行时依赖 |
|---|---|---|---|
| `skills/local-kb/` | 本地信息资源数据库 | 1.7.0 | bun |
| `skills/paper-methodology-audit/` | 文献精读（方法学审查） | 1.3.0 | — |
| `skills/paper-review-writer/` | 文献调研与综述 | 0.2.4 | node ≥ 22.13 |
| `skills/tech-brief-writer/` | 技术简报撰写 | 4.4.0 | — |
<!-- END: SKILLS-OVERVIEW -->

主仓库：[AtomGit](https://atomgit.com/roxszi/skills)（作者国内主用）
镜像仓库：[GitHub](https://github.com/roxszi/skills)（自动同步，对外发布渠道）

> `npx skills add` 命令以 **GitHub 路径**为最终值（CLI 默认走 GitHub API 拉仓库）。

---

## 2. 目录约定

```
AI-Skills/
├── CONTRIBUTING.md        ← 本文件（维护指南，SKILLS-OVERVIEW 自动渲染）
├── README.md              ← 用户门面（安装命令 + 触发场景，三个自动区间）
├── LICENSE                ← MulanPSL v2
├── skills.sh.json         ← skills.sh 网站展示配置（分组元数据，纯手工维护）
├── scripts/               ← 仓库级脚本（build-index.ts / check-index-sync.ts）
└── skills/
    └── <name>/            ← name = 英文 kebab-case，与 frontmatter name 一致
        ├── SKILL.md       ← 必选：skill 定义入口（frontmatter + 正文）
        ├── CHANGELOG.md   ← 推荐：版本历史、设计渊源与致谢（编写者线内容）
        ├── references/    ← 按需：字段契约、深度资料、校验模板
        ├── templates/     ← 按需：产出物模板与示例
        ├── scripts/       ← 按需：可执行脚本（kebab-case，绝不用下划线）
        ├── tests/         ← 按需：run-tests.mjs 常驻回归测试
        ├── assets/        ← 按需：SVG / JS / 图片等附属资产
        ├── package.json   ← 按需：仅含 Node / Bun 依赖时（依赖不随 skill 分发）
        └── README.md      ← 可选：人类索引
```

附属资产（HTML 演示 / SVG / 图片）放在 skill 各自的 `assets/`，不进 `scripts/`。

---

## 3. 新增 skill 的流程

1. **选名字**：`name` = 目录名，英文 kebab-case（小写英文 + 连字符）
2. **建目录**：`skills/<name>/`
3. **写 `SKILL.md`**：规范见 §6；`description` 决定自动触发，最先打磨
4. **编写者线内容分流**：版本历史进 `CHANGELOG.md`；字段契约、模板、深度资料进 `references/` 与 `templates/`（§6.1 双线规则）
5. **补齐测试**：含校验脚本的 skill 落 `tests/run-tests.mjs`（§8.2）
6. **本地冒烟**：`npx skills add ./skills/<name> -y -a claude-code` 试装，验证触发词能自动唤起
7. **手工维护项同步**：`skills.sh.json` 的 `groupings[*].skills` 加 skill 名（网站分组元数据，自动脚本不接管）
8. **自动同步**：跑一次下面命令，README 的总览表 / 链接安装 / 目录树与本文件概述表全部刷新：
   ```bash
   pnpm build:index         # 实际写入
   pnpm build:index:dry     # 只打印渲染结果，不改文件（调试用）
   pnpm check:index         # 只检查一致性，不写文件（pre-commit 会自动跑）
   ```
9. **README 手写详情章节**：按 `slug`（缺省 `name`）命名章节标题（锚点与总览表联动），正文写叙事性介绍；pre-commit hook 已注册（`simple-git-hooks`），改了 frontmatter 忘跑 `pnpm build:index` 时 commit 会被挡，紧急跳过用 `SKIP_SIMPLE_GIT_HOOKS=1 git commit ...`

---

## 4. 删除 skill 的流程

> ⚠️ 删除会破坏已安装该 skill 的下游用户，须走 SemVer MAJOR（仓库整体从 `1.x.x` → `2.0.0`）。

1. **先标记 `deprecated`**：SKILL.md frontmatter 加 `deprecated: true`，正文开头一段说明替代方案与迁移指引
2. **至少保留 1 个 minor 版本**（让下游有时间迁移）
3. **真正删除前**：`git rm -r skills/<name>/`；`skills.sh.json` 移除分组项；README 手写详情章节删除；跑 `pnpm build:index` 刷新全部自动区间
4. 不直接 force-push 主分支；删除操作走 PR 与人工 review

---

## 5. 修改 skill 的 SemVer 决策表

| 改动类型 | SemVer 级别 | 示例 |
|---|---|---|
| 改 frontmatter 必选字段（`name` / `description` 重写） | **MAJOR** | description 重写会改变 AI 自动触发行为 |
| 改 `scripts/*` 接口（CLI 参数 / 文件名） | **MAJOR** | `--pk <slug>` → `--slug` |
| 删 SKILL.md 整章 | **MAJOR** | 删性能基准章 |
| 新增 SKILL.md 章节 | MINOR | 加性能基准章 |
| 新增脚本文件 | MINOR | 新加 `migrate.ts` |
| 改 `references/` / `templates/` 文档 | MINOR | 契约加 3.5 节 |
| 修正错别字 / 错误示例 / 标注 | PATCH | `rapiddocr` → `rapidocr` |

更新原则：

- frontmatter `version` 同步 bump
- `CHANGELOG.md` 加条目，只写「改了什么」；踩坑叙事不进版本条目
- 结构化改动后必跑 `tests/run-tests.mjs`（§8.2）

---

## 6. SKILL.md 编写规范

### 6.1 双线规则：使用者线与编写者线分离

SKILL.md 是运行时注入面：每次 skill 触发即整体载入上下文，正文越长烧 token 越多、注意力越稀。

- **使用者线** = SKILL.md 只放三样：**定位判断**（何时用 / 何时不用）、**业务闭环主流程**、**红线**。使用者从 SKILL.md 起，渐进读取满足业务闭环的有限内容即完成任务。
- **编写者线** = 版本历史、设计渊源与致谢、维护契约、评测记录、开发计划，一律不进 SKILL.md：版本历史落 `CHANGELOG.md`；契约、模板、深度资料落 `references/` 与 `templates/`，在主流程节点处按需引用，不做前置铺垫。
- **判定法**：对每一段自问「使用者跳过此段，任务会失败吗？」——不会，即编写者线，移出主文。
- 双线不豁免同步义务：契约 ↔ 校验脚本 ↔ SKILL.md 三处同步照旧（§8.1）。

### 6.2 Frontmatter 字段（YAML）

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | ✅ | 英文 kebab-case，与目录名一致；是 skill 的唯一 ID（安装名 / GitHub 链接名 / 表格主键） |
| `description` | ✅ | **决定 AI 是否自动触发**——写得模糊就等于失效；写法见 §6.3 |
| `version` | ✅ | SemVer：MAJOR / MINOR / PATCH |
| `license` | ✅ | 本仓库统一 `MulanPSL v2` |
| `slug` | ⭕ 可选 | 中文显示名——README 总览表第一列与详情章节标题的显示文本；缺省回落 `name` |
| `compatibility` | ⭕ 推荐 | 运行时依赖声明（如 `bun` / `node ≥ 22.13` / `python`）；`build-index.ts` 渲染进 README 与本文件的「依赖」列 |
| `author` | ⭕ 推荐 | 维护者署名 |
| `contributors` | ⭕ 可选 | 协作者署名 |

风格约定：统一用**扁平根级**写法（与本仓库现有 4 个 skill 一致）；vercel-labs / anthropic 的嵌套 `metadata:` 写法也能被 `npx skills add` 解析，但与同仓库扁平风格混用会不一致，不采用。

### 6.3 description 写法（最关键字段）

`description` 只管「何时加载本 skill」：写**正例触发场景句**（用户会说什么、给出什么输入时触发）。负例排除句、档内行为细节、延伸目的触发词不入简介——负例由基座按正例路由自然排除，档内行为由正文承载。

✅ 好写法（触发场景 + 输入形态 + 覆盖领域）：
> 精读文献并交付带方法学审查的中文解读。阅读深度分速览／精读两档，按用户表述判定。当用户给出 PDF、docx、DOI 或文献链接，要求「读一下这篇」「精读」，或要求读文献以评估可靠性、支撑实验方案时，使用本技能。覆盖物理化学、分析化学、光谱学等领域的理工科期刊论文。

❌ 差写法（无触发场景）：
> 「文献阅读工具」

长度建议 **100–500 字符**：太短基本不会被自动触发；太长不报错但挤占注入面。

### 6.4 通用性红线（解耦）

独立成 skill 就必须能在陌生环境完整运行；维护者的私有资产不是世界默认存在。

- skill 本体不引用其他 skill（别人未必装过被引者）；分工边界用能力语言表述（「宿主精读类技能」），不点名。
- skill 本体不引用维护者的私有配置路径（AGENTS / TOOLS / MEMORY 等）；高耦合的私有扩展放宿主侧钩子，skill 本体自足。
- **宿主适配表模式**：SKILL.md 内集中一张表（能力要求 + 各宿主工具名对照），全技能其他部位只写能力；适配表是工具名的唯一合法出处，迁移宿主只改表。范本见 `skills/paper-methodology-audit/SKILL.md` §1.0。
- 写完做思想实验：一台全新机器只装这一个 skill，主流程能否完整跑通——跑不通的点即耦合点。
- 证据强制、防编造闭环、分级判定这类机制是灵魂，优先保进 skill 本体；本地文献库、私有数据管线这类宿主侧流程是耦合，放钩子。
- 领域特化字段可默认含，须标注「可按领域增删」，增删时与校验脚本同步并跑回归。

### 6.5 运行时与依赖可移植

- 脚本 node 与 bun 双兼容；运行时下限以依赖链的 engines 实测要求为准写进适配表（如 `pdfjs-dist` 6 要求 node ≥ 22.13）。
- 安装指引不绑定包管理器：`npm install` / `pnpm install` / `bun install` 任一可成。
- 运行依赖不随 skill 分发：`package.json` + 锁文件声明；`node_modules` 与构建产物不驻留 skill 目录；依赖缺失时报错信息给安装指引，不裸抛栈。
- 版本号写下限，不写实测值；本机特有断言不入 skill（如「本机无 node 一律用 bun」）。
- 文档内命令示例与产物路径一律正斜杠（Windows 的 node / bun 也接受正斜杠，跨平台通吃）。

### 6.6 正文硬约束

| 约束 | 原因 |
|---|---|
| **总长 ≤ 500 行** | 长内容 agent 不愿读；编写者线内容拆 `CHANGELOG.md` / `references/` |
| **章节用 H2/H3 显式分段** | 便于 agent 按需跳读 |
| **中文为主，技术术语保留英文** | 与本仓库一致 |
| **每个命令给可执行示例** | 不能让 agent 猜参数 |
| **关键路径有行内注释** | 脚本 `//` 注释、文档 `<!-- -->` 注释 |
| **诚实性红线** | OCR / 自动解析 / fetch 的关键数值未核实一律标 `（待核实）`（§9） |
| **交付面向用户时用中文含义** | 内部代号（枚举值 / 字段名 / 档位编号）只在 skill 文档与脚本内；对用户转述一律中文含义 |

---

## 7. 脚本（`scripts/`）要求

### 7.1 JavaScript / TypeScript 脚本

- ESM only，用 `import` / `export`，不用 CommonJS
- 入口 shebang `#!/usr/bin/env node`（可执行脚本时）
- 错误信息含明确退出码（`exit 1`），让 agent / shell 能判成功失败
- 临时文件用 cleanup trap；输入用 Zod（或等价手段）校验
- 关键路径有 JSDoc（含设计思路）；中文注释
- 依赖声明进 `package.json`，不装完即删

### 7.2 Python 脚本

- 类型注解（`typing` / `dataclass`）；错误用 `raise` 抛出，不散落 `sys.exit(1)`
- 日志用 `logging` 模块，不散落 `print`
- 关键函数有 docstring（含算法 / IO / 异常）
- 依赖写 `scripts/requirements.txt`，带版本约束

### 7.3 通用约定

- **路径优先用正斜杠**：`C:/CodeProjects/...`
- **含空格路径必须加引号**
- **不依赖 GC 释放资源**：文件句柄 / DB 连接 / Worker 显式 close

---

## 8. 契约与验证

### 8.1 三处双向同步

结构化产出 schema 化：必填 / 可选分层、长度契约、`error`（拦截交付）与 `warning`（人工复核）两级校验。**契约文档 ↔ 校验脚本 ↔ SKILL.md 三处同步**：改一处即改其余三者；版本条目只写「改了什么」。

### 8.2 常驻回归测试

含校验脚本的 skill 落 `tests/run-tests.mjs`：fixture 自含、临时目录自清理、断言覆盖校验正反例与「生成—校验」往返。改动 skill 后必跑。

### 8.3 路由重验

`description` 或路由规则实改后，重验自动触发行为（触发评测的词法正例集为基线）。

### 8.4 交付前扫描

长中文文档写完扫标点降级（中文邻接半角标点）；改章节结构后 grep 逐处核对编号交叉引用。

---

## 9. 已知 vs 待核实红线（不可破）

| 来源 | 处理 |
|---|---|
| 用户口述的硬事实（数值 / 频次 / 诊断） | 精确写入，不做「待核实」妥协 |
| OCR / fetch 自动解析 | 关键数值请用户对照原文核实；未核实标 `（待核实）` |
| 三者冲突（口述 / OCR / 文档） | 立刻停下来问，不自行取平均 |

DOI 必须用 web 工具核实，不脑补。文献与文档里发现编造数据，立即停并告知用户，不替用户「凑」。

---

## 10. 仓库级自动同步（`scripts/`）

`scripts/build-index.ts` 遍历 `skills/` 目录读各 SKILL.md frontmatter，**不硬编码任何 skill 名**——增删改 skill 后跑一次即可同步全部硬事实：

| Sentinel 位置 | 区间内容 |
|---|---|
| `README.md` → `SKILLS-TABLE` | Skills 总览表（slug / 版本 / 触发一句话 / 依赖，含锚点链接） |
| `README.md` → `SKILL-LINKS` | 链接安装清单（各 skill 的 GitHub SKILL.md 直链） |
| `README.md` → `DIR-TREE` | 目录结构树（按真实 ls 渲染） |
| `CONTRIBUTING.md` → `SKILLS-OVERVIEW` | 仓库概述表 |

Sentinel 语法：`<!-- BEGIN: <KEY> (auto) -->` … `<!-- END: <KEY> -->`，标记之间的内容每次整块重写。叙事性描述、技术细节、详情章节不进 sentinel，保留人工写作意图。

`scripts/check-index-sync.ts` 只读校验同一批区间，pre-commit 自动跑，不一致即挡 commit。

README 详情章节标题约定 = frontmatter `slug`（缺省 `name`）：总览表的锚点由同一文本经 GitHub slugify 算法生成，章节标题与锚点恒一致，跨平台（GitHub / AtomGit）不断链。

---

## 11. 兼容性矩阵

| 环境 | 是否支持 | 备注 |
|---|---|---|
| Claude Code | ✅ 全功能 | 含 `allowed-tools`、hooks |
| Cursor、Codex、Windsurf、Cline | ✅ 全功能 | 不含 hooks |
| GitHub Copilot | ✅ 基础 | 不含 `allowed-tools` 的部分高级字段 |
| CherryStudio | ⚠️ 手动 | 无 `npx skills` 安装器；SKILL.md 内容复制到 `CherryStudio/Data/Skills/<name>/`，或走「链接安装」 |
| Claude.ai 网页版 | ⚠️ 手动 | 打包 `.zip` 上传，或走「链接安装」，按 Anthropic Skills API 走 |

---

## 12. 镜像与发布

- 主仓库 AtomGit（国内推送快），镜像 GitHub（对外发布渠道，`npx skills add` 与链接安装的最终值）
- 重大发布：先推 AtomGit，验证镜像同步成功，再在 skills.sh / 社区贴链接

---

## 13. License 与维护者

本仓库整体采用 [MulanPSL v2](LICENSE)；单个 skill 的 license 在各自 SKILL.md frontmatter 声明（与仓库整体一致）。

维护者：RoxSzi（SI_Cheng-Yun, 司承运）— 中国药科大学 理学院 化学实验中心
