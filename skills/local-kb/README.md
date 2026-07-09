# local-kb —— 本地信息资源数据库 skill

> **用户视角的部署与使用手册**
>
> SKILL.md 是 agent 视角的执行入口（指向 scripts/*.ts）。
> 本 README 是用户视角：如何把 skill 部署到自己的项目、如何把 SOUL.md 精简成对接层。

## 1. 这是什么

本 skill 把"建库 / 入库 / 反查 / 备份"等通用执行逻辑沉淀到 `scripts/*.ts` 里。
agent 拿到 skill 后，**只需要读 SKILL.md + 跑对应脚本**，不再需要：

- 在 SOUL.md 里写 setup / ingest / query / backup 的具体步骤
- 读具体业务的 papers/ / health_records/ 文档
- 在不同业务里重复发明轮子

**scripts/*.ts 是真正的执行层**。SKILL.md 只是入口说明。

## 2. 目录结构

```
local-kb/
├── SKILL.md           # agent 视角：触发条件 + 脚本调用 + 输出格式
├── README.md          # 本文件：用户视角的部署与使用
├── template.md        # schema.yaml 模板（agent 解析用户输入用）
├── package.json       # bun 脚本定义
└── scripts/
    ├── setup.ts       # 首次建库
    ├── ingest.ts      # 入库
    ├── query.ts       # 反查
    ├── related.ts     # 关联发现
    ├── clean.ts       # 清洗
    ├── backup.ts      # 备份
    └── db.ts          # 共享数据库访问层
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

复制 `template.md` 的最小可工作配置，按你的业务改字段：

```yaml
# 学术文献库样例
collection:
  name: papers
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
    - { field: journal,      transform: "lower+strip_nonascii+slice(0,12)" }
    - { field: title,        transform: "lower+strip_nonascii+split_space+slice(0,4)+join_underscore" }
  separator: "_"
  unique_fields: [doi]
```

### 3.3 跑 setup 建库

```bash
bun run scripts/setup.ts ./papers --schema ./papers.schema.yaml
```

输出：
```
>>> 创建目录：./papers
>>> schema SQL 写入：./papers/.schema.sql
>>> schema created, version = v1
>>> slug rule 写入：./papers/.slug-rule.json
>>> README 写入：./papers/README.md
>>> 当前数据库状态：...
>>> 建库完成：./papers
```

### 3.4 开始使用

```bash
# 入库（先准备好 meta.yaml）
bun run scripts/ingest.ts ./papers --meta ./meta.yaml

# 反查
bun run scripts/query.ts ./papers --doi 10.1021/...
bun run scripts/query.ts ./papers --fts "SERS"

# 关联
bun run scripts/related.ts ./papers --pk smith_2024_jacs_...

# 备份
bun run scripts/backup.ts ./papers --dest D:/Backup/papers --keep 8
```

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
## 触发式默认行为

- **看到用户给 DOI / URL / 文件路径 / 用户口述一段数据**
  → 调用 local-kb skill

- **看到用户说"建一个 X 库"**
  → 调用 local-kb skill

- **看到用户说"查一下我的 X"**
  → 调用 local-kb skill

- **看到用户说"备份"**
  → 调用 local-kb skill

## 业务专属细节（健康档案专属，不在本 skill）

- **看到 QTc > 450ms（女）/ 440ms（男）** → 排查延长 QT 药物清单
- **看到肺结节 ≥ 6mm** → 查 Lung-RADS / Fleischner 指南
- **看到 ≥65 岁 + 苯二氮䓬类** → 查 BEERS 标准
- **看到剂量超过 FDA 推荐上限** → 立即高亮 + 推送

## SOUL 不再写

- ❌ setup / ingest / query / backup 的具体命令
- ❌ 反模式清单（已在 skill 的 scripts/ 里直接报错）
- ❌ 工作流细节（已在 SKILL.md §2）
- ❌ 元数据字段定义（已在 schema.yaml）
```

---

## 5. 不同业务的 schema.yaml 示例

### 5.1 学术文献库

```yaml
collection:
  name: papers
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
    - { field: journal,      transform: "lower+strip_nonascii+slice(0,12)" }
    - { field: title,        transform: "lower+strip_nonascii+split_space+slice(0,4)+join_underscore" }
  separator: "_"
  unique_fields: [doi]
```

### 5.2 家人健康档案

```yaml
collection:
  name: health_records
  schema_version: 1
  primary_table: items
  primary_key: slug

fields:
  required:
    - { name: member,        type: string }     # 妈妈 / 爸爸 / ...
    - { name: record_type,   type: string }     # medication / diagnosis / checkup / ...
    - { name: title,         type: string }     # 简短的标题
    - { name: fetched_at,    type: iso8601 }
  optional:
    - { name: dose,          type: string }     # 剂量（精确，不写"待核实"）
    - { name: frequency,     type: string }     # 频次
    - { name: start_date,    type: date }
    - { name: notes,         type: text, fts: true }

slug_rule:
  parts:
    - { field: member,       transform: "lower+strip_nonascii" }
    - { field: record_type,  transform: "lower+strip_nonascii" }
    - { field: title,        transform: "lower+strip_nonascii+split_space+slice(0,4)+join_underscore" }
  separator: "_"
  unique_fields: []     # 健康档案通常不唯一
```

### 5.3 项目档案库

```yaml
collection:
  name: projects
  schema_version: 1
  primary_table: items
  primary_key: slug

fields:
  required:
    - { name: title,         type: string }
    - { name: owner,         type: string }
    - { name: status,        type: string }     # active / paused / completed
    - { name: fetched_at,    type: iso8601 }
  optional:
    - { name: deadline,      type: date }
    - { name: tags,          type: "string[]", json: true }
    - { name: notes,         type: text, fts: true }

slug_rule:
  parts:
    - { field: owner,        transform: "lower+strip_nonascii" }
    - { field: title,        transform: "lower+strip_nonascii+split_space+slice(0,4)+join_underscore" }
  separator: "_"
  unique_fields: []
```

### 5.4 联系人 / 客户档案

```yaml
collection:
  name: contacts
  schema_version: 1
  primary_table: items
  primary_key: slug

fields:
  required:
    - { name: name,          type: string }
    - { name: organization,  type: string }
    - { name: fetched_at,    type: iso8601 }
  optional:
    - { name: role,          type: string }
    - { name: email,         type: string, unique: true }
    - { name: last_contact,  type: date }
    - { name: notes,         type: text, fts: true }

slug_rule:
  parts:
    - { field: organization, transform: "lower+strip_nonascii+slice(0,12)" }
    - { field: name,         transform: "lower+strip_nonascii" }
  separator: "_"
  unique_fields: [email]
```

---

## 6. 迁移已有库

如果你已有 papers/ 或 health_records/ 这种成熟库，可以：

**选项 A：直接复用 scripts**——把 `scripts/` 复制到你的项目根目录，把 hardcoded 的 `papers/papers.db` 改成参数化的 `<kb-path>/kb.db`（本 skill 已经做完了）。

**选项 B：完全用本 skill 重建**——准备好 schema.yaml（参考 §5 的样例），跑 `scripts/setup.ts`，再批量 ingest 已有数据。

**选项 C：保留旧库，新业务用本 skill**——互不干扰。

---

## 7. 故障排查

| 错误 | 原因 | 解决 |
|---|---|---|
| `schema.yaml not found` | setup 时未指定 schema | 用 `--schema` 或 `--mock` |
| `schema version mismatch` | db 与 .schema.sql 版本不一致 | 跑 migrate 脚本（待实现）或删除 db 重 setup |
| `meta.yaml 缺少必填字段: doi` | meta.yaml 缺字段 | 补齐 meta.yaml |
| `无法生成 slug` | slug_rule 必需字段都为空 | 检查 meta.yaml |
| `未找到 FTS5 虚拟表` | 库没启用 FTS5 | schema.yaml 里至少有一个字段标 `fts: true` |
| backup 失败 `checkpoint busy=1` | 其他连接在写 | 关闭其他连接后重试 |

---

## 8. 版本演进

| 版本 | 日期 | 关键变化 |
|---|---|---|
| 0.1.0 | 2026-07-08 | 初版：基于 papers/ + health_records/ 提炼的"通用方法论"——**错误方向** |
| 0.2.0 | 2026-07-08 | 改为"agent 直接照做的 Markdown 工作流"——**仍然错误**，没有 scripts |
| 1.0.0 | 2026-07-08 | **真正重构**：补全 7 个 ts 脚本（setup/ingest/query/related/clean/backup/db），SKILL.md 只剩脚本调用入口，README.md 承担用户视角的部署与 SOUL 精简示例 |
| 1.2.0 | 2026-07-09 | **功能更新**：多项兼容性更新 |