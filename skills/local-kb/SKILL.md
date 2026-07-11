---
name: 本地信息资源数据库
slug: local-kb
description: 本地信息资源数据库的统一执行入口。当用户提出"建一个本地 X 库 / 做一个 Y 档案 / 存一下这篇 Z / 查一下我的 W / 备份"等指令时调用本 skill。Agent 按 SKILL.md 选对应脚本并执行，**所有具体执行都在 scripts/*.ts 中**——agent 不需要再读 SOUL.md 中关于具体执行的章节，也不需要再读具体业务的 papers/ 或 health_records/ 文档。适用于本地文献库、家人健康档案、本地项目档案、本地联系人档案、本地会议纪要、本地学习笔记、本地实验室台账等任何"长期累积 + 检索 + 反查 + 备份"场景。
compatibility: bun
author: RoxSzi (SI_Cheng-Yun, 司承运)
version: 1.5.1
license: MulanPSL v2
---

# 本地信息资源数据库 skill（local-kb）

## 1. 触发判断

| 用户输入 | 调用脚本 |
|---|---|
| "建一个本地 X 库" / "做一个 Y 档案" | `setup.ts` |
| 给 URL / DOI / 文件路径 / 数据 / 用户口述 | `ingest.ts`（必要时先 `clean.ts`）|
| "查一下我的 X" / "X 是怎么说的" | `query.ts` |
| "X 和 Y 有什么关系" / "类似的还有什么" | `related.ts` |
| "OCR 这张图" / "解析这个 PDF" | `clean.ts`（清洗后决定入库）|
| "备份" / 周期任务 | `backup.ts` |
| "对账 / 体检 / 检查数据健康度" | `audit.ts`（v1.5.1+）|

> 📌 **关于本 skill 的文档分工**（何时读其他文件）：
>
> | 你的处境 | 读哪个文件 |
> |---|---|
> | 日常执行 setup / ingest / query / related / backup | 只读本文件（SKILL.md） |
> | 首次接入 skill、定义新业务的 schema | 读 `template.md`（通用字段模板 + 接入流程 + SOUL 声明模板） |
> | 把 skill 部署到项目、精简现有 SOUL、迁移已有库、排查故障 | 读 `INTEGRATION_GUIDE.md`（架构 + 部署 + 迁移 + 故障 + 通用踩坑） |
> | meta.yaml 写错字段名、字段类型不匹配、查询不到记录 | 先看本文件 §4 反模式 + §6 自检清单；不行再读 `INTEGRATION_GUIDE.md §7 故障排查` |
>
> **本文件不重复的内容**（已分别在 template.md / INTEGRATION_GUIDE.md）：
> - 通用字段类型 / 修饰符 / transform 语法 → `template.md §1 / §4`
> - 业务别名 query_aliases 配置 → `template.md §2`
> - Agent 接入 skill 的标准流程 → `template.md §8`
> - SOUL.md 声明模板 → `template.md §9`
> - 通用踩坑清单 → `INTEGRATION_GUIDE.md §5`
> - 三层架构 / 部署 / SOUL 精简 / 迁移 → `INTEGRATION_GUIDE.md §0 / §3 / §4 / §6`

---

## 2. 调用命令

### 2.1 setup —— 首次建库

```bash
# 用 schema.yaml 建库
bun run scripts/setup.ts <kb-path> --schema <schema.yaml>

# 自测（用内置 mock schema）
bun run scripts/setup.ts ./test-kb --mock
```

schema.yaml 模板见同目录 `template.md`。

### 2.2 clean —— 清洗

```bash
# 文件 → 文件
bun run scripts/clean.ts input.md output.md

# stdin → stdout
cat raw.md | bun run scripts/clean.ts --stdin > clean.md

# mcp fetch 输出（必须加 --from-mcp）
bun run scripts/clean.ts --stdin --from-mcp < raw-mcp.txt > clean.md
```

### 2.3 ingest —— 入库

```bash
# 入库一条记录
bun run scripts/ingest.ts <kb-path> --meta <meta.yaml>

# 预校验 + 只算 slug 不入库（v1.5.0+：会跑完整 schema 校验，不用真入库就能发现字段问题）
bun run scripts/ingest.ts <kb-path> --meta <meta.yaml> --print-slug

# 自测（入库后输出清理命令）
bun run scripts/ingest.ts <kb-path> --mock

# 清理 mock 数据（v1.5.0+：按 slug 模式匹配 test_*_mock_* / mock_*_item）
bun run scripts/ingest.ts <kb-path> --cleanup-mock
```

**字段约束**（v1.4.0+ 严格校验）：

| 校验 | 错误类型 |
|---|---|
| 必填字段缺失 | err |
| 未知字段（不在 schema 白名单）| err（约定大于配置） |
| 字段类型不匹配 | err |

**v1.5.0+ path/text 自动配对加载**：schema 同时声明 `xxx_path`（type: path）和 `xxx_text`（type: text, fts:true）时，ingest 自动从 `xxx_path` 读文件填到 `xxx_text`。meta.yaml 显式提供的 `xxx_text` 优先（不被覆盖）。

**v1.5.0+ `<slug>` 占位符**：path 字段值中的 `<slug>` 自动展开为 computedSlug。

**path 字段路径解析约定**（v1.5.0+）：
- 绝对路径直接用
- 相对路径**相对 rootDir（kb 目录）解析**，不是相对 cwd
- 例：`fulltext_path: <slug>/fulltext.md` → 解析为 `<kb-path>/<slug>/fulltext.md`
- 文件不存在 → 警告但不 err（`xxx_text` 为 null，FTS 不可见该字段）

### 2.4 query —— 反查

```bash
# 主键精确
bun run scripts/query.ts <kb-path> --pk <slug>

# 任意字段精确
bun run scripts/query.ts <kb-path> --field <field> --value <v>

# 任意字段 LIKE
bun run scripts/query.ts <kb-path> --like <field> --value <v>

# JSON 数组字段（tags 等）
bun run scripts/query.ts <kb-path> --json tags --value SERS

# FTS5 全文检索（默认 phrase 模式，自动加双引号）
bun run scripts/query.ts <kb-path> --fts "<text>"

# FTS5 表达式模式（支持 AND / OR / NEAR，需配合 --fts-expr）
bun run scripts/query.ts <kb-path> --fts "SERS OR silver" --fts-expr

# 跨 FTS 字段 LIKE（中文友好，FTS5 unicode61 不分词中文时用）
bun run scripts/query.ts <kb-path> --fts-like "<关键词>"

# 读全文（必须配合 --pk）
bun run scripts/query.ts <kb-path> --pk <slug> --read

# 列出全部
bun run scripts/query.ts <kb-path> --all
```

> 📌 **`--read` 的全文来源**：query.ts 自动探测 `<record-dir>/fulltext.md` / `content.md` / `正文.md` 按需读取。**即使 db.fulltext_text=null，--read 仍能读全文**。
>
> 📌 **FTS 与 fulltext_text 的关系**：`--fts` / `--fts-like` 关键词搜索只走 db 的 fts 字段（如 abstract / fulltext_text）。如果某条记录 fts 字段为 null，FTS 搜不到该记录，但 `--read` 仍可读文件。
>
> 📌 **避免 fulltext_text=null**（v1.5.0+）：schema 声明 `fulltext_path` + `fulltext_text(fts:true)` 配对后，ingest 自动加载全文进 FTS 字段。详见 §2.3。

#### 业务别名（推荐）

如果 schema.yaml 配置了 `query_aliases`，agent 和用户可以用业务友好的 flag，由脚本自动翻译成通用模式：

```bash
# 假设 schema.yaml 配置了：
#   query_aliases:
#     - { name: doi,    field: doi,          mode: field }
#     - { name: slug,                         mode: pk }
#     - { name: author, field: first_author, mode: like }
#     - { name: tag,    field: tags,         mode: json }

bun run scripts/query.ts <kb-path> --doi 10.1021/...           # 等同 --field doi --value ...
bun run scripts/query.ts <kb-path> --slug <slug> --read        # 等同 --pk <slug> --read
bun run scripts/query.ts <kb-path> --author Liu                # 等同 --like first_author --value Liu
bun run scripts/query.ts <kb-path> --tag SERS                  # 等同 --json tags --value SERS
```

查看当前库已配置的别名：`bun run scripts/query.ts <kb-path> --help`

### 2.5 related —— 关联发现

```bash
# 默认字段（从 .slug-rule.json 的 related_fields 读，由 schema.yaml 的 related: true 字段收集）
bun run scripts/related.ts <kb-path> --pk <slug>

# 显式指定关联字段（覆盖默认值）
bun run scripts/related.ts <kb-path> --pk <slug> --fields <f1,f2>

# 用业务别名定位（schema.yaml 配置 query_aliases 后）：
bun run scripts/related.ts <kb-path> --doi 10.1021/...   # 先按 doi 查主键，再走关联
bun run scripts/related.ts <kb-path> --tag SERS          # 先按 tag 查到记录，再走关联
```

### 2.6 backup —— 备份

```bash
# 默认目的地：<kb-path>/../backups/<kb-name>/，保留 8 份
bun run scripts/backup.ts <kb-path>

# 自定义
bun run scripts/backup.ts <kb-path> --dest D:/Backup/my-kb --keep 8
```

### 2.7 audit —— 对账与健康体检（v1.5.1+）

```bash
# 全量对账（人类可读输出）
bun run scripts/audit.ts <kb-path>

# JSON 输出（便于其他工具消费 / CI 集成）
bun run scripts/audit.ts <kb-path> --json

# 只对账特定记录
bun run scripts/audit.ts <kb-path> --slug <slug>

# 只跑特定维度
bun run scripts/audit.ts <kb-path> --check <dim>
```

**对账维度**（`--check` 可选其一）：

| 维度 | 检查内容 |
|---|---|
| `schema-fields` | meta.yaml 字段名是否在 schema 白名单 |
| `db-integrity` | db 必填字段非空 / FTS 字段长度合理 / JSON 字段可解析 |
| `meta-db` | meta.yaml 数据 vs db 数据一致性（捕获"meta 改了但没重 ingest"）|
| `file-existence` | path 字段（展开 `<slug>` 后）指向的文件实际存在 |
| `slug-consistency` | db 主键 vs record 目录名 |

**退出码**（适合 CI / 自动化告警）：

| 退出码 | 含义 |
|---|---|
| 0 | 全部健康（无 warning / error） |
| 1 | 有 warning（需关注） |
| 2 | 有 error（需修复） |
| 3 | 参数错误 / 系统错误 |

**设计原则**：
- **只读**：不修改 meta.yaml / db / 任何文件
- **维度独立**：每个维度单独可跑（`--check`）
- **复用 ingest.ts 逻辑**：`loadSchema` / `loadMetaYaml` / `generateSlug` 都从 ingest.ts import，保证对账与入库逻辑同源（不会出现"audit 通过但 ingest 失败"或反之）

**何时跑**：
- 重大 schema 变更前后
- 批量 ingest / 重 ingest 前后
- 定期体检（如每月一次）
- ingest.ts 升级后（如 v1.4.0 字段名严格校验、v1.5.0 path/text 自动加载——升级后跑 audit 发现历史 silent failure）

---

## 3. 输出格式（agent 给用户讲解时按此结构）

### 3.1 单条记录

```
[1] 一句话结论先行
[2] 关键内容（按业务）
    - 文献：背景动机 / 核心方法 / 主要结果（带数值）/ 真实创新点 / 局限性
    - 健康档案：风险等级（红橙黄绿）/ 关键指标 / 用药审查 / 复查建议
    - 项目 / 联系人：基本信息 / 关键状态 / 后续待办
[3] 与用户当前场景的关联（可选）
[4] 待办 / 风险提示
```

### 3.2 多条对比

```
三栏式对比（方法 / 结果 / 创新点）+ 一句话结论
"哪条更适合什么场景、为什么"
```

### 3.3 健康档案特殊

```
[1] 红橙黄绿四级风险标注
[2] 关键指标解读表（指标 / 当前值 / 参考范围 / 趋势 / 临床意义）
[3] 风险评估矩阵（药物 × 风险维度）
[4] 就医问题清单（每条 ≤ 30 字）
[5] 长期随访时间轴（Mermaid）
```

---

## 4. 关键反模式（脚本会直接报错）

| # | 反模式 | 报错位置 |
|---|---|---|
| 1 | 不算 slug 就 mkdir | `ingest.ts` 不允许外部预先 mkdir，主键由 slug rule 算 |
| 2 | 内容不清理直接入库 | agent 必须先跑 `clean.ts` |
| 3 | mcp fetch JSON 包装不解包 | `clean.ts --from-mcp` 强制使用 |
| 4 | 重跑 ingest 当"重新插入" | `ingest.ts` 用 INSERT OR REPLACE，且 DOI 唯一时沿用旧 slug |
| 5 | backup 按默认字典序排 | `backup.ts` 按 mtime 排 |
| 6 | copyFileSync 后不刷 mtime | `backup.ts` 显式 `utimesSync(now, now)` |
| 7 | setup 不幂等 / 版本不匹配静默兼容 | `ensureSchema` 检查 schema_version 抛错 |
| 8 | meta.yaml 缺必填字段 | `ingest.ts` 校验失败直接报错 |
| 9 | 字段不存在就查询 | `query.ts` 用 PRAGMA 校验 |
| 10 | 库目录已存在且非空就 setup | `setup.ts` 报错（避免覆盖） |
| 11 | 业务字段硬编码到脚本 | 别名必须经 `schema.yaml.query_aliases` 声明，脚本不感知任何业务字段；运行时由 `.slug-rule.json` 携带 |
| 12 | meta.yaml 字段名不在 schema 白名单 | `ingest.ts` v1.4.0+ 直接 err（约定大于配置）；`--print-slug` v1.5.0+ 也会 err |
| 13 | meta.yaml 改了但 db 数据落后（没重 ingest）| 重新 ingest；或跑 `audit.ts` 对账（v1.5.1+，维度 `meta-db` 会捕获）|

### 4.1 业务别名的"翻译规则"

schema.yaml 的 `query_aliases` 节声明后，由 setup.ts 写入 `.slug-rule.json`，再由 query.ts / related.ts 的 parseArgs 在运行时翻译：

| alias.mode | 翻译为 | 必填 field |
|---|---|---|
| `field`    | `--field <field> --value <v>`    | ✅ |
| `like`     | `--like <field> --value <v>`     | ✅ |
| `json`     | `--json <field> --value <v>`     | ✅ |
| `pk`       | `--pk <v>`                       | ❌ |
| `fts-like` | `--fts-like <v>`                 | ❌ |
| `fts`      | `--fts <v>`                      | ❌ |

related.ts 中所有别名都会先按 mode 查到主键，再走关联逻辑（`pk` 模式等同 `--pk`）。

---

## 5. 已知 vs 待核实（硬规则）

agent 在 ingest 时必须区分：

| 来源 | 处理 |
|---|---|
| **用户口述的硬事实**（剂量 / 频次 / 诊断 / 数值）| **精确写入**，不做"❓ 待核实"妥协 |
| **OCR / fetch 自动解析** | 关键数值请用户对照原文核实 |
| **三者冲突**（用户口述 / OCR / 文档）| **立刻停下来问**，不要自行取平均 |

入库后必跑回归检查：

```bash
grep -E "❓|待核实|未知|____" <kb-path>/<slug>/meta.yaml
```

确认已知信息没出现在"待核实"栏。

---

## 6. 自检清单（每个环节完成后必跑）

### setup 完成

- [ ] 库目录已建，且只包含预期文件（README.md / schema.yaml / .schema.sql / .slug-rule.json / kb.db）？
- [ ] `scripts/backup.ts <kb-path>` 能跑通？
- [ ] `scripts/query.ts <kb-path> --all` 能列出（空）表？

### ingest 完成

- [ ] 来源已 clean（如适用）？
- [ ] meta.yaml 字段全部在 schema 白名单内（v1.4.0+ 严格校验）？
- [ ] meta.yaml 必填字段齐全？
- [ ] slug 已先 `--print-slug` 再 ingest（v1.5.0+ 预校验）？
- [ ] 唯一字段查重（DOI / 身份证等）？
- [ ] **FTS 字段入库后实际有内容**（length > 13，排除 "Test abstract" 等占位；不为 null）？
- [ ] path 字段指向的文件实际存在（ingest 会警告）？
- [ ] 已按 §3 输出格式讲解？
- [ ] 回归检查：`grep -E "❓|待核实|未知|____"` 无命中？

### query 完成

- [ ] 匹配模式选对（精确 / LIKE / FTS / JSON）？
- [ ] 命中后 `--read` 读全文（不是只看标题）？
- [ ] 已按 §3 输出格式讲解？

### backup 完成

- [ ] 输出含 `>>> backup OK` + size + verify？
- [ ] mtime 已刷（ls -la 看 mtime = 现在）？
- [ ] 备份目录与库物理隔离（不同磁盘）？

### audit 完成（v1.5.1+）

- [ ] 退出码与预期一致（0=健康 / 1=warning / 2=error）？
- [ ] 维度完整跑（未用 `--check` 缩窄）？
- [ ] 报告中的 error 已逐一确认修复路径？
- [ ] 如跑 `--json`，结果已落档（CI / 日志归档）？