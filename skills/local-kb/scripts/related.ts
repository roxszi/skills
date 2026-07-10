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
import { resolveKbPath, openDb, loadAliases, type QueryAlias } from "./db.ts";

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

/**
 * 业务别名支持（增强）。
 *
 * 用户给 `related.ts <kb-path> --doi 10.1021/...` 时，
 * 先用 alias.mode 把 value 翻译成主键，再走 related 主逻辑。
 *
 * 例如：alias `{ name: "doi", field: "doi", mode: "field" }`
 *   → SELECT primary_key FROM items WHERE doi = ?
 *   → 用查到的 slug 继续 related 主逻辑
 *
 * 不配置别名时，行为完全等同旧版本（只接受 --pk）。
 */
function resolvePkByAlias(
  db: ReturnType<typeof openDb>,
  primaryTable: string,
  primaryKey: string,
  aliases: QueryAlias[],
  argv: string[]
): { pk: string | null; aliasName: string | null } {
  const aliasMap = new Map<string, QueryAlias>();
  for (const a of aliases) aliasMap.set(`--${a.name}`, a);

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (!aliasMap.has(a) || !next) continue;
    const al = aliasMap.get(a)!;
    if (!al.field) continue; // mode=pk 的别名意义不大，跳过
    // 只支持精确匹配模式（field / json / like）转主键
    let row: { pk: string } | undefined;
    if (al.mode === "field") {
      row = db
        .prepare(`SELECT ${primaryKey} AS pk FROM ${primaryTable} WHERE ${al.field} = ?`)
        .get(next) as { pk: string } | undefined;
    } else if (al.mode === "like") {
      row = db
        .prepare(`SELECT ${primaryKey} AS pk FROM ${primaryTable} WHERE ${al.field} LIKE ?`)
        .get(`%${next}%`) as { pk: string } | undefined;
    } else if (al.mode === "json") {
      row = db
        .prepare(`SELECT ${primaryKey} AS pk FROM ${primaryTable} WHERE ${al.field} LIKE ?`)
        .get(`%"${next}"%`) as { pk: string } | undefined;
    }
    if (row) return { pk: row.pk, aliasName: al.name };
    // 命中别名但没找到记录：直接退出，避免误以为 --pk 找不到
    console.error(`>>> --${al.name} ${next} 未命中任何记录`);
    process.exit(1);
  }
  return { pk: null, aliasName: null };
}

function peekKbPath(): string | null {
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith("-")) continue;
    return a;
  }
  return null;
}

function parseArgs(aliases: QueryAlias[]): {
  kbPath: string | null;
  pk: string | null;
  fields: string[];
} {
  let kbPath: string | null = null;
  let pk: string | null = null;
  let fields: string[] = [];
  const aliasMap = new Map<string, QueryAlias>();
  for (const a of aliases) aliasMap.set(`--${a.name}`, a);

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

业务别名（如已配置）：
  related.ts <kb-path> --<alias-name> <value>
  例如：related.ts <kb-path> --doi 10.1021/... → 先按 doi 查主键，再走关联逻辑

  --help, -h                   本帮助
`);
      if (aliases.length > 0) {
        console.log(`已配置的业务别名：`);
        for (const al of aliases) {
          const f = al.field ? al.field : "(无需字段)";
          console.log(`  --${al.name} <v>  →  ${al.mode} ${f}`);
        }
      }
      process.exit(0);
    } else if (aliasMap.has(a)) {
      // 命中业务别名：在 resolvePkByAlias 阶段处理
      // 这里跳过 next，避免被当成 kbPath
      i++;
    } else if (!kbPath) {
      kbPath = a;
    }
  }
  return { kbPath, pk, fields };
}

const kbPathOnly = peekKbPath();
const aliases = kbPathOnly ? loadAliases(resolveKbPath(kbPathOnly).rootDir) : [];

const args = parseArgs(aliases);
if (!args.kbPath) {
  console.error("需要 <kb-path>。--help 查看用法。");
  process.exit(1);
}

const { rootDir } = resolveKbPath(args.kbPath);
const db = openDb(args.kbPath, { readonly: true });
try {
  const { primaryTable, primaryKey } = getTableMetadata(db);

  // 业务别名翻译：用户给 --doi X → 查出真实 slug
  let pk = args.pk;
  if (!pk && aliases.length > 0) {
    const r = resolvePkByAlias(db, primaryTable, primaryKey, aliases, process.argv);
    pk = r.pk;
    if (pk && r.aliasName) {
      console.log(`>>> --${r.aliasName} 解析为主键：${pk}`);
    }
  }
  if (!pk) {
    console.error("需要 --pk <slug>（或已配置的业务别名）。--help 查看用法。");
    process.exit(1);
  }
  const finalPk = pk;

  // 关联字段优先级：--fields > .slug-rule.json 的 related_fields > []
  const fields = args.fields.length > 0
    ? args.fields
    : loadRelatedFields(rootDir);

  // 1. 加载 target
  const target = db
    .prepare(`SELECT * FROM ${primaryTable} WHERE ${primaryKey} = ?`)
    .get(finalPk) as Record<string, unknown> | undefined;
  if (!target) {
    console.error(`>>> 未找到 ${primaryKey}=${finalPk}`);
    process.exit(1);
  }
  console.log(`>>> target: ${finalPk}`);
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

    const rows = db.prepare(sql).all(pattern, finalPk) as Array<Record<string, unknown>>;
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
