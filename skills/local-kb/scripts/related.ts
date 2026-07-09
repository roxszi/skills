/**
 * local-kb 关联发现脚本。
 *
 * 用法：
 *   bun run scripts/related.ts <kb-path> --pk <slug>                    # 默认关联字段（从 .slug-rule.json 读）
 *   bun run scripts/related.ts <kb-path> --pk <slug> --fields <f1,f2>  # 显式指定关联字段
 *
 * 关联逻辑：找出与 target 在指定字段上有交集的其它记录。
 *
 * 默认字段来源：.slug-rule.json 的 related_fields（setup.ts 从 schema.yaml 的 `related: true` 字段收集）。
 *
 * 反模式（直接报错）：
 *   - 主键不存在 → 报错
 */

import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { resolveKbPath, openDb } from "./db.ts";

function getTableMetadata(db: ReturnType<typeof openDb>): { primaryTable: string; primaryKey: string } {
  const primaryTable =
    (db.prepare("SELECT value FROM schema_meta WHERE key = 'primary_table'").get() as { value: string } | undefined)?.value
    ?? "items";
  const primaryKey =
    (db.prepare("SELECT value FROM schema_meta WHERE key = 'primary_key'").get() as { value: string } | undefined)?.value
    ?? "slug";
  return { primaryTable, primaryKey };
}

function loadRelatedFields(rootDir: string): string[] {
  const p = join(rootDir, ".slug-rule.json");
  if (!existsSync(p)) return [];
  try {
    const rule = JSON.parse(readFileSync(p, "utf-8"));
    return Array.isArray(rule.related_fields) ? rule.related_fields : [];
  } catch {
    return [];
  }
}

function parseArgs(): {
  kbPath: string | null;
  pk: string | null;
  fields: string[];
} {
  let kbPath: string | null = null;
  let pk: string | null = null;
  let fields: string[] = [];

  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    const next = process.argv[i + 1];
    if (a === "--pk" && next) {
      pk = next;
      i++;
    } else if (a === "--fields" && next) {
      fields = next.split(",").map((f) => f.trim());
      i++;
    } else if (a === "--help" || a === "-h") {
      console.log(`用法: related.ts <kb-path> --pk <slug> [--fields <f1,f2>]
  --pk <slug>                  主键
  --fields <f1,f2,...>         显式指定关联字段（默认读 .slug-rule.json 的 related_fields）
  --help, -h                   本帮助
`);
      process.exit(0);
    } else if (!kbPath) {
      kbPath = a;
    }
  }
  return { kbPath, pk, fields };
}

const args = parseArgs();
if (!args.kbPath || !args.pk) {
  console.error("需要 <kb-path> --pk <slug>。--help 查看用法。");
  process.exit(1);
}

const { rootDir } = resolveKbPath(args.kbPath);
const db = openDb(args.kbPath, { readonly: true });
try {
  const { primaryTable, primaryKey } = getTableMetadata(db);

  // 关联字段优先级：--fields > .slug-rule.json 的 related_fields > []
  const fields = args.fields.length > 0
    ? args.fields
    : loadRelatedFields(rootDir);

  // 1. 加载 target
  const target = db
    .prepare(`SELECT * FROM ${primaryTable} WHERE ${primaryKey} = ?`)
    .get(args.pk) as Record<string, unknown> | undefined;
  if (!target) {
    console.error(`>>> 未找到 ${primaryKey}=${args.pk}`);
    process.exit(1);
  }
  console.log(`>>> target: ${args.pk}`);
  if (target.title) console.log(`    ${target.title}`);
  console.log();

  // 2. 找共享字段
  if (fields.length === 0) {
    console.log(">>> no related fields configured (schema 里没有 related: true 字段，且未传 --fields)");
    process.exit(0);
  }
  const related = new Map<string, { row: Record<string, unknown>; via: string }>();

  for (const field of fields) {
    const v = target[field];
    if (v === undefined || v === null || v === "") continue;

    let sql: string;
    let pattern: string;
    if (typeof v === "string" && v.startsWith("[")) {
      // JSON 数组字段（如 tags）
      sql = `SELECT * FROM ${primaryTable} WHERE ${field} LIKE ? AND ${primaryKey} != ?`;
      pattern = `%"${v.replace(/[[\]]/g, "")}"%`;
    } else {
      sql = `SELECT * FROM ${primaryTable} WHERE ${field} = ? AND ${primaryKey} != ?`;
      pattern = String(v);
    }

    const rows = db.prepare(sql).all(pattern, args.pk) as Array<Record<string, unknown>>;
    for (const r of rows) {
      const rowPk = String(r[primaryKey]);
      if (!related.has(rowPk)) {
        related.set(rowPk, { row: r, via: `shared ${field}` });
      }
    }
  }

  if (related.size === 0) {
    console.log(">>> no related records");
  } else {
    console.log(`>>> ${related.size} related record(s):`);
    for (const [rowPk, { row, via }] of related) {
      console.log(`    [${via}]`);
      console.log(`    ${rowPk}`);
      if (row.title) console.log(`    ${row.title}`);
      console.log();
    }
  }
} finally {
  db.close();
}
