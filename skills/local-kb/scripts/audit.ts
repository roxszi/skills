/**
 * local-kb 对账脚本（v1.5.1+）。
 *
 * 用法：
 *   bun run scripts/audit.ts <kb-path>                          # 全量对账（人类可读）
 *   bun run scripts/audit.ts <kb-path> --json                   # JSON 输出（便于其他工具消费）
 *   bun run scripts/audit.ts <kb-path> --slug <slug>            # 只对账特定记录
 *   bun run scripts/audit.ts <kb-path> --check <dim>            # 只跑特定维度
 *   bun run scripts/audit.ts <kb-path> --help
 *
 * 对账维度（--check 可选）：
 *   - schema-fields     ：meta.yaml 字段名 vs schema 白名单
 *   - db-integrity      ：db 必填字段非空 / FTS 字段长度合理 / JSON 字段可解析
 *   - meta-db           ：meta.yaml 数据 vs db 数据一致性
 *   - file-existence    ：path 字段（展开 <slug> 后）指向的文件存在性
 *   - slug-consistency  ：从 meta.yaml 算 slug vs 目录名 vs db pk
 *
 * 退出码：
 *   - 0：全部健康（无 warning / error）
 *   - 1：有 warning（需关注）
 *   - 2：有 error（需修复）
 *   - 3：参数错误 / 系统错误
 *
 * 设计原则：
 *   - **只读**：不修改 meta.yaml / db / 任何文件
 *   - **维度独立**：每个维度独立检查，可单独跑
 *   - **机器友好 + 人类友好**：--json 输出结构化数据，默认输出可读表格
 *   - **复用 ingest.ts 逻辑**：loadSchema / loadMetaYaml / generateSlug 都从 ingest.ts import，保证与入库逻辑一致
 */

import { readdirSync, existsSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { resolveKbPath, openDb } from "./db.ts";
import {
  loadSchema,
  loadSlugRule,
  loadMetaYaml,
  generateSlug,
  type SchemaYaml,
  type SlugRule,
  type MetaYaml,
} from "./ingest.ts";

// ===== 类型定义 =====

type Severity = "ok" | "warning" | "error";

interface Issue {
  severity: Severity;
  dimension: Dimension;
  message: string;
  fix?: string;
}

type Dimension =
  | "schema-fields"
  | "db-integrity"
  | "meta-db"
  | "file-existence"
  | "slug-consistency";

interface DbDataSnapshot {
  tags_count?: number;
  abstract_len?: number;
  fulltext_len?: number | null;
  [key: string]: unknown;
}

interface RecordReport {
  slug: string;
  recordDir: string;
  metaYamlExists: boolean;
  dbExists: boolean;
  status: Severity;
  issues: Issue[];
  dbData?: DbDataSnapshot;
}

interface AuditReport {
  kb_path: string;
  generated_at: string;
  total: number;
  healthy: number;
  warnings: number;
  errors: number;
  records: RecordReport[];
}

// ===== 工具函数 =====

/** 跳过这些目录名（非 record 目录） */
const SKIP_DIRS = new Set(["backups", "_inbox", "node_modules", ".git"]);

function isRecordDir(dirPath: string): boolean {
  // 包含 meta.yaml 文件的目录才算 record 目录
  return existsSync(join(dirPath, "meta.yaml"));
}

function listRecordDirs(rootDir: string): string[] {
  const entries = readdirSync(rootDir, { withFileTypes: true });
  return entries
    .filter(
      (e) =>
        e.isDirectory() &&
        !e.name.startsWith(".") &&
        !SKIP_DIRS.has(e.name),
    )
    .map((e) => join(rootDir, e.name))
    .filter(isRecordDir);
}

function parseJsonArray(raw: unknown): unknown[] {
  if (raw === null || raw === undefined) return [];
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 占位字符识别：长度 ≤ 13 视为占位（如 "Test abstract" = 13 字符） */
const PLACEHOLDER_MAX_LEN = 13;

// ===== 对账维度 =====

/**
 * 维度 1：meta.yaml 字段名 vs schema 白名单
 */
function checkSchemaFields(meta: MetaYaml, schema: SchemaYaml): Issue[] {
  const issues: Issue[] = [];
  const allowedFields = new Set<string>();
  for (const f of schema.fields.required) allowedFields.add(f.name);
  for (const f of schema.fields.optional ?? []) allowedFields.add(f.name);
  if (schema.collection.primary_key) allowedFields.add(schema.collection.primary_key);

  const unknown: string[] = [];
  for (const k of Object.keys(meta)) {
    if (!allowedFields.has(k)) unknown.push(k);
  }
  if (unknown.length > 0) {
    issues.push({
      severity: "error",
      dimension: "schema-fields",
      message: `meta.yaml 含未知字段：${unknown.join(", ")}`,
      fix: `对照 schema.yaml 白名单修正字段名后重新 ingest（合法字段：${[...allowedFields].sort().join(", ")}）`,
    });
  }
  return issues;
}

/**
 * 维度 2：db 必填字段非空 / FTS 字段长度合理 / JSON 字段可解析
 */
function checkDbIntegrity(
  dbRow: Record<string, unknown> | null,
  schema: SchemaYaml,
): { issues: Issue[]; data: DbDataSnapshot } {
  const issues: Issue[] = [];
  const data: DbDataSnapshot = {};

  if (!dbRow) {
    issues.push({
      severity: "error",
      dimension: "db-integrity",
      message: "db 中无此 slug 对应记录",
      fix: "重新 ingest meta.yaml",
    });
    return { issues, data };
  }

  // 必填字段非空
  for (const f of schema.fields.required) {
    const v = dbRow[f.name];
    if (v === null || v === undefined || v === "") {
      issues.push({
        severity: "error",
        dimension: "db-integrity",
        message: `必填字段 ${f.name} 为空`,
      });
    }
  }

  // FTS 字段（type: text, fts:true）长度合理性
  const ftsFields = (schema.fields.optional ?? []).filter((f) => f.type === "text" && f.fts);
  for (const f of ftsFields) {
    const v = dbRow[f.name];
    const len = typeof v === "string" ? v.length : 0;
    if (f.name === "fulltext_text") data.fulltext_len = typeof v === "string" ? v.length : null;
    if (f.name === "abstract") data.abstract_len = typeof v === "string" ? v.length : 0;

    if (v === null || v === undefined) {
      issues.push({
        severity: "warning",
        dimension: "db-integrity",
        message: `FTS 字段 ${f.name} 为 null（FTS 不可见该字段；--read 仍能从文件读）`,
        fix: "重新 ingest（v1.5.0+ 配对加载会自动填充）；或在 meta.yaml 显式提供",
      });
    } else if (len === 1) {
      // 单字符（如 winkler 的 "|"）—— YAML 块字面量符号被误入库
      issues.push({
        severity: "error",
        dimension: "db-integrity",
        message: `FTS 字段 ${f.name} 长度仅 1（"${String(v)}"），疑似 YAML 块字面量符号被误入库`,
        fix: "重新 ingest（v1.5.0 已用 String(v) 强转，应已修复）",
      });
    } else if (len > 0 && len <= PLACEHOLDER_MAX_LEN) {
      // 占位字符（如 "Test abstract" = 13 字符）
      issues.push({
        severity: "warning",
        dimension: "db-integrity",
        message: `FTS 字段 ${f.name} 长度仅 ${len}，疑似占位（如 "Test abstract"）：${JSON.stringify(v)}`,
        fix: "重新 ingest 真实内容",
      });
    }
  }

  // JSON 数组字段（type: string[], json:true）
  const jsonFields = (schema.fields.optional ?? []).filter((f) => f.type === "string[]" && f.json);
  for (const f of jsonFields) {
    const v = dbRow[f.name];
    const arr = parseJsonArray(v);
    if (f.name === "tags_json") data.tags_count = arr.length;
    if (arr.length === 0) {
      const rawPreview = typeof v === "string" ? `"${v.slice(0, 30)}"` : JSON.stringify(v);
      issues.push({
        severity: "warning",
        dimension: "db-integrity",
        message: `JSON 字段 ${f.name} 为空数组或解析失败（raw: ${rawPreview}）`,
        fix: `重新 ingest，meta.yaml 用正确的 ${f.name} 字段名提供数组`,
      });
    }
  }

  return { issues, data };
}

/**
 * 维度 3：meta.yaml 数据 vs db 数据一致性
 *
 * 检测"meta.yaml 改了但 db 没重 ingest"的状态。
 */
function checkMetaVsDb(
  meta: MetaYaml,
  dbRow: Record<string, unknown> | null,
  schema: SchemaYaml,
): Issue[] {
  const issues: Issue[] = [];
  if (!dbRow) return issues; // 已被 checkDbIntegrity 报告

  // 比较 tags 数量（仅当 meta.yaml 比 db 多时才 warning；db 比 meta 多可能是合法删除）
  const jsonFields = (schema.fields.optional ?? []).filter((f) => f.type === "string[]" && f.json);
  for (const f of jsonFields) {
    const metaRaw = meta[f.name];
    const metaCount = Array.isArray(metaRaw) ? metaRaw.length : 0;
    const dbCount = parseJsonArray(dbRow[f.name]).length;
    if (metaCount > dbCount) {
      issues.push({
        severity: "warning",
        dimension: "meta-db",
        message: `${f.name} 数量落后：meta.yaml=${metaCount} vs db=${dbCount}`,
        fix: "重新 ingest（db 落后于 meta.yaml）",
      });
    }
  }

  // 比较 abstract 长度（仅当 meta.yaml 比 db 长很多时才报告，差异 > 13 字符排除占位）
  const abstractField = (schema.fields.optional ?? []).find(
    (f) => f.type === "text" && f.name === "abstract",
  );
  if (abstractField) {
    const metaAbs = meta[abstractField.name];
    const metaLen = typeof metaAbs === "string" ? metaAbs.length : 0;
    const dbAbs = dbRow[abstractField.name];
    const dbLen = typeof dbAbs === "string" ? dbAbs.length : 0;
    if (metaLen > dbLen + PLACEHOLDER_MAX_LEN && metaLen > PLACEHOLDER_MAX_LEN) {
      issues.push({
        severity: "warning",
        dimension: "meta-db",
        message: `abstract 长度落后：meta.yaml=${metaLen} vs db=${dbLen}`,
        fix: "重新 ingest",
      });
    }
  }

  return issues;
}

/**
 * 维度 4：path 字段（展开 <slug> 后）指向的文件存在性
 */
function checkFileExistence(
  meta: MetaYaml,
  schema: SchemaYaml,
  rootDir: string,
  computedSlug: string,
): Issue[] {
  const issues: Issue[] = [];
  const pathFields = (schema.fields.optional ?? []).filter((f) => f.type === "path");

  for (const pf of pathFields) {
    let pv = meta[pf.name];
    if (pv === undefined || pv === null) continue;
    pv = String(pv).replace(/<slug>/g, computedSlug);

    const fullPath = resolve(rootDir, pv);
    if (!existsSync(fullPath)) {
      issues.push({
        severity: "warning",
        dimension: "file-existence",
        message: `${pf.name}=${fullPath} 文件不存在`,
        fix: "修正路径，或确保文件就位后重新 ingest",
      });
    }
  }
  return issues;
}

/**
 * 维度 5：db.pk 与目录名一致性
 *
 * 注：v1.5.1 起不再用 "meta.yaml 重算 slug ≠ 目录名" 报警——
 * 因为 slug_rule 的 transform 历史变化（如 strip_nonascii 保留空格）会让重算结果与历史 slug 不一致，
 * 但 db 一致，不算业务问题。
 *
 * 真正要抓的是"db 主键与 record 目录名漂移"——这种状态下 --pk 查不到。
 */
function checkSlugConsistency(
  _meta: MetaYaml,
  _slugRule: SlugRule,
  recordDirName: string,
  dbRow: Record<string, unknown> | null,
  primaryKey: string,
): Issue[] {
  const issues: Issue[] = [];
  if (dbRow && dbRow[primaryKey] !== recordDirName) {
    issues.push({
      severity: "warning",
      dimension: "slug-consistency",
      message: `db.${primaryKey}="${dbRow[primaryKey]}" 与目录名="${recordDirName}" 不一致`,
      fix: "重新 ingest 或修正目录名",
    });
  }
  return issues;
}

// ===== 单条对账 =====

function auditOne(
  recordDir: string,
  schema: SchemaYaml,
  slugRule: SlugRule,
  db: ReturnType<typeof openDb>,
  rootDir: string,
  filterDim: string | null,
): RecordReport {
  const recordDirName = basename(recordDir);
  const primaryKey = schema.collection.primary_key ?? "slug";
  const primaryTable = schema.collection.primary_table;
  const report: RecordReport = {
    slug: recordDirName,
    recordDir,
    metaYamlExists: false,
    dbExists: false,
    status: "ok",
    issues: [],
  };

  const metaPath = join(recordDir, "meta.yaml");
  report.metaYamlExists = existsSync(metaPath);
  if (!report.metaYamlExists) {
    report.issues.push({
      severity: "error",
      dimension: "schema-fields",
      message: `${metaPath} 不存在`,
    });
    report.status = "error";
    return report;
  }

  const meta = loadMetaYaml(metaPath);

  // 查 db
  const dbRow = db
    .prepare(`SELECT * FROM ${primaryTable} WHERE ${primaryKey} = ?`)
    .get(recordDirName) as Record<string, unknown> | undefined;
  report.dbExists = !!dbRow;

  // 跑各维度对账（按 filterDim 过滤）
  const dimRun = (dim: Dimension, fn: () => Issue[]) => {
    if (filterDim && dim !== filterDim) return;
    report.issues.push(...fn());
  };

  dimRun("schema-fields", () => checkSchemaFields(meta, schema));
  dimRun("db-integrity", () => {
    const r = checkDbIntegrity(dbRow ?? null, schema);
    report.dbData = r.data;
    return r.issues;
  });
  dimRun("meta-db", () => checkMetaVsDb(meta, dbRow ?? null, schema));
  dimRun("file-existence", () => checkFileExistence(meta, schema, rootDir, recordDirName));
  dimRun("slug-consistency", () =>
    checkSlugConsistency(meta, slugRule, recordDirName, dbRow ?? null, primaryKey),
  );

  // 计算总体状态
  if (report.issues.some((i) => i.severity === "error")) {
    report.status = "error";
  } else if (report.issues.some((i) => i.severity === "warning")) {
    report.status = "warning";
  }
  return report;
}

// ===== 输出格式 =====

function printHumanReadable(audit: AuditReport): void {
  const line = "=".repeat(70);
  console.log(line);
  console.log(`local-kb 对账报告  |  ${audit.generated_at}`);
  console.log(line);
  console.log(`库路径：${audit.kb_path}`);
  console.log(`记录总数：${audit.total}`);
  console.log(
    `健康度：${audit.healthy} 健康 / ${audit.warnings} 需关注 / ${audit.errors} 需修复`,
  );
  console.log();

  // 概览表
  console.log("─".repeat(70));
  console.log(
    "slug".padEnd(56) + "  schema  db  meta  file  slug".padEnd(28),
  );
  console.log("─".repeat(70));
  for (const r of audit.records) {
    const emoji = r.status === "ok" ? "✅" : r.status === "warning" ? "⚠️ " : "❌";
    const dims: Dimension[] = ["schema-fields", "db-integrity", "meta-db", "file-existence", "slug-consistency"];
    const dimMarks = dims
      .map((d) => {
        const issues = r.issues.filter((i) => i.dimension === d);
        if (issues.length === 0) return "✓";
        if (issues.some((i) => i.severity === "error")) return "✗";
        return "?";
      })
      .join("   ");
    const slugDisplay = r.slug.length > 54 ? r.slug.slice(0, 51) + "..." : r.slug.padEnd(54);
    console.log(`${emoji} ${slugDisplay}  ${dimMarks}`);
  }
  console.log("─".repeat(70));
  console.log("图例：✓ 通过 | ? warning | ✗ error | （未跑该维度则空）");
  console.log();

  // 每条记录的详情（仅显示有问题的）
  const problemRecords = audit.records.filter((r) => r.status !== "ok");
  if (problemRecords.length === 0) {
    console.log("✅ 全部健康，无 warning / error");
    return;
  }

  console.log(line);
  console.log(`问题记录详情（${problemRecords.length} 条）`);
  console.log(line);

  for (const r of problemRecords) {
    const emoji = r.status === "warning" ? "⚠️ " : "❌";
    console.log();
    console.log(`${emoji} ${r.slug}`);
    console.log("  " + "─".repeat(66));
    for (const issue of r.issues) {
      const ie = issue.severity === "error" ? "❌" : "⚠️ ";
      console.log(`  ${ie} [${issue.dimension}] ${issue.message}`);
      if (issue.fix) {
        console.log(`      修复：${issue.fix}`);
      }
    }
    if (r.dbData) {
      const parts: string[] = [];
      if (r.dbData.tags_count !== undefined) parts.push(`tags=${r.dbData.tags_count}`);
      if (r.dbData.abstract_len !== undefined) parts.push(`abstract=${r.dbData.abstract_len}`);
      if (r.dbData.fulltext_len !== undefined) parts.push(`fulltext=${r.dbData.fulltext_len ?? "null"}`);
      if (parts.length > 0) {
        console.log(`  📊 db 数据：${parts.join(", ")}`);
      }
    }
  }
}

// ===== CLI =====

function parseArgs(): {
  kbPath: string | null;
  json: boolean;
  slug: string | null;
  checkDim: string | null;
} {
  let kbPath: string | null = null;
  let json = false;
  let slug: string | null = null;
  let checkDim: string | null = null;
  const validDims: Dimension[] = [
    "schema-fields",
    "db-integrity",
    "meta-db",
    "file-existence",
    "slug-consistency",
  ];
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    const next = process.argv[i + 1];
    if (a === "--json") {
      json = true;
    } else if (a === "--slug" && next) {
      slug = next;
      i++;
    } else if (a === "--check" && next) {
      if (!validDims.includes(next as Dimension)) {
        console.error(
          `无效维度：${next}。支持：${validDims.join(", ")}`,
        );
        process.exit(3);
      }
      checkDim = next;
      i++;
    } else if (a === "--help" || a === "-h") {
      console.log(`用法: audit.ts <kb-path> [options]
  <kb-path>              库路径
  --json                 输出 JSON（便于其他工具消费）
  --slug <slug>          只对账特定记录
  --check <维度>         只跑特定维度：
                           schema-fields / db-integrity / meta-db / file-existence / slug-consistency
  --help, -h             本帮助

退出码：
  0  全部健康
  1  有 warning
  2  有 error
  3  参数错误
`);
      process.exit(0);
    } else if (!kbPath) {
      kbPath = resolve(a);
    }
  }
  return { kbPath, json, slug, checkDim };
}

// ===== 入口 =====

const args = parseArgs();
if (!args.kbPath) {
  console.error("需要 <kb-path>，或 --help");
  process.exit(3);
}

const { rootDir } = resolveKbPath(args.kbPath);
const schema = loadSchema(rootDir);
const slugRule = loadSlugRule(rootDir);

let recordDirs = listRecordDirs(rootDir);
if (args.slug) {
  recordDirs = recordDirs.filter((d) => basename(d) === args.slug);
  if (recordDirs.length === 0) {
    console.error(`未找到 slug="${args.slug}" 对应的 record 目录`);
    process.exit(3);
  }
}

const db = openDb(args.kbPath, { readonly: true });
let records: RecordReport[];
try {
  records = recordDirs.map((d) =>
    auditOne(d, schema, slugRule, db, rootDir, args.checkDim),
  );
} finally {
  db.close();
}

const audit: AuditReport = {
  kb_path: rootDir,
  generated_at: new Date().toISOString(),
  total: records.length,
  healthy: records.filter((r) => r.status === "ok").length,
  warnings: records.filter((r) => r.status === "warning").length,
  errors: records.filter((r) => r.status === "error").length,
  records,
};

if (args.json) {
  console.log(JSON.stringify(audit, null, 2));
} else {
  printHumanReadable(audit);
}

// 退出码（仅当全量对账时才有意义；--slug / --check 时仍按状态返回）
if (audit.errors > 0) process.exit(2);
if (audit.warnings > 0) process.exit(1);
process.exit(0);
