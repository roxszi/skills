# INTEGRATION_GUIDE.md — local-kb 集成指南

> **定位**：本文件是 local-kb skill 的"集成视角"——
> - **SKILL.md** = agent 执行视角（触发判断 + 命令速查 + 反模式 + 自检清单）
> - **template.md** = Agent 接入视角（通用字段模板 + 接入流程 + SOUL 声明模板 + 通用踩坑）
> - **INTEGRATION_GUIDE.md**（本文件）= 用户 / 集成视角（架构 + 部署 + SOUL 精简 + 迁移 + 故障排查）
>
> **何时读本文件**：
> - 首次把 skill 部署到你的项目时
> - 重构现有 SOUL.md，把执行层下沉到 skill 时
> - 排查 skill 使用中的故障时
> - 迁移已有库到本 skill 时
>
> **何时不读本文件**：
> - 日常执行 setup / ingest / query / backup 时 → 看 SKILL.md
> - 接入新业务、定义 schema 时 → 看 template.md

---

## 0. 三层架构

```
┌─────────────────────────────────────────────────────────────┐
│ skill 通用执行层（不感知 Agent 业务）                          │
│  - SKILL.md        ：触发判断 + 命令速查 + 反模式 + 自检清单  │
│  - template.md     ：通用字段模板 + 接入流程 + SOUL 声明模板  │
│  - INTEGRATION_GUIDE.md（本文件）：架构 + 部署 + 迁移 + 故障   │
│  - scripts/*.ts    ：setup / clean / ingest / query / ...    │
└─────────────────────────────────────────────────────────────┘
                            ▲
                            │  Agent 在 SOUL.md 声明"我用 skill 管 X 业务"
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ Agent SOUL（业务对接层）                                      │
│  - 数据管理章节：用户意图 → skill 动作 映射                    │
│  - 业务 schema 字段速览                                       │
│  - 业务专属入库工作流（叠加在 skill 通用骨架上）                │
│  - 业务专属输出格式                                            │
│  - 业务专属回归检查                                            │
└─────────────────────────────────────────────────────────────┘
                            ▲
                            │  schema.yaml 是"业务定义"
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ <kb-path>/schema.yaml（业务定义层）                           │
│  - collection：库名 / 版本 / 主表 / 主键                       │
│  - fields.required / optional：业务字段定义                   │
│  - slug_rule：主键生成规则                                    │
│  - query_aliases：业务友好的查询别名                           │
└─────────────────────────────────────────────────────────────┘
```

**判定一条经验 / 一段内容该放哪**：

| 内容类型 | 放哪 | 判定标准 |
|---|---|---|
| 命令格式、参数约束、反模式 | SKILL.md | 其他 Agent 也会用 |
| 通用 schema 模板、接入流程、SOUL 声明模板 | template.md | 通用接入 |
| 架构、部署、SOUL 精简、迁移、故障排查 | INTEGRATION_GUIDE.md（本文件） | 集成视角 |
| "我用 skill 管理 X" + 用户意图 → 动作 映射 | Agent SOUL | Agent 业务专属 |
| 业务 schema 字段、必填项 | `<kb>/schema.yaml` | 业务定义 |
| 业务专属经验（如 ACS 抓全文、孕检报告 OCR） | Agent FACT.md | 只在 Agent 业务场景遇到 |

---

## 1. 这是什么

本 skill 把"建库 / 入库 / 反查 / 备份"等通用执行逻辑沉淀到 `scripts/*.ts` 里。
Agent 拿到 skill 后，**只需要读 SKILL.md + 跑对应脚本**，不再需要：

- 在 SOUL.md 里写 setup / ingest / query / backup 的具体步骤
- 读具体业务的 papers/ / health_records/ 文档
- 在不同业务里重复发明轮子

**scripts/*.ts 是真正的执行层**。SKILL.md 是入口说明。

---

## 2. 目录结构

```
local-kb/
├── SKILL.md              # agent 视角：触发判断 + 脚本调用 + 输出格式 + 反模式
├── template.md           # Agent 接入视角：通用字段模板 + 接入流程 + SOUL 声明模板
├── INTEGRATION_GUIDE.md  # 集成视角（本文件）：架构 + 部署 + SOUL 精简 + 迁移 + 故障
├── package.json          # bun 脚本定义
└── scripts/
    ├── setup.ts          # 首次建库
    ├── clean.ts          # 清洗（剥 script / style / 行级 nav）
    ├── ingest.ts         # 入库（meta.yaml → db）
    ├── query.ts          # 反查（field / like / fts / json / pk）
    ├── related.ts        # 关联发现（共享 journal/author/tags 的论文）
    ├── backup.ts         # 备份（WAL 模式 + mtime 排序）
    ├── db.ts             # 共享数据库访问层（PRAGMA / FTS5 / aliases）
    └── yaml.ts           # YAML 解析（含 url/path/doi 的引号兼容）
```

---

## 3. 部署到你的项目

### 3.1 复制 skill 到你的项目

```bash
# 复制整个 local-kb/ 目录到你的项目
cp -r path/to/local-kb /your-project/

# 在你的项目 package.json 里加 scripts
# 或者直接用 bun run path/to/local-kb/scripts/<script>.ts
```

### 3.2 准备 schema.yaml

复制 `template.md §3 最小可工作配置`（通用骨架），按你的业务改字段——具体业务 schema 字段定义参考各 Agent 自己的 SOUL.md 或 `<kb>/schema.yaml`。

```bash
# 跑 setup 建库（schema 字段在 fields.required / fields.optional 里定义）
bun run scripts/setup.ts ./your-kb --schema ./your-kb.schema.yaml
```

输出：
```
>>> 创建目录：./your-kb
>>> schema SQL 写入：./your-kb/.schema.sql
>>> schema created, version = v1
>>> slug rule 写入：./your-kb/.slug-rule.json
>>> README 写入：./your-kb/README.md
>>> 当前数据库状态：...
>>> 建库完成：./your-kb
```

### 3.3 开始使用

```bash
# 入库（先准备好 meta.yaml，注意字段名必须对齐 schema.yaml 白名单——见 §5 踩坑 #1）
bun run scripts/ingest.ts ./your-kb --meta ./meta.yaml

# 反查（schema.yaml 配置 query_aliases 后可用业务 flag）
bun run scripts/query.ts ./your-kb --<业务别名> <value>

# 关联
bun run scripts/related.ts ./your-kb --pk <slug>

# 备份
bun run scripts/backup.ts ./your-kb --dest D:/Backup/your-kb --keep 8
```

> 💡 **配置业务别名**：在 schema.yaml 加 `query_aliases` 节，声明常用字段对应的 flag（如 `--doi`、`--author`、`--tag`）。setup 写入 `.slug-rule.json` 后，query.ts / related.ts 的 parseArgs 会自动翻译。详见 `template.md §2`。

---

## 4. 如何精简 SOUL.md

**安装 skill 后，SOUL.md 应该大幅精简**——只保留"对接层"，具体执行交给 skill。

### 4.1 之前（SOUL.md 写得很长）

```markdown
## 触发式默认行为

- **看到用户给出文献 URL / PDF 路径 / DOI**
  → 视为"读文献"指令，自动入库到 papers/
  → fetch 全文 → clean → 人工 review → meta.yaml → slug → ingest → related → query verify → 讲解

- **看到用户说"那篇讲 X 的论文怎么说的"**
  → query --fts "X" → --read → 讲解

- **每周 / 重大改动前**
  → papers:backup --dest D:/Backup/papers --keep 8

## 关键反模式
- ❌ 不算 slug 就 mkdir
- ❌ fulltext 不清理直接入库
- ❌ mcp fetch 出来的 JSON 包装不加 --from-mcp
...
```

### 4.2 之后（SOUL.md 只剩对接层）

```markdown
## 数据管理

所有数据管理动作一律走 local-kb skill（详见 skill 模板）。本 Agent 管理 <业务名称>，库根目录 `<kb-path>/`，schema 在 `<kb-path>/schema.yaml`。

**触发映射（用户意图 → skill 动作）**：

| 用户意图 | 走 skill 哪个动作 |
|---|---|
| <建库 / 首次字段定义> | local-kb skill: setup |
| <入库数据：URL / DOI / 文件 / 用户口述> | local-kb skill: ingest（必要时先 clean） |
| <查数据：按 X / 关键词> | local-kb skill: query |
| <找关联：X 和 Y 的关系> | local-kb skill: related |
| <备份 / 周期任务> | local-kb skill: backup |

## 业务专属细节（健康档案专属，不在本 skill）

- **看到 QTc > 450ms（女）/ 440ms（男）** → 排查延长 QT 药物清单
- **看到肺结节 ≥ 6mm** → 查 Lung-RADS / Fleischner 指南
- **看到 ≥65 岁 + 苯二氮䓬类** → 查 BEERS 标准
- **看到剂量超过 FDA 推荐上限** → 立即高亮 + 推送

## SOUL 不再写

- ❌ setup / ingest / query / backup 的具体命令（已在 SKILL.md §2）
- ❌ 反模式清单（已在 SKILL.md §4 + scripts/ 直接报错）
- ❌ 工作流细节（已在 SKILL.md §3）
- ❌ meta.yaml 字段定义（已在 schema.yaml）
- ❌ 通用踩坑（已在本文件 §5）
```

### 4.3 SOUL.md 应保留的 4 类内容

| 内容类型 | 是否保留 | 放哪 |
|---|---|---|
| 数据管理章节（用户意图 → skill 动作 映射） | ✅ | SOUL §"数据管理" |
| 业务 schema 字段速览 | ✅（引用 `<kb>/schema.yaml`，不复制） | SOUL §"数据管理" |
| 业务专属工作流（在通用骨架上叠加） | ✅ | SOUL §"业务专属工作流" |
| 业务专属输出格式 | ✅ | SOUL §"输出格式" |
| 业务专属回归检查 | ✅ | SOUL §"回归检查" |
| 业务专属风险信号 / 触发条件 | ✅ | SOUL §"触发式默认行为" |
| setup / ingest / query 命令格式 | ❌ | 删（在 SKILL.md） |
| 反模式清单 | ❌ | 删（在 SKILL.md §4 + scripts/ 报错） |
| 通用踩坑 | ❌ | 删（在 INTEGRATION_GUIDE.md §5） |
| 具体业务的 schema 字段定义 | ❌ | 删（在 `<kb>/schema.yaml`） |

---

## 5. 通用踩坑（**Agent 共享**）

| # | 踩坑 | 修法 | 触发场景 |
|---|---|---|---|
| 1 | **meta.yaml 字段名不在 schema.yaml 白名单** | ingest.ts 直接 err（**约定大于配置**），列出未知字段名和 schema 合法字段名 | 入库 / 重新 ingest |
| 2 | **mcp fetch 输出是 JSON 包装**（`[{type,text}]`） | `clean.ts --from-mcp` 触发 unwrap | 抓全文后入库 |
| 3 | **Bash `[rtk]` hook 注入污染 stdin** | `clean.ts` 走文件→文件模式 | 清洗脚本 |
| 4 | **YAML 含 `:` 字符的字段必须加引号**（url / path / doi） | `url: "https://..."` | 写 meta.yaml |
| 5 | **WAL 模式下新连接看不到刚 ingest 的行** | 跑 `PRAGMA wal_checkpoint(FULL)` | ingest 后必跑 |
| 6 | **business 库实际 db 文件名 ≠ 默认 kb.db** | 必须传完整 .db 文件路径或 cd 到库目录 | query / related |
| 7 | **不跑 `--print-slug` 就 ingest** | slug 可能跟想象的目录名不一致 | 入库前必跑 |
| 8 | **重跑 ingest 不会重新插入**——DOI 不变则沿用旧 slug | 这是设计而非 bug（unique_fields 稳定性） | 重新 ingest |
| 9 | **唯一字段变更导致 slug 漂移** | unique_fields 在 schema 里固定下来不要轻易改 | schema 维护 |
| 10 | **json mode 查询必须传完整字段名**（不是别名） | `--json tags_json --value X` 不是 `--json tags --value X` | query |
| 11 | **FTS5 中文检索体验差**（unicode61 tokenizer 不分词） | 用 `--fts-like "中文关键词"`（跨字段 LIKE） | 中文查询 |
| 12 | **backup.ts 备份按字典序排**（同日多次备份 mtime 全相同） | `copyFileSync` 后必须 `utimesSync(now, now)` 刷 mtime | backup |
| 13 | **clean.ts 是启发式清理**——残留 ~10% inline JS | 人工 review 必跑 | 抓全文后入库 |
| 14 | **ACS / 反爬严出版商 fetch 报 403** | fallback 到 browser 路径（详见 Agent FACT.md） | 抓 ACS / Wiley / Elsevier / RSC 全文 |
| 15 | ~~**ingest.ts 不自动加载 fulltext_text**~~（v1.5.0 前的踩坑） | **v1.5.0 已修复**：schema 配对声明 `xxx_path` + `xxx_text(fts:true)` 后自动加载 | ~~已修复~~ |
| 16 | **query.ts --read 探测 fulltext.md / content.md / 正文.md 按需读取**（特性，非踩坑） | 即使 db 中 fts 字段为 null，--read 仍能读全文（但 FTS 不可见） | query --read |
| 17 | ~~**fulltext_path 不支持 `<slug>` 占位符**~~（v1.5.0 前的踩坑） | **v1.5.0 已修复**：path 字段自动展开 `<slug>` | ~~已修复~~ |
| 18 | **path 字段相对路径基准是 rootDir（kb 目录）**，不是 cwd（v1.5.0+） | meta.yaml 写 `<slug>/fulltext.md`，不写 `papers/<slug>/fulltext.md`（前缀会重复） | 写 meta.yaml path 字段 |
| 19 | **mock 数据无自动清理**（v1.5.0 前的踩坑） | **v1.5.0 已修复**：`--cleanup-mock` 一键清理；`--mock` 入库后输出清理命令 | 自测入库后 |
| 20 | **Windows + Git Bash 环境 `trash` 命令不可用**（违反 user 全局规则"删除必须先确认 + 优先 trash 而非 rm"） | 建仓库根 `.trash/` 目录隔离可疑产物（命名 `<原名>_WrongSlug_<yymmdd>/`）；14+ 天未出现可清理，但**物理删除必须先问用户** | slug 错算返工（如中文 member 经 `strip_nonascii` 变空 → `_checkup_1711`）/ mock 数据清理 / 临时中间产物 |

> 📌 **本节是 Agent 共享的通用踩坑**。**业务专属踩坑**（如 Agent-Chem 的 "ACS 抓全文"、Agent-Health 的 "iTextSharp PDF 处理"）应放 Agent 自己的 FACT.md。

---

## 6. 迁移已有库

如果你已有 papers/ 或 health_records/ 这种成熟库，可以：

**选项 A：直接复用 scripts**——把 `scripts/` 复制到你的项目根目录，把 hardcoded 的 `papers/papers.db` 改成参数化的 `<kb-path>/kb.db`（本 skill 已经做完了）。

**选项 B：完全用本 skill 重建**——准备好 schema.yaml（参考 `template.md §3 通用骨架` + 各 Agent 自己的 schema.yaml），跑 `scripts/setup.ts`，再批量 ingest 已有数据。

**选项 C：保留旧库，新业务用本 skill**——互不干扰。

---

## 7. 故障排查

| 错误 | 原因 | 解决 |
|---|---|---|
| `schema.yaml not found` | setup 时未指定 schema | 用 `--schema` 或 `--mock` |
| `schema version mismatch` | db 与 .schema.sql 版本不一致 | 跑 migrate 脚本（待实现）或删除 db 重 setup |
| `meta.yaml 缺少必填字段: <name>` | meta.yaml 缺字段 | 补齐 meta.yaml |
| `meta.yaml contains unknown field(s): <name>` | meta.yaml 字段名不在 schema.yaml 白名单（**约定大于配置**） | 对照 schema.yaml 的 `fields.required` / `fields.optional` 后修正 meta.yaml |
| `>>> 警告：xxx_path=... 文件不存在`（v1.5.0+） | meta.yaml 的 path 字段指向的文件不存在 | 检查路径是否正确（相对 rootDir 解析）；或接受 xxx_text 为 null |
| FTS 搜不到某条记录但 --read 能读 | db 中 fts 字段为 null（meta.yaml 未显式提供，且自动加载失败/未配置） | schema 配对声明 path+text 后重 ingest（v1.5.0+ 自动加载） |
| meta.yaml 改了但 db 数据落后 | 旧版静默忽略未知字段；改后没重新 ingest | 重新 ingest；v1.5.0+ 跑 audit.ts 对账（计划中） |
| `无法生成 slug` | slug_rule 必需字段都为空 | 检查 meta.yaml |
| `未找到 FTS5 虚拟表` | 库没启用 FTS5 | schema.yaml 里至少有一个字段标 `fts: true` |
| backup 失败 `checkpoint busy=1` | 其他连接在写 | 关闭其他连接后重试 |
| `EBUSY: resource busy or locked`（删 .db-shm/.db-wal 时） | Windows mmap 锁 | `tryRemove()` 重试 5 次，延迟 80+i*60ms |

---

## 8. 版本演进

| 版本 | 日期 | 关键变化 |
|---|---|---|
| 0.1.0 | 2026-07-08 | 初版：基于 papers/ + health_records/ 提炼的"通用方法论"——**错误方向** |
| 0.2.0 | 2026-07-08 | 改为"agent 直接照做的 Markdown 工作流"——**仍然错误**，没有 scripts |
| 1.0.0 | 2026-07-08 | **真正重构**：补全 7 个 ts 脚本（setup/ingest/query/related/clean/backup/db），SKILL.md 只剩脚本调用入口 |
| 1.2.0 | 2026-07-09 | **功能更新**：多项兼容性更新 |
| 1.3.0 | 2026-07-10 | **业务别名（query_aliases）**：schema.yaml 声明业务别名，脚本运行时自动翻译 |
| **1.4.0** | **2026-07-10** | **架构重构**：新增 `template.md` 通用接入指南 + `INTEGRATION_GUIDE.md` 集成指南；ingest.ts 加 meta.yaml 字段名严格校验（约定大于配置） |
| **1.5.0** | **2026-07-10** | **执行器增强**（基于 papers 库 audit 发现）：ingest.ts 加 path/text 自动配对加载 + `<slug>` 占位符展开 + `--print-slug` 预校验 + `--cleanup-mock` 子命令 + mock yaml 字段名修正；template.md §7.1 path/text 配对说明；INTEGRATION_GUIDE.md §5 踩坑 #15-#19（部分转为特性）+ §7 故障排查 |
| **1.5.1** | **2026-07-10** | **对账脚本**：新增 `scripts/audit.ts`（5 维度只读对账 + JSON 输出 + 退出码语义）；ingest.ts 导出 `loadSchema` / `loadSlugRule` / `loadMetaYaml` / `generateSlug` / `validateMeta` + 类型（`SchemaYaml` / `SlugRule` / `MetaYaml`）供 audit.ts 复用；ingest.ts 入口点加 `import.meta.main` 保护（避免被 import 时触发）；SKILL.md §1 触发表 + §2.7 audit 命令文档 + §4 反模式 #13 修订 + §6 自检清单加 audit 章节 |
| **1.5.1** | **2026-07-11** | **yaml.ts**：修复场景：`key` 内部含 `- item` 或 `nested_key: value` 行时，旧逻辑会进入 listMatch/kvMatch 分支，把已赋好的字符串值覆盖为 array/object。 |
