# 一些自创的skills

> AI 编程 agent 可调用的 skills 集合。覆盖**本地知识库管理**、**文献精读与方法学审查**、**批量文献调研与综述**、**技术简报撰写**四大场景。
>
> 通过 `npx skills add` 一键安装到 Claude Code、Cursor、Codex、Windsurf、Cline 等 60+ 编程 agent；支持粘贴链接拉取安装的平台，可用下方「链接安装」。

[![License: MulanPSL v2](https://img.shields.io/badge/License-MulanPSL%20v2-blue.svg)](LICENSE)

---

## Skills 总览

<!-- BEGIN: SKILLS-TABLE (auto) -->
| Skill | 版本 | 触发一句话 | 依赖 |
|---|---|---|---|
| [`本地信息资源数据库`](#本地信息资源数据库) | 1.6.0 | "本地信息资源数据库的统一执行入口" | bun |
| [`文献精读（方法学审查）`](#文献精读方法学审查) | 1.3.0 | "精读文献并交付带方法学审查的中文解读" | — |
| [`文献调研与综述`](#文献调研与综述) | 0.1.2 | "批量文献调研与综述成文流水线：元数据核验→合规下载→全文提取→并行精读条目→素材包→综述写作→引用校验" | node ≥ 22.13 |
| [`技术简报撰写`](#技术简报撰写) | 4.4.0 | "技术简报撰写" | — |
<!-- END: SKILLS-TABLE -->

---

## 一键安装

```bash
# 安装全部 skill
npx skills add roxszi/skills

# 按需安装单个
npx skills add roxszi/skills --skill local-kb
npx skills add roxszi/skills --skill paper-methodology-audit
npx skills add roxszi/skills --skill paper-review-writer
npx skills add roxszi/skills --skill tech-brief-writer

# 全局安装（影响 ~/.claude/skills/ 等，而非项目内）
npx skills add roxszi/skills --skill local-kb -g -a claude-code

# 列出现有 skill，不安装
npx skills add roxszi/skills --list
```

支持的 agent：`claude-code`、`cursor`、`codex`、`windsurf`、`cline`、`gemini-cli`、`opencode` 等共 60+（详见 [vercel-labs/skills](https://github.com/vercel-labs/skills)）。

> 仓库主同步源：[AtomGit](https://atomgit.com/roxszi/skills)（自动镜像到 GitHub）。两边的 `owner/repo` 路径不同，**GitHub 上的安装命令才是这条 README 的最终值**。

---

## 链接安装

支持「粘贴 SKILL.md 链接 → 平台自动拉取导入」的平台（如 skills.sh、Claude.ai 网页版、CherryStudio 等），直接复制对应链接：

<!-- BEGIN: SKILL-LINKS (auto) -->
- [本地信息资源数据库](https://github.com/roxszi/skills/blob/main/skills/local-kb/SKILL.md)
- [文献精读（方法学审查）](https://github.com/roxszi/skills/blob/main/skills/paper-methodology-audit/SKILL.md)
- [文献调研与综述](https://github.com/roxszi/skills/blob/main/skills/paper-review-writer/SKILL.md)
- [技术简报撰写](https://github.com/roxszi/skills/blob/main/skills/tech-brief-writer/SKILL.md)
<!-- END: SKILL-LINKS -->

---

## 本地信息资源数据库

本地知识库的统一执行入口。给文献、健康档案、项目档案、联系人档案、会议纪要等"长期累积 + 检索 + 反查 + 备份"场景用。

**典型触发句**：

- "建一个本地文献库" / "做一个家人健康档案"
- "存一下这篇 Z" / "查一下我的 W"
- "X 和 Y 有什么关系" / "类似的还有什么"
- "备份"

**7 个执行子命令**（Bun 运行时）：

| 子命令 | 用途 |
|---|---|
| `setup.ts` | 用 `schema.yaml` 首次建库（幂等 + 版本校验） |
| `clean.ts` | 清洗原始输入（支持 stdin / MCP fetch 解包） |
| `ingest.ts` | 入库一条记录（slug 唯一、自带查重） |
| `query.ts` | 主键 / 字段精确 / LIKE / FTS5 全文检索 |
| `related.ts` | 关联发现（基于 schema.yaml 的 `related: true` 字段） |
| `audit.ts` | 对账 / 体检 / 数据健康度检查（v1.5.1+） |
| `backup.ts` | 备份到隔离目录，按 mtime 滚动保留 8 份 |

**关键能力**：

- 双重唯一性：DOI 等关键字段自动去重，重复入库沿用旧 slug
- 已知 vs 待核实泾渭分明（拒绝未核实的 OCR / 自动解析数据混入已知）
- 反模式直接报错（不算 slug 就 mkdir、配置缺字段、库目录非空就 setup 等）

详见 [`skills/local-kb/SKILL.md`](skills/local-kb/SKILL.md)。

---

## paper-methodology-audit

文献精读与方法学审查。精读文献并交付带方法学审查的中文解读，覆盖物理化学、分析化学、化学计量学、表面与电化学、光谱学等领域的理工科期刊论文。

**核心设计**：

- **提取与审查强制分离**——交付拆成「提取」（装置与工艺参数、实验路线、机理链）与「审查」（支撑证据核查、真实创新点对比）两段，避免复述冒充分析
- **阅读深度两档**：速览（≤400 字，含主旨 / 方法 / 关键数值 / 局限 / 未读范围声明）与精读（七章结构，默认档）；只升不降，禁止以速览冒充精读
- **证据锚点可追溯**——结论定位到原文具体位置；「没报告」不说成「没做」
- **审查结论三级**：硬伤 / 存疑 / 缺失，分级给出
- **取原文三层链路**：本地文件（PDF / docx）→ DOI / 链接（出版商 OA 与订阅渠道，含 ACS 专化提取）→ 拿不到全文的降级处置
- **宿主适配表**：工具名集中一张表，跨宿主（EasyClaw / CherryStudio / 其他）迁移只改表

**典型触发句**：

- "读一下这篇" / "精读这篇文献"
- "这篇靠谱吗，能不能支撑我的方案"
- "对比这几篇文献的异同"

详见 [`skills/paper-methodology-audit/SKILL.md`](skills/paper-methodology-audit/SKILL.md)。

---

## paper-review-writer

批量文献调研与综述成文流水线。主题驱动的多篇调研任务：元数据核验 → 合规下载 → 全文提取 → 并行精读条目 → 素材包 → 综述写作 → 引用校验。

**核心设计**：

- **取读分离**——脚本负责核验、下载、提取与压缩，智能体只读消化后的缓冲，不直接吞全文（防上下文爆炸）
- **元数据四源核验**：Crossref → OpenAlex → Europe PMC → Unpaywall 逐篇核验题录、补 DOI、发现 OA 链接
- **合规下载**：全为 OA 或已授权渠道；失败篇逐级降级（手工直链 → XML 降级 → 仅摘要），不阻塞全队
- **证据链条目**：每篇精读条目带证据锚点；综述只准引用素材包内的内容，并经编号校验闭环（防引用张冠李戴、数字无出处）
- **规模分档**：<6 篇走简化路径；≥6 篇走全流水线（默认）
- 运行时 node ≥ 22.13（`pdfjs-dist` 6 的要求）；提取命令依赖首次使用前在 skill 目录安装

**典型触发句**：

- "调研一下 XX 方向"
- "把这几年的文献梳理成一篇综述"
- "批量读这批文献，写个调研报告"

详见 [`skills/paper-review-writer/SKILL.md`](skills/paper-review-writer/SKILL.md)。

---

## 技术简报撰写

为某项技术（尤指物理 / 化学 / 光谱 / 仪器 / 计量学交叉域）撰写"可存档技术简报"。产出 **MD 简报 + 可选交互式 HTML 演示**双件套。跨学科通用。

**典型触发句**：

- "帮我写一个 XX 技术的技术简报，我存下来备忘"
- "看一下这篇文章用的技术，整理成档案"
- "把 XX 方法的原理 + 公式 + 应用整理一份 md"

**11 章节硬性模板**：

1. **一句话定义** → 2. **术语表** → 3. **核心技术原理**（★ 含"单一核心洞察 / 灵魂锚点"） → 4. **原理示意图**（Mermaid + 外部 SVG） → 5. **基本公式方程**（★ 含算例与适用区间） → 6. 技术变体 → 7. 数据处理算法 → 8. **典型示例应用** → 9. **⚠️ 缺点与踩坑框** → 10. **参考文献**（★ DOI 必须核实） → 11. **依赖地图**（★ 防教学法漂移）。

**markdown 顶部必填**（占位补齐，不占章节号）：① yaml formatter（文档性质 / 最后修订日期 / 作者 / 发起人 / 受众）；② §1 上方的目录。

**演示（HTML）规格**：

- 单文件自包含（HTML + JS + canvas），**离线双击可开**
- 高 DPI 适配（`devicePixelRatio`，避免物理像素累积爆炸）
- 简单交互 vanilla JS 即可；多 view 组件化用 Vue 3 CDN 引入（**不走 npm/Vite**）

**附带两个范式产品**（示范 skill 的真实产出）：

- `LTRS/` —— LTRS（光热干涉）技术简报完整示例
- `SERDS/` —— SERDS（移频激发拉曼差分）技术简报完整示例

详见 [`skills/tech-brief-writer/SKILL.md`](skills/tech-brief-writer/SKILL.md)。

---

## 目录结构

<!-- BEGIN: DIR-TREE (auto) -->
```
AI-Skills/
├── CONTRIBUTING.md        ← 仓库维护指南（SKILLS-OVERVIEW 自动渲染）
├── README.md              ← 本文件（三个自动区间）
├── LICENSE                ← 木兰宽松许可证 v2
├── skills.sh.json         ← skills.sh 网站展示配置
├── scripts/               ← 仓库级脚本（pnpm build:index 等）
└── skills/
    ├── local-kb/
    │   ├── scripts/
    │   ├── INTEGRATION_GUIDE.md
    │   ├── SKILL.md
    │   ├── package.json
    │   └── template.md
    ├── paper-methodology-audit/
    │   ├── assets/
    │   ├── references/
    │   ├── scripts/
    │   ├── tests/
    │   ├── CHANGELOG.md
    │   └── SKILL.md
    ├── paper-review-writer/
    │   ├── references/
    │   ├── scripts/
    │   ├── templates/
    │   ├── tests/
    │   ├── CHANGELOG.md
    │   ├── SKILL.md
    │   ├── package.json
    │   └── pnpm-lock.yaml
    └── tech-brief-writer/
        ├── LTRS/
        ├── SERDS/
        ├── references/
        ├── scripts/
        ├── CHANGELOG.md
        ├── SKILL.md
        ├── template.html
        └── template.md
```
<!-- END: DIR-TREE -->

---

## 兼容性

| 环境 | 是否支持 |
|---|---|
| Claude Code（`claude-code`） | ✅ 全功能（含 `allowed-tools`） |
| Cursor、Codex、Windsurf、Cline | ✅ 全功能 |
| GitHub Copilot | ✅ 基础（不含 `allowed-tools` 部分高级字段） |
| CherryStudio | ⚠️ **不直接支持**——无 `npx skills` 安装器；SKILL.md 内容可复制到 `CherryStudio/Data/Skills/<name>/`，或走「链接安装」 |
| 仅 `Claude.ai`（网页版） | ⚠️ 可上传 `.zip` 或走「链接安装」，按 Anthropic Skills API 走 |

---

## 维护约定

- **版本语义化**（SemVer）：MAJOR（破坏性改 frontmatter 或脚本接口）/ MINOR（新增章节/脚本）/ PATCH（修正错误）。
- **`description` 决定自动触发**——写得模糊的 skill 不会被 agent 自动唤起。
- **SKILL.md 是运行时注入面**：只放「何时用 + 主流程 + 红线」；版本历史进 `CHANGELOG.md`，契约与深度资料进 `references/`。
- **诚实性红线**：OCR / 自动解析的关键数值必须标 `（待核实）`；DOI 必须用 web 工具核实，不脑补。
- 增删改 skill 的完整流程、SKILL.md 编写规范、SemVer 决策表见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

---

## License

[木兰宽松许可证，第 2 版](LICENSE) © RoxSzi (SI_Cheng-Yun, 司承运)
