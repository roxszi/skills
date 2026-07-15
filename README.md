# 一些自创的skills

> AI 编程 agent 可调用的 skills 集合。覆盖**本地知识库管理**、**OCR 工具链**、**技术简报撰写**三大场景。
> 
> 通过 `npx skills add` 一键安装到 Claude Code、Cursor、Codex、Windsurf、Cline 等 60+ 编程 agent。

[![License: MulanPSL v2](https://img.shields.io/badge/License-MulanPSL%20v2-blue.svg)](LICENSE)

---

## Skills 总览

<!-- BEGIN: SKILLS-TABLE (auto) -->
| Skill | 版本 | 触发一句话 | 依赖 |
|---|---|---|---|
| [`local-kb`](#本地信息资源数据库) | 1.5.2 | "本地信息资源数据库的统一执行入口" | bun |
| [`ocr-toolkit`](#ocr-工具箱) | 1.0.2 | "OCR 工具选型与流水线构建" | python |
| [`tech-brief-writer`](#技术简报撰写) | 3.11.0 | "技术简报撰写" | — |
<!-- END: SKILLS-TABLE -->

---

## 一键安装

```bash
# 安装全部 skill
npx skills add roxszi/skills

# 按需安装单个
npx skills add roxszi/skills --skill local-kb
npx skills add roxszi/skills --skill ocr-toolkit
npx skills add roxszi/skills --skill tech-brief-writer

# 全局安装（影响 ~/.claude/skills/ 等，而非项目内）
npx skills add roxszi/skills --skill local-kb -g -a claude-code

# 列出现有 skill，不安装
npx skills add roxszi/skills --list
```

支持的 agent：`claude-code`、`cursor`、`codex`、`windsurf`、`cline`、`gemini-cli`、`opencode` 等共 60+（详见 [vercel-labs/skills](https://github.com/vercel-labs/skills)）。

> 仓库主同步源：[AtomGit](https://atomgit.com)（自动镜像到 GitHub）。两边的 `owner/repo` 路径不同，**GitHub 上的安装命令才是这条 README 的最终值**。

---

## 本地信息资源数据库

本地知识库的统一执行入口。给文献、健康档案、项目档案、联系人档案、会议纪要等"长期累积 + 检索 + 反查 + 备份"场景用。

**典型触发句**：

- "建一个本地文献库" / "做一个家人健康档案"
- "存一下这篇 Z" / "查一下我的 W"
- "X 和 Y 有什么关系" / "类似的还有什么"
- "备份"

**6 个执行子命令**（Bun 运行时）：

| 子命令 | 用途 |
|---|---|
| `setup.ts` | 用 `schema.yaml` 首次建库（幂等 + 版本校验） |
| `clean.ts` | 清洗原始输入（支持 stdin / MCP fetch 解包） |
| `ingest.ts` | 入库一条记录（slug 唯一、自带查重） |
| `query.ts` | 主键 / 字段精确 / LIKE / FTS5 全文检索 |
| `related.ts` | 关联发现（基于 schema.yaml 的 `related: true` 字段） |
| `backup.ts` | 备份到隔离目录，按 mtime 滚动保留 8 份 |

**关键能力**：

- 双重唯一性：DOI 等关键字段自动去重，重复入库沿用旧 slug
- 已知 vs 待核实泾渭分明（拒绝未核实的 OCR / 自动解析数据混入已知）
- 反模式直接报错（不算 slug 就 mkdir、配置缺字段、库目录非空就 setup 等）

详见 [`skills/local-kb/SKILL.md`](skills/local-kb/SKILL.md)。

---

## OCR 工具箱

中文 OCR + PDF 扫描件 + 科研文献 / 体检报告 / 病历 / 发票等场景。基于 Python `rapidocr-onnxruntime` + `pymupdf` + `pdfplumber`。

**典型触发句**：

- "帮我 OCR 一下这份体检报告"
- "把扫描件转成文字"
- "PDF 文字识别 / 提取"
- "批量识别图片中的文字"
- "识别这张化验单"

**默认推荐栈**（2026-07 当前）：**Python 端完整流水线**

```
PDF → pymupdf 判定有无文本层
       ├─ 有 → pdfplumber.extract_text()（CER ≈ 0%, < 0.1s）
       └─ 无 → pymupdf 渲染 200 DPI → rapidocr-onnxruntime 推理（端到端 ~2s）
```

**附带产物**：

- `scripts/python_ocr_pipeline.py` — 通用流水线（TXT + JSON + Markdown 三件套输出）
- `scripts/pdf_render.py` — 200 DPI 渲染（独立可复用）
- `scripts/requirements.txt` — 三个 pip 包：`rapidocr-onnxruntime==1.4.4` + `pymupdf>=1.24` + `pdfplumber>=0.11`
- `notes/known_issues.md` — 10 条踩坑笔记
- `notes/domestic_mirrors.md` — 国内源配置（清华 pip / npm npmmirror）
- `notes/key_fields_extraction.md` — 卡号 / 电话 / 日期等关键字段正则
- `test/output/体检报告_视觉筛查.*` — 一份完整样本（md + json + txt + png）

详见 [`skills/ocr-toolkit/SKILL.md`](skills/ocr-toolkit/SKILL.md)。

---

## 技术简报撰写

为某项技术（尤指物理 / 化学 / 光谱 / 仪器 / 计量学交叉域）撰写"可存档技术简报"。产出 **MD 简报 + 可选交互式 HTML 演示**双件套。

**典型触发句**：

- "帮我写一个 XX 技术的技术简报，我存下来备忘"
- "看一下这篇文章用的技术，整理成档案"
- "把 XX 方法的原理 + 公式 + 应用整理一份 md"

**13 章节硬性模板**（含依赖地图、参考文献独立章节、诚实性红线）：

1. **一句话定义** → 2. **核心技术原理**（★ 含"单一核心洞察 / 灵魂锚点"） → 3. **原理示意图**（Mermaid + 外部 SVG） → 4. **基本公式方程**（★ 含算例与适用区间） → 5. 技术变体 → 6. **数据处理算法** → 7. **典型示例应用** → 8. ⚠️ 踩坑框 → 9. 优缺点 → 10. **参考文献**（★ DOI 必须核实） → 11. 记忆口诀 → 12. **溯源脚注** → 13. **依赖地图**（★ 防教学法漂移）。

**markdown 顶部必填**（占位补齐，不占章节号）：① yaml formatter（文档性质 / 最后修订日期 / 作者 / 发起人）；② §1 上方的目录；③ 末尾第 13 章依赖地图。

**配套细化规范**（`SKILL.md` §三 子节）：

- §三·3.1 公式撰写四要素（公式本体 / 符号说明 / 数值例子 / 适用条件）
- §三·3.2 参考文献规范（DOI 核实 + 分类排列）
- §三·3.3 SVG 文件管理（外置 `assets/` + 字体兜底 + viewBox 三件套）
- §三·3.4 **技术依赖处理规则（避免教学法漂移）**——每个简报 B 依赖 ≤ 10% 篇幅，末尾必须询问而非默认展开
- §三·3.5 Mermaid 踩坑清单（Dirac 符号 / 箭头白名单 / `<br/>` 引号）

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
skills/
├── LICENSE                      # 木兰宽松许可证 v2
├── README.md                    # 本文件（自动渲染 Skills 总览）
├── AGENTS.md                    # 仓库维护者指南（自动渲染仓库概述）
├── .gitignore
├── scripts/                     # 仓库级脚本（pnpm build:index 等）
└── skills/
    ├── local-kb/
    │   ├── scripts/
    │   ├── INTEGRATION_GUIDE.md
    │   ├── SKILL.md
    │   ├── package.json
    │   └── template.md
    ├── ocr-toolkit/
    │   ├── notes/
    │   ├── scripts/
    │   ├── README.md
    │   └── SKILL.md
    └── tech-brief-writer/
        ├── LTRS/
        ├── SERDS/
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
| CherryStudio | ⚠️ **不直接支持**——CherryStudio 没有 `npx skills` 兼容的安装器，但 `SKILL.md` 内容可直接复制到 `CherryStudio/Data/Skills/<name>/` 用 |
| 仅 `Claude.ai`（网页版） | ⚠️ 可上传 `.zip`（含 SKILL.md + 附属文件），按 Anthropic Skills API 走 |

---

## 维护约定

- **版本语义化**（SemVer）：MAJOR（破坏性改 frontmatter 或脚本接口）/ MINOR（新增章节/脚本）/ PATCH（修正错误）。
- **`description` 决定自动触发**——写得模糊的 skill 不会被 agent 自动唤起。
- **SKILL.md 控制 500 行内**——长内容进 `notes/` 或子文件，链接引用。
- **诚实性红线**：OCR / 自动解析的关键数值必须标 `（待核实）`；DOI 必须用 web 工具核实，不脑补。
- **依赖地图**：所有用到的核心库 / 工具写进各自 `references/` 或 README，不在 SKILL.md 里堆叠。

---

## License

[木兰宽松许可证，第 2 版](LICENSE) © RoxSzi (SI_Cheng-Yun, 司承运)
