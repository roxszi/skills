# temp-template.md — local-kb skill 通用接入指南（草稿 v1）

> **定位**：Agent 接入 local-kb skill 的通用指导。任何 Agent 读完后应能：
> 1. 理解本 skill 的三层架构（通用执行层 / 业务对接层 / 业务定义层）
> 2. 按"标准接入流程"完成建库 + SOUL 声明
> 3. 把业务专属内容叠加在通用骨架上
>
> **不指定业务**：本文件不含"学术文献 / 健康档案 / 项目"等具体业务模板。具体业务定义由 Agent 自己写进 `schema.yaml` 或 SOUL。
>
> **本文件来源**：从 `C:/Users/siche/AppData/Roaming/CherryStudio/Data/Skills/local-kb/template.md`（437 行）重组精简——保留通用部分，删除 6 种业务示例，新增 Agent 接入流程。
>
> **状态**：v1 草稿，待用户拍板后整合到 skill 正式 template.md（或改名 / 分拆）。

---

## 0. 三层架构（**先理解再动手**）

```
┌─────────────────────────────────────────────────────────────┐
│ skill 通用执行层（不感知 Agent 业务）                          │
│  - SKILL.md        ：触发判断 + 命令速查 + 反模式 + 自检清单  │
│  - template.md     ：通用 schema 模板 + 接入流程（本文件）    │
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
                            │  schema.yaml 是"业务定义"，不是"Agent 声明"
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
| 命令格式、参数约束、反模式 | skill SKILL.md | 其他 Agent 也会用 |
| 字段类型、transform 语法、必填原则 | skill template.md（本文件） | 通用 schema 设计 |
| "我用 skill 管理化学文献" + 用户意图 → 动作 映射 | Agent SOUL | Agent 业务专属 |
| 业务 schema 字段、必填项 | `<kb>/schema.yaml` | 业务定义 |
| 业务专属经验（如 ACS 抓全文、孕检报告 OCR） | Agent FACT.md | 只在 Agent 业务场景遇到 |

---

## 1. 通用字段类型与修饰符

### 1.1 字段类型

```yaml
types:
  string        # TEXT
  int | integer # INTEGER
  number        # REAL
  text          # TEXT（大文本）
  iso8601       # TEXT（ISO 8601 日期字符串）
  date          # TEXT（YYYY-MM-DD）
  path          # TEXT（文件路径）
  boolean       # INTEGER (0/1)
  string[]      # TEXT NOT NULL DEFAULT '[]'（JSON 数组）
```

### 1.2 修饰符

```yaml
modifiers:
  unique: true    # UNIQUE 约束 + 自动建索引
  indexed: true   # 建索引（无 UNIQUE）
  fts: true       # 加入 FTS5 虚拟表 + 触发器同步
  json: true      # 该字段是 string[]，值以 JSON 字符串存储
  related: true   # 该字段参与 related.ts 的默认关联发现
```

---

## 2. 业务别名 query_aliases

业务方可选地在 `schema.yaml` 里声明 `query_aliases` 节，让 SOUL / Agent / 用户能用业务友好的 flag（`--doi`、`--author`、`--tag`、`--year` 等）替代通用命令。skill 脚本的 parseArgs 会自动翻译成对应的 `--field` / `--like` / `--json` / `--pk` 等模式。

```yaml
query_aliases:
  - { name: doi,    field: doi,          mode: field }    # --doi X     →  --field doi --value X
  - { name: slug,                        mode: pk }       # --slug X    →  --pk X
  - { name: author, field: first_author, mode: like }     # --author X  →  --like first_author --value X
  - { name: tag,    field: tags,         mode: json }     # --tag X     →  --json tags --value X
```

| mode | 行为 | 必填 field |
|---|---|---|
| `field` | 精确匹配 | ✅ |
| `like` | 模糊匹配（自动加 `%X%`） | ✅ |
| `json` | JSON 数组成员匹配（自动加 `%"X"%`） | ✅ |
| `pk` | 直接当主键 | ❌ |
| `fts-like` | 跨 FTS 字段 LIKE（中文友好） | ❌ |
| `fts` | FTS5 BM25（英文友好） | ❌ |

**设计原则**：
- **完全向后兼容**——不配置 `query_aliases` 等同于通用版本，纯通用模式 `--field` / `--like` / `--json` / `--pk` 永远可用
- **配置在 schema.yaml 而非脚本里**——skill 脚本不感知任何业务字段
- **related.ts 也支持**——给别名时，related 会先按 alias 查主键，再走关联逻辑

---

## 3. 最小可工作配置（**通用骨架，不指定业务**）

```yaml
collection:
  name: <kb-name>
  schema_version: 1
  primary_table: items
  primary_key: slug

fields:
  required:
    - { name: title,         type: string }
    - { name: first_author,  type: string }    # Agent 可改名（如 owner / member / name）
    - { name: year,          type: int }       # Agent 可删（如健康档案无 year）
    - { name: fetched_at,    type: iso8601 }
  optional:
    - { name: doi,           type: string, unique: true }   # Agent 可改名（如 email / lot_number）
    - { name: tags,          type: "string[]", json: true }
    - { name: abstract,      type: text, fts: true }        # Agent 可改名（如 notes / content）
    - { name: fulltext,      type: text, fts: true }

slug_rule:
  parts:
    - { field: first_author, transform: "lower+strip_nonascii" }
    - { field: year }
    - { field: title,        transform: "lower+strip_nonascii+split_space+slice_words(4)+join_underscore" }
  separator: "_"
  unique_fields: [doi]
```

**注意**：上面只是**最小骨架**——具体业务应该：
- **必填字段**：按业务核心主体调整（健康档案必填 member / record_type；项目必填 owner / status；联系人必填 name / organization）
- **唯一字段**：按业务唯一标识调整（文献用 DOI；联系人用 email；台账用 lot_number）
- **fts 字段**：按业务搜索需求调整（见 §7）

---

## 4. slug_rule 的 transform 语法

每个 `parts` 元素：

```yaml
- { field: <meta.yaml 字段名>, transform: "<链式操作>" }
```

支持的 transform（用 `+` 连接，按顺序执行）：

| 操作 | 输入 | 输出 | 说明 |
|---|---|---|---|
| `lower` | string | string | `toLowerCase()` |
| `strip_nonascii` | string | string | 去非 a-z0-9 字符（含变音符号、连字符、冒号） |
| `slice(N)` | string | string | 截前 N 字符 |
| `split_space` | string | string[] | 按空格分词 |
| `slice_words(N)` | string[] | string[] | 取前 N 词 |
| `join_underscore` | string[] | string | 下划线连接 |

**示例**：
```yaml
# "Mayerhöfer" → "mayerhfer"
- { field: first_author, transform: "lower+strip_nonascii" }

# "Analytical Chemistry" → "analyticalch"
- { field: journal, transform: "lower+strip_nonascii+slice(12)" }

# "SERS Detection of Dopamine on Ag" → "sers_detection_of_dopamine"
- { field: title, transform: "lower+strip_nonascii+split_space+slice_words(4)+join_underscore" }
```

---

## 5. unique_fields 稳定性

如果某字段是"唯一标识"（DOI / email / 身份证 / 批号），在 ingest 时：

- 命中（db 里已有同字段值的记录）→ **沿用旧主键**，做 INSERT OR REPLACE
- 未命中 → 用新算的 slug 做 INSERT

这样即使 title 微调，DOI 不变时主键也不会漂移。

```yaml
unique_fields: [doi]         # 文献
unique_fields: [email]       # 联系人
unique_fields: [lot_number]  # 试剂
unique_fields: []            # 项目 / 笔记等通常无唯一字段
```

---

## 6. 必填字段选择原则（**通用原则，不指定业务**）

| 业务属性 | 必填字段设计原则 |
|---|---|
| **主体可定位** | 至少 1 个能唯一标识主体的字段（如文献 title+first_author+year；健康档案 member+record_type+title） |
| **时间锚点** | `fetched_at` 几乎必填——入库时间用于排序和审计 |
| **状态字段** | 有"工作流"的业务（项目 active/paused/completed；健康 risk_grade）必填 |
| **少量原则** | 必填字段 ≤ 5 个——多了用户填写负担大；少了入库数据质量差 |
| **业务强约束** | "唯一标识 + 状态 + 时间"是 3 个几乎必填的核心 |

---

## 7. fts 字段选择原则（**通用原则，不指定业务**）

FTS5 全文检索会让 db 体积略大、写入稍慢。**只对真正需要搜的字段开 fts**：

| 字段类型 | 是否开 fts | 理由 |
|---|---|---|
| 长文本（abstract / notes / content / fulltext） | ✅ | 全文检索是主要查询方式 |
| 标题 | ❌ | 精确查或 LIKE 即可 |
| 枚举值（status / type / risk_grade） | ❌ | field / like 查更高效 |
| 标签数组（tags / diagnosis） | ❌ | json mode 查 |

---

## 8. Agent 接入 skill 的标准流程（**核心新增**）

### 8.1 第一步：定义业务 schema.yaml

基于 §1-§7 的通用原则，定义你的业务 schema：

1. **确定业务主体**：管什么？（文献 / 健康 / 项目 / 联系人 / 笔记 / 台账 / 自定义）
2. **列出核心字段**：必填 + 唯一 + 时间锚点
3. **设计 slug_rule**：用哪些字段生成主键
4. **配置 query_aliases**：业务友好的查询 flag
5. **跑 schema 自检**（§10）

### 8.2 第二步：建库

```bash
bun run <skill>/scripts/setup.ts <kb-path> --schema <kb-path>/schema.yaml
```

### 8.3 第三步：SOUL.md 声明使用 skill

**直接复制 §9 的 SOUL 声明模板**，按你的业务填：

1. 数据管理章节（用户意图 → skill 动作 映射）
2. 业务 schema 字段速览
3. 业务专属入库工作流（在通用骨架上叠加）
4. 业务专属输出格式
5. 业务专属回归检查

### 8.4 第四步：业务专属章节叠加

通用骨架：
- setup → ingest → query → related → backup

业务专属叠加示例（**Agent 自己填**，以下是化学文献场景）：

```markdown
### 业务专属入库工作流（化学文献场景）

通用骨架：setup → ingest → query → related → backup

化学文献专属叠加：
1. fetch 全文
   - 试 mcp fetch_markdown（机构订阅可用时直接成功）
   - 403 fallback 到 browser 路径
2. clean.ts 清理（走文件→文件模式，绕开 rtk stdin 污染）
3. 人工 review（必跑 — clean.ts 是启发式清理）
4. 写 meta.yaml（字段名必须对齐 schema.yaml）
5. print-slug + ingest + WAL checkpoint
6. related 找关联 + 按业务输出格式讲解
```

---

## 9. SOUL.md 声明模板（**核心新增，直接复制粘贴**）

把下面整段复制到 Agent 的 SOUL.md，按需修改：

```markdown
## N. 数据管理（走 local-kb skill）

所有数据管理动作一律走 local-kb skill（详见 skill 模板）。本 Agent 管理 <业务名称>，库根目录 `<kb-path>/`，schema 在 `<kb-path>/schema.yaml`。

**触发映射（用户意图 → skill 动作）**：

| 用户意图 | 走 skill 哪个动作 |
|---|---|
| <建库 / 首次字段定义> | local-kb skill: setup |
| <入库数据：URL / DOI / 文件 / 用户口述> | local-kb skill: ingest（必要时先 clean） |
| <查数据：按 X / 关键词> | local-kb skill: query |
| <找关联：X 和 Y 的关系> | local-kb skill: related |
| <备份 / 周期任务> | local-kb skill: backup |

**业务 schema 字段速览**：见 `<kb-path>/schema.yaml` 的 `fields` 节。

**反模式**：
- ❌ 绕过 skill 在工作区下另建数据库管理脚本
- ❌ 直接 `bun run` skill 脚本（除非确认临时调试）
- ❌ 写临时 markdown 替代库管理
- ❌ meta.yaml 字段名不在 schema.yaml 白名单（ingest.ts 会直接 err）
```

---

## 10. 通用回归检查（**Agent 在此基础上叠加业务专属项**）

### 10.1 setup 完成

- [ ] 库目录已建，且只包含预期文件（README.md / schema.yaml / .schema.sql / .slug-rule.json / kb.db）？
- [ ] `scripts/backup.ts <kb-path>` 能跑通？
- [ ] `scripts/query.ts <kb-path> --all` 能列出（空）表？

### 10.2 ingest 完成

- [ ] 来源已 clean（如适用）？
- [ ] meta.yaml 字段名对齐 schema.yaml（**约定大于配置**——未对齐直接 err，不是 warn）？
- [ ] slug 已先 `--print-slug` 再 ingest？
- [ ] 唯一字段查重（DOI / email / 身份证等）？
- [ ] WAL checkpoint 已跑（防新连接看不到刚 ingest 的行）？
- [ ] 已按业务输出格式讲解？
- [ ] 回归检查：`grep -E "❓|待核实|未知|____" meta.yaml` 无命中？

### 10.3 query 完成

- [ ] 匹配模式选对（精确 / LIKE / FTS / JSON）？
- [ ] 命中后 `--read` 读全文（不是只看标题）？
- [ ] 已按业务输出格式讲解？

### 10.4 backup 完成

- [ ] 输出含 `>>> backup OK` + size + verify？
- [ ] mtime 已刷（防同日多次备份排序退化为字典序）？
- [ ] 备份目录与库物理隔离（不同磁盘）？

---

## 11. 通用踩坑 / 经验（**Agent 共享，所有用本 skill 的 Agent 必读**）

| # | 踩坑 | 修法 | 触发场景 |
|---|---|---|---|
| 1 | **meta.yaml 字段名不在 schema.yaml 白名单** | ingest.ts 直接 err（**约定大于配置**） | 入库 / 重新 ingest |
| 2 | **mcp fetch 输出是 JSON 包装**（`[{type,text}]`） | `clean.ts --from-mcp` 触发 unwrap | 抓全文后入库 |
| 3 | **Bash `[rtk]` hook 注入污染 stdin** | `clean.ts` 走文件→文件模式 | 清洗脚本 |
| 4 | **YAML 含 `:` 字符的字段必须加引号**（url / path / doi） | `url: "https://..."` | 写 meta.yaml |
| 5 | **WAL 模式下新连接看不到刚 ingest 的行** | 跑 `PRAGMA wal_checkpoint(FULL)` | ingest 后必跑 |
| 6 | **business 库实际 db 文件名 ≠ 默认 kb.db** | 必须传完整 .db 文件路径或 cd 到库目录 | query / related |
| 7 | **不跑 `--print-slug` 就 ingest** | slug 可能跟想象的目录名不一致 | 入库前必跑 |
| 8 | **重跑 ingest 不会重新插入**——DOI 不变则沿用旧 slug | 这是设计而非 bug | 重新 ingest |
| 9 | **唯一字段变更导致 slug 漂移** | unique_fields 在 schema 里固定下来不要轻易改 | schema 维护 |
| 10 | **json mode 查询必须传完整字段名**（不是别名） | `--json tags_json --value X` 不是 `--json tags --value X` | query |
| 11 | **FTS5 中文检索体验差**（unicode61 tokenizer 不分词） | 用 `--fts-like "中文关键词"`（跨字段 LIKE） | 中文查询 |

---

## 12. 与 SKILL.md / README.md 的引用关系

| 本文件章节 | 对应 skill 文件章节 |
|---|---|
| §0 三层架构 | SKILL.md §0（待补） / README.md（待写） |
| §1 字段类型 / 修饰符 | db.ts / yaml.ts 实现 |
| §2 query_aliases | db.ts loadAliases / setup.ts generateSlugRuleJson / query.ts + related.ts parseArgs |
| §3 最小配置 | SKILL.md §2.1 |
| §4 transform 语法 | setup.ts / ingest.ts |
| §5 unique_fields | ingest.ts 唯一字段稳定性逻辑 |
| §6 必填原则 | ingest.ts 校验逻辑 |
| §7 fts 原则 | db.ts searchFts / setup.ts FTS5 表生成 |
| §8 接入流程 | SKILL.md §1 触发判断（重写为更清晰） |
| §9 SOUL 声明模板 | 无（新增） |
| §10 回归检查 | SKILL.md §6 |
| §11 踩坑 / 经验 | 无（新增） |
| §12 引用关系 | 本节 |

> 📌 **改本文件时同步检查 SKILL.md / README.md / scripts/**——三者必须一致。

---

## 13. 元说明（仅给本次重构审阅用）

**本文件 vs 现有 skill/template.md 的关系**：

| 现有 skill/template.md 章节 | 处理 |
|---|---|
| §0 字段类型与修饰符 | → 本文件 §1（保留） |
| §0.5 业务别名 | → 本文件 §2（保留） |
| §1 最小可工作配置 | → 本文件 §3（保留骨架，去业务色彩） |
| §2.1-2.6 不同业务示例（文献 / 健康 / 项目 / 联系人 / 笔记 / 台账） | **删除**——业务定义由各 Agent 写在自己的 schema.yaml |
| §3 transform 语法 | → 本文件 §4（保留） |
| §4 unique_fields 稳定性 | → 本文件 §5（保留） |
| §5 必填字段选择原则 | → 本文件 §6（保留并改写为通用原则，不列举业务） |
| §6 fts 字段选择原则 | → 本文件 §7（保留并改写为通用原则） |
| §7 schema 自检清单 | → 本文件 §10 通用回归检查（合并） |
| §8 引用关系 | → 本文件 §12（保留并改写） |
| **新增** | → 本文件 §0 三层架构 / §8 接入流程 / §9 SOUL 声明模板 / §11 通用踩坑 |
