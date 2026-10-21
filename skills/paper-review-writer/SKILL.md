---
name: paper-review-writer
description: 批量文献调研与综述成文流水线：元数据核验→合规下载→全文提取→并行精读条目→素材包→综述写作→引用校验。当用户要求「调研某方向」「把这几年的文献梳理成一篇综述」「批量读这批文献写个综述」「做个调研报告」等主题驱动的多篇调研任务时使用。
author: RoxSzi (SI_Cheng-Yun, 司承运)
version: 0.1.2
license: MulanPSL v2
---

# 批量文献调研与综述成文

## 这个技能解决什么

调研综述的常见失效有四种：引用题录张冠李戴、把摘要当全文读、综述里的数字无出处、以及主会话直接吞全文导致上下文爆炸。本技能用一条脚本流水线把「取原文」与「读原文」分离：脚本负责核验、下载、提取与压缩，智能体只读消化后的缓冲；每篇条目带证据链，综述只准引用素材包内的内容并经编号校验闭环。

分工边界：单篇深读与逐篇方法学审查属宿主精读类技能的职责；本技能管主题驱动的批量调研项目。两类技能的条目字段命名对齐，深读产物可并轨使用。

## 0 项目规模与启动

| 档位 | 适用 | 路径 |
|---|---|---|
| 简化路径 | 少于 6 篇，或用户只要速览式梳理 | 不建完整项目：直接按第 2 节取原文，逐篇读并按第 4 节契约落条目，再走第 5 节成文 |
| 全流水线（默认） | 6 篇及以上，或用户明确要完整调研 | 按第 2–5 节完整走 |

启动前一句话申报：论文篇数、走的档位、预期产物（条目数 + 综述一篇）、可能拿不到全文的比例。用户确认清单后才开跑；清单未确认不下载、不派读。

对用户交互一律用中文含义（全文已读／部分精读／仅摘要／未获取），不念枚举值与字段名。

## 1 宿主适配表（本表是全技能唯一的工具名出处）

本技能正文一律只写「能力」，宿主工具名只允许出现在本表。迁移到新宿主时只改本表。

| 能力 | 能力要求 | 各宿主工具名（择一即可） |
|---|---|---|
| 脚本运行时 | 运行 `scripts/review.mjs` 子命令（ESM） | node ≥ 22.13（pdfjs-dist 6 的要求）或 bun；提取命令依赖 `pdfjs-dist`（首次使用前在本 skill 目录安装依赖，`npm install`／`pnpm install`／`bun install` 任一，依赖不随 skill 分发）；示例命令以 node 书写，bun 等价可跑 |
| 子会话派发 | 批量创建隔离会话、投递任务卡、按产物回收 | EasyClaw：sessions_spawn；其他宿主：等价子会话机制；无则主会话逐篇顺序处理 |
| 检索补清单 | 按主题检索论文题录生成候选清单 | 任意学术检索工具（如 Semantic Scholar / OpenAlex API / 网页检索） |
| 文献库导出 | 从宿主已有文献库导出题录清单 | 宿主文献管理能力；无则跳过 |
| 综述转 docx | 综述 MD 转交稿格式 | 宿主文档生成能力；无则交付 MD 正本 |

## 2 项目初始化与论文清单

```
node scripts/review.mjs init --project <项目目录>
```

生成固定骨架：`papers_meta.json`（论文清单，输入）、`project.json`（可选配置）、`papers/`、`papers_txt/`、`digests/`、`summaries/`、`deliverables/`。

清单 `papers_meta.json` 格式见 `templates/papers_meta.example.json`：每篇至少 `id` 与 `title`，`doi`／`pmcid`／`pmid` 能给则给（核验与下载成功率显著提高）；`kind`／`kind_zh` 是综述分组的分类键，按主题自定。清单来源三种：用户直接给、检索能力生成候选后交用户确认、宿主文献库导出。`id` 用两位编号（01、02…），综述引用就是它。

`project.json` 的 `apis.mailto` 必须配真实邮箱（公共 API 礼貌要求，假邮箱会被 Unpaywall 拒绝）；`compliance.allow_third_party` 保持 false。

## 3 流水线前半程（脚本阶段）

按顺序执行，任何一步失败先看单行错误，修输入再重跑；`download`／`extract`／`digest` 支持 `--id <编号>` 单篇重试，不整批重跑。

### 3.1 元数据核验

```
node scripts/review.mjs verify --project <项目目录>
```

四源链 Crossref → OpenAlex → Europe PMC → Unpaywall 逐篇核验：题录回填（清单已有值优先，缺才补）、无 DOI 的按题名精确补查、OA 链接发现。产物 `papers_meta.verified.json`。逐条检查核验结果：题录与用户意图不符（同名异文、年份对不上）当场修正清单再核验，不带病往下走。

### 3.2 合规下载

```
node scripts/review.mjs download --project <项目目录>
```

候选链：manual_urls → Europe PMC render → PMC → 出版商直链 → OpenAlex OA → Unpaywall；全为 OA 或已授权渠道。第三方转载渠道（Sci-Hub 类）默认关闭，仅用户显式授权才开启；授权一次只对本项目生效。产物 `papers/{id}_{slug}.pdf` + `papers/results.json`（增量合并，重试不冲掉历史成功）。

失败篇处置顺序：核对 `results.json` 里已试候选 → 用户手工给直链填 `manual_urls` 重试 `--id` → 仍失败则走 3.3 的 XML 降级 → 再失败标「仅摘要」继续，不阻塞全队。

### 3.3 提取与精读缓冲

```
node scripts/review.mjs extract --project <项目目录>
node scripts/review.mjs digest --project <项目目录>
```

extract：PDF 逐页提取为 `papers_txt/{id}.txt`（带 `===PAGE n===` 标记供定向回查）；无 PDF 且有 PMCID 的自动降级为 EPMC XML 全文（无页码，条目证据链改用章节号）。

digest：每篇压缩为 ≤2.6KB 缓冲 `digests/{id}.md`（首页 + 关键节 + 图题索引）。图题索引给出 Fig./Scheme/Table 首现页码；需要看图时按页码用宿主 PDF 阅读能力读那一页，不整本读。

规模控制：这一步之后智能体不读任何 PDF 全文；子会话只读 digest，需要细节时按页码标记回查 papers_txt。

## 4 精读条目（并行阶段）

```
node scripts/review.mjs init-summaries --project <项目目录>
```

按清单初始化全部条目模板（`read_status: missing`）。之后每篇条目的产生方式：

**有子会话能力：一次派一篇。** 任务卡要素：①输入 = `digests/{id}.md`（必读）+ `papers_txt/{id}.txt`（仅定向回查，不整读）+ digest 尾部图题索引；②任务 = 按 `references/条目字段契约.md` 填条目；③硬约束 = 只写读到的内容、证据链必填、`read_status` 按实际深度申报（只读到摘要就报仅摘要，禁止拔高）；④落盘 = `node scripts/review.mjs save --project <项目目录> --id <编号>`（stdin JSON，先落盘再返回）；⑤返回一行 = 编号、阅读深度中文含义、条目路径。

**无子会话能力：** 主会话按同一任务卡逐篇顺序处理，其余不变。

阅读深度对应读法（清单 `read_depth` 字段提示，条目按实际申报）：brief＝只读摘要（仅摘要）；targeted＝digest + 定向回查（部分精读或全文已读，按实际覆盖）；full＝通读 papers_txt 全文（全文已读）。

回收与重试：主会话按 `summaries/summary_{id}.json` 存在且 `validate` 通过判定完成；失败只重派该篇。全部完成后跑：

```
node scripts/review.mjs validate --project <项目目录>
node scripts/review.mjs brief --project <项目目录>
```

`brief` 产出每篇 ≤320 字的路由简报 `digests/brief.md`——主会话此后了解全貌只读它，不再逐条重读条目。`validate` 有 error 时回改对应条目重跑，0 error 才进第 5 节。

## 5 综述成文

### 5.1 素材包

```
node scripts/review.mjs material --project <项目目录>
```

从通过校验的条目生成 `review-material.md`（带 `[编号]` 锚点、阅读深度、证据链、首条指标；超长字段按上限裁剪）。带 error 的条目不进素材包并在包头列出——它们的问题会污染全篇综述。素材包是综述写作时数字与结论的唯一合法来源。

### 5.2 写作纪律

写综述时只准读素材包，需要复核单篇时按编号重开那一个条目。章节骨架用 `templates/review-template.md`（背景与问题、领域全景与分类、方法与技术路线、关键结果与性能对比、范式演进、局限与挑战、未来方向、对用户研究的相关点、文献映射）。硬规则：

- 每个论断后缀 `[编号]`；素材包里没有的数字禁止出现。
- 「仅摘要」的论文只可转述摘要级信息；「未获取」的不得在正文引用。
- 指标横向对比先判口径可比性（体系、条件、指标定义），不可比就写差异，不硬比大小。
- 前瞻判断与共性归纳凡超出素材包字面的，标注「（综述者判断）」。
- 「对用户研究的相关点」章节先读宿主用户信息文件取课题；无课题信息先问一句，问不到改写通用切入点并声明。

### 5.3 引用校验与交付

```
node scripts/review.mjs check --project <项目目录> --review <综述.md>
```

综述中所有 `[编号]` 必须存在于素材包（代码块与链接内的方括号自动剔除）；0 FAIL 才交付，非法引用回改。交付正本为综述 MD；用户要交稿格式时用宿主文档能力转换，转换后抽查数字与 MD 一致。收尾一行汇报说人话：几篇入库、几篇仅摘要、综述在哪、校验结论，不念内部字段名。

## 6 不要做什么

- 不在清单确认前下载或派读；不把候选清单当已确认清单。
- 不把「仅摘要」写成「全文已读」，不给不出证据链的条目放行。
- 不在综述里引用素材包外的数字，不凭印象补引用编号。
- 不开第三方转载渠道，除非用户显式授权。
- 不静默吞掉核验不符：题录对不上就停下修正，不将错就错。
- 工具失败如实申报：同一会话第一次换替代方案，第二次停手请示，不硬试第三次。
