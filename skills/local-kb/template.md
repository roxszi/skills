# 本地信息资源数据库 schema.yaml 模板

> **Agent 使用说明**：本文件是 agent 在 setup 时复制填空的 schema.yaml 模板。
>
> 业务流程：
> 1. 用户首次说"建一个 X 库" → agent 与用户明确字段定义
> 2. agent 复制本文件的最小可工作配置 → 改字段 → 命名为 `<kb-name>.schema.yaml`
> 3. 跑 `bun run scripts/setup.ts <kb-path> --schema <schema.yaml>` 建库

---

## 0. 字段类型与修饰符

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

modifiers:
  unique: true    # UNIQUE 约束 + 自动建索引
  indexed: true   # 建索引（无 UNIQUE）
  fts: true       # 加入 FTS5 虚拟表 + 触发器同步
  json: true      # 该字段是 string[]，值以 JSON 字符串存储
```

---

## 1. 最小可工作配置

```yaml
collection:
  name: <kb-name>
  schema_version: 1
  primary_table: items
  primary_key: slug

fields:
  required:
    - { name: title,         type: string }
    - { name: first_author,  type: string }
    - { name: year,          type: int }
    - { name: fetched_at,    type: iso8601 }
  optional:
    - { name: doi,           type: string, unique: true }
    - { name: tags,          type: "string[]", json: true }
    - { name: abstract,      type: text, fts: true }
    - { name: fulltext,      type: text, fts: true }

slug_rule:
  parts:
    - { field: first_author, transform: "lower+strip_nonascii" }
    - { field: year }
    - { field: journal,      transform: "lower+strip_nonascii+slice(12)" }
    - { field: title,        transform: "lower+strip_nonascii+split_space+slice_words(4)+join_underscore" }
  separator: "_"
  unique_fields: [doi]
```

---

## 2. 不同业务的 schema.yaml 示例

### 2.1 学术文献库

```yaml
collection:
  name: papers
  schema_version: 1
  primary_table: items
  primary_key: slug

fields:
  required:
    - { name: title,         type: string }
    - { name: first_author,  type: string, related: true }
    - { name: year,          type: int }
    - { name: fetched_at,    type: iso8601 }
  optional:
    - { name: doi,           type: string, unique: true }
    - { name: journal,       type: string, indexed: true, related: true }
    - { name: volume,        type: int }
    - { name: issue,         type: int }
    - { name: pages,         type: string }
    - { name: url,           type: string }
    - { name: tags,          type: "string[]", json: true, related: true }
    - { name: abstract,      type: text, fts: true }
    - { name: fulltext,      type: text, fts: true }
    - { name: notes,         type: text }

slug_rule:
  parts:
    - { field: first_author, transform: "lower+strip_nonascii" }
    - { field: year }
    - { field: journal,      transform: "lower+strip_nonascii+slice(12)" }
    - { field: title,        transform: "lower+strip_nonascii+split_space+slice_words(4)+join_underscore" }
  separator: "_"
  unique_fields: [doi]
```

### 2.2 家人健康档案

```yaml
collection:
  name: health_records
  schema_version: 1
  primary_table: items
  primary_key: slug

fields:
  required:
    - { name: member,        type: string, related: true }     # 妈妈 / 爸爸 / 用户本人 / ...
    - { name: record_type,   type: string, related: true }     # medication / diagnosis / checkup / vaccine / ...
    - { name: title,         type: string }
    - { name: fetched_at,    type: iso8601 }
  optional:
    - { name: dose,          type: string }     # 剂量（精确，不写"待核实"）
    - { name: frequency,     type: string }     # 频次
    - { name: start_date,    type: date }
    - { name: end_date,      type: date }
    - { name: prescriber,    type: string }
    - { name: diagnosis,     type: "string[]", json: true, related: true }
    - { name: notes,         type: text, fts: true }
    - { name: risk_grade,    type: string }     # red / orange / yellow / green

slug_rule:
  parts:
    - { field: member,       transform: "lower+strip_nonascii" }
    - { field: record_type,  transform: "lower+strip_nonascii" }
    - { field: title,        transform: "lower+strip_nonascii+split_space+slice_words(4)+join_underscore" }
  separator: "_"
  unique_fields: []
```

### 2.3 项目档案库

```yaml
collection:
  name: projects
  schema_version: 1
  primary_table: items
  primary_key: slug

fields:
  required:
    - { name: title,         type: string }
    - { name: owner,         type: string, related: true }
    - { name: status,        type: string }     # active / paused / completed
    - { name: fetched_at,    type: iso8601 }
  optional:
    - { name: start_date,    type: date }
    - { name: deadline,      type: date }
    - { name: tags,          type: "string[]", json: true, related: true }
    - { name: notes,         type: text, fts: true }

slug_rule:
  parts:
    - { field: owner,        transform: "lower+strip_nonascii" }
    - { field: title,        transform: "lower+strip_nonascii+split_space+slice_words(4)+join_underscore" }
  separator: "_"
  unique_fields: []
```

### 2.4 联系人 / 客户档案

```yaml
collection:
  name: contacts
  schema_version: 1
  primary_table: items
  primary_key: slug

fields:
  required:
    - { name: name,          type: string }
    - { name: organization,  type: string, related: true }
    - { name: fetched_at,    type: iso8601 }
  optional:
    - { name: role,          type: string }
    - { name: email,         type: string, unique: true }
    - { name: phone,         type: string }
    - { name: last_contact,  type: date }
    - { name: tags,          type: "string[]", json: true, related: true }
    - { name: notes,         type: text, fts: true }

slug_rule:
  parts:
    - { field: organization, transform: "lower+strip_nonascii+slice(12)" }
    - { field: name,         transform: "lower+strip_nonascii" }
  separator: "_"
  unique_fields: [email]
```

### 2.5 学习笔记库

```yaml
collection:
  name: notes
  schema_version: 1
  primary_table: items
  primary_key: slug

fields:
  required:
    - { name: title,         type: string }
    - { name: topic,         type: string, related: true }
    - { name: fetched_at,    type: iso8601 }
  optional:
    - { name: source,        type: string }       # 文献 URL / 书籍章节
    - { name: tags,          type: "string[]", json: true, related: true }
    - { name: content,       type: text, fts: true }

slug_rule:
  parts:
    - { field: topic,        transform: "lower+strip_nonascii+slice(12)" }
    - { field: title,        transform: "lower+strip_nonascii+split_space+slice_words(4)+join_underscore" }
  separator: "_"
  unique_fields: []
```

### 2.6 实验室台账（试剂 / 仪器）

```yaml
collection:
  name: lab_inventory
  schema_version: 1
  primary_table: items
  primary_key: slug

fields:
  required:
    - { name: title,         type: string }
    - { name: item_type,     type: string, related: true }     # reagent / instrument / consumable
    - { name: fetched_at,    type: iso8601 }
  optional:
    - { name: lot_number,    type: string, unique: true }
    - { name: expiry_date,   type: date }
    - { name: location,      type: string, related: true }
    - { name: calibration_date, type: date }
    - { name: notes,         type: text, fts: true }

slug_rule:
  parts:
    - { field: item_type,    transform: "lower+strip_nonascii" }
    - { field: title,        transform: "lower+strip_nonascii+split_space+slice_words(4)+join_underscore" }
  separator: "_"
  unique_fields: [lot_number]
```

---

## 3. slug_rule 的 transform 语法

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

## 4. unique_fields 稳定性

如果某字段是"唯一标识"（DOI / email / 身份证 / 批号），在 ingest 时：

- 命中（db 里已有同字段值的记录）→ **沿用旧主键**，做 INSERT OR REPLACE
- 未命中 → 用新算的 slug 做 INSERT

这样即使 title 微调，DOI 不变时主键也不会漂移。

```yaml
unique_fields: [doi]    # 文献
unique_fields: [email]   # 联系人
unique_fields: [lot_number]  # 试剂
unique_fields: []        # 项目 / 笔记等通常无唯一字段
```

---

## 5. 必填字段选择原则

| 业务 | 必填字段 | 说明 |
|---|---|---|
| 文献 | title / first_author / year / fetched_at | 缺一不可入库 |
| 健康档案 | member / record_type / title / fetched_at | 必填主体 |
| 项目 | title / owner / status / fetched_at | 状态必填 |
| 联系人 | name / organization / fetched_at | 至少有姓名和组织 |
| 笔记 | title / topic / fetched_at | 至少能定位 |

**建议**：必填字段 ≤ 5 个。多了用户填写负担大，少了入库数据质量差。

---

## 6. fts 字段选择原则

FTS5 全文检索会让 db 体积略大、写入稍慢。**只对真正需要搜的字段开 fts**：

| 业务 | 建议开 fts 的字段 |
|---|---|
| 文献 | abstract / fulltext |
| 健康档案 | notes |
| 项目 | notes |
| 联系人 | notes |
| 笔记 | content |
| 实验室台账 | notes |

title 不必开 fts（精确查或 LIKE 即可）。

---

## 7. 自检清单

完成 schema.yaml 后，逐项检查：

- [ ] `collection.name` 已设置（用于日志和备份文件名）
- [ ] `collection.schema_version` 已设置（未来迁移锚点）
- [ ] `collection.primary_table` 已设置（默认 items）
- [ ] `collection.primary_key` 已设置（默认 slug）
- [ ] 必填字段 ≤ 5 个，且 schema 与业务匹配
- [ ] unique 字段标了 `unique: true`（DOI / email / 身份证等）
- [ ] 需要搜的字段标了 `fts: true`
- [ ] 标签数组字段标了 `json: true`（tags / diagnoses 等）
- [ ] slug_rule 至少 2 个 parts，确保主键不会太长
- [ ] slug_rule.total_length ≤ 200（Windows 路径限制）

---

## 8. 附录：与 SKILL.md / README.md 的引用关系

| template.md 章节 | 对应章节 |
|---|---|
| §1 最小配置 | README.md §3.2 / SKILL.md §2.1 |
| §2 业务示例 | README.md §5 |
| §3 transform 语法 | setup.ts / ingest.ts |
| §4 unique_fields | ingest.ts 的"唯一字段稳定性"逻辑 |
| §5 必填原则 | ingest.ts 的校验逻辑 |
| §6 fts 原则 | db.ts 的 searchFts / setup.ts 的 FTS5 表生成 |
| §7 自检清单 | SKILL.md §6 |

> 📌 **改本文件时同步检查 SKILL.md / README.md / scripts/**——三者必须一致。