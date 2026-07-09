/**
 * local-kb 反查脚本。
 *
 * 设计原则：
 * - **完全 db 驱动**：不读 schema.yaml，用 PRAGMA table_info + schema_meta 拿元数据
 * - **通用**：支持任意 schema（只要 .schema.sql 头部有 primary_table/primary_key 注释）
 *
 * 用法：
 *   bun run scripts/query.ts <kb-path> --pk <slug>                        # 主键精确
 *   bun run scripts/query.ts <kb-path> --field <field> --value <v>       # 任意字段精确
 *   bun run scripts/query.ts <kb-path> --like <field> --value <v>        # 任意字段 LIKE（单字段）
 *   bun run scripts/query.ts <kb-path> --fts-like "<text>"               # 跨 FTS 字段 LIKE（中文友好，改进）
 *   bun run scripts/query.ts <kb-path> --json <field> --value <v>        # JSON 数组字段（如 tags）
 *   bun run scripts/query.ts <kb-path> --fts "<text>"                    # FTS5 BM25（按 phrase，英文友好）
 *   bun run scripts/query.ts <kb-path> --fts "<expr>" --fts-expr         # FTS5 表达式模式（AND/OR/NEAR）
 *   bun run scripts/query.ts <kb-path> --all                             # 列出全部
 *   bun run scripts/query.ts <kb-path> --pk <slug> --read                # 读全文
 *
 * 反模式（直接报错）：
 *   - 库路径不存在 → 报错（提示先跑 setup）
 *   - --field / --like / --json 字段名不在主表里 → 报错（列出可用字段）
 *   - --fts 但库没有 FTS5 表 → 报错
 *
 * 改进（v0.4）：
 *   - --fts-like "<text>"：跨 FTS 字段 LIKE 搜索，规避 FTS5 unicode61 不分词中文的限制
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { resolveKbPath, openDb, searchFts } from "./db.ts";

// ===== 通用 helpers =====

interface TableMetadata {
  primaryTable: string;
  primaryKey: string;
  columns: string[];
}

function getTableMetadata(db: ReturnType<typeof openDb>): TableMetadata {
  const primaryTable =
    (db.prepare("SELECT value FROM schema_meta WHERE key = 'primary_table'").get() as { value: string } | undefined)?.value
    ?? "items";
  const primaryKey =
    (db.prepare("SELECT value FROM schema_meta WHERE key = 'primary_key'").get() as { value: string } | undefined)?.value
    ?? "slug";
  const cols = db.prepare(`PRAGMA table_info(${primaryTable})`).all() as { name: string }[];
  return { primaryTable, primaryKey, columns: cols.map((c) => c.name) };
}

function assertColumnExists(columns: string[], field: string, mode: string): void {
  if (!columns.includes(field)) {
    throw new Error(
      `--${mode} 字段 '${field}' 不在表中。可用字段：${columns.join(", ")}`
    );
  }
}

/**
 * 改进：跨 FTS 字段做 LIKE 搜索（中文友好）。
 *
 * 为什么需要：FTS5 unicode61 / simple tokenizer 都不分词中文。
 * 降级方案：直接对 FTS5 索引涉及的字段做 LIKE %关键词%（中英文都支持）。
 *
 * 实现：从 sqlite_master 解析 FTS5 表的 SQL，提取 fts5() 内的列名（忽略 content='xxx' / tokenize 等 KV 配置）。
 */
function searchFtsLike(
  db: ReturnType<typeof openDb>,
  primaryTable: string,
  query: string,
  limit = 50
): Array<Record<string, unknown>> {
  // 找 FTS5 虚拟表（取第一个，与 searchFts 行为一致）
  const ftsTables = db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type='table' AND sql LIKE '%VIRTUAL TABLE%fts5%'"
    )
    .all() as { name: string; sql: string }[];

  if (ftsTables.length === 0) {
    throw new Error("--fts-like 需要 FTS5 虚拟表。请在 schema.yaml 里至少标一个字段 fts: true");
  }

  const ftsName = ftsTables[0].name;
  const ftsDef = ftsTables[0].sql;

  // 提取 fts5(...) 内的列定义
  const colsMatch = ftsDef.match(/fts5\(([^)]+)\)/);
  if (!colsMatch) {
    throw new Error(`FTS5 虚拟表 ${ftsName} 缺少列定义`);
  }
  const colsPart = colsMatch[1];
  // 拆分逗号，过滤掉带 = 的配置项（content='xxx' / content_rowid='xxx' / tokenize='xxx'）
  const ftsCols = colsPart
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && !s.includes("="));

  if (ftsCols.length === 0) {
    throw new Error(`FTS5 虚拟表 ${ftsName} 没有任何字段`);
  }

  // 跨字段 OR LIKE
  const whereClauses = ftsCols.map((c) => `${c} LIKE ?`).join(" OR ");
  const params = ftsCols.map(() => `%${query}%`);
  const rows = db
    .prepare(`SELECT * FROM ${primaryTable} WHERE ${whereClauses} LIMIT ?`)
    .all(...params, limit) as Array<Record<string, unknown>>;

  console.log(`>>> --fts-like 搜索字段：${ftsCols.join(", ")}`);
  return rows;
}

function loadFulltext(recordDir: string): string | null {
  // 按优先级探测：fulltext.md > content.md > 正文.md
  const candidates = ["fulltext.md", "content.md", "正文.md"];
  for (const name of candidates) {
    const p = join(recordDir, name);
    if (existsSync(p)) return readFileSync(p, "utf-8");
  }
  return null;
}

function pad(s: string, n: number): string {
  if (s.length >= n) return s.slice(0, n - 1) + "…";
  return s.padEnd(n);
}

function printTable(rows: Array<Record<string, unknown>>, columns: string[]): void {
  if (rows.length === 0) {
    console.log(">>> no matches");
    return;
  }
  // 用实际行的 keys，避免传错 columns
  const useCols = columns.length > 0 ? columns : Object.keys(rows[0]);
  const widths = Object.fromEntries(
    useCols.map((c) => [c, Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length))])
  );
  const header = useCols.map((c) => pad(c, widths[c])).join("  ");
  const sep = "-".repeat(header.length);
  console.log(sep);
  console.log(header);
  console.log(sep);
  for (const r of rows) {
    console.log(useCols.map((c) => pad(String(r[c] ?? ""), widths[c])).join("  "));
  }
  console.log(sep);
  console.log(`>>> ${rows.length} match(es)`);
}

// ===== CLI =====

function parseArgs(): {
  kbPath: string | null;
  mode: "pk" | "field" | "like" | "fts-like" | "json" | "fts" | "all";
  field?: string;
  value?: string;
  read: boolean;
  ftsExpression: boolean;
} {
  let kbPath: string | null = null;
  let mode: "pk" | "field" | "like" | "fts-like" | "json" | "fts" | "all" | null = null;
  let field: string | undefined;
  let value: string | undefined;
  let read = false;
  let ftsExpression = false;

  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    const next = process.argv[i + 1];
    if (a === "--pk" && next) {
      mode = "pk";
      value = next;
      i++;
    } else if (a === "--field" && next) {
      mode = "field";
      field = next;
      i++;
    } else if (a === "--like" && next) {
      mode = "like";
      field = next;
      i++;
    } else if (a === "--fts-like" && next) {
      mode = "fts-like";
      value = next;
      i++;
    } else if (a === "--json" && next) {
      mode = "json";
      field = next;
      i++;
    } else if (a === "--fts" && next) {
      mode = "fts";
      value = next;
      i++;
    } else if (a === "--all") {
      mode = "all";
    } else if (a === "--value" && next) {
      value = next;
      i++;
    } else if (a === "--read") {
      read = true;
    } else if (a === "--fts-expr") {
      ftsExpression = true;
    } else if (a === "--help" || a === "-h") {
      console.log(`用法: query.ts <kb-path> [options]
  <kb-path>                      库路径
  --pk <value>                   按主键精确查（如 slug）
  --field <field> --value <v>    按任意字段精确查（自动校验字段名）
  --like <field> --value <v>     按任意字段 LIKE 模糊查（单字段）
  --fts-like "<text>"            跨 FTS 字段 LIKE 模糊查（中文友好）
  --json <field> --value <v>     按 JSON 数组字段查（如 tags 里的某项，自动校验字段名）
  --fts "<text>"                 FTS5 全文检索（BM25，phrase 模式默认，英文友好）
  --fts-expr                     配合 --fts：FTS5 表达式模式（支持 AND / OR / NEAR）
  --all                          列出全部
  --read                         配合 --pk：读出 fulltext.md / content.md / 正文.md
  --help, -h                     本帮助
`);
      process.exit(0);
    } else if (!kbPath) {
      kbPath = a;
    }
  }
  if (!mode) {
    console.error("需要查询模式（--pk / --field / --like / --fts-like / --json / --fts / --all）。--help 查看用法。");
    process.exit(1);
  }
  return { kbPath, mode, field, value, read, ftsExpression };
}

const args = parseArgs();
if (!args.kbPath) {
  console.error("需要 <kb-path>");
  process.exit(1);
}

const { rootDir } = resolveKbPath(args.kbPath);
const db = openDb(args.kbPath, { readonly: true });
try {
  const { primaryTable, primaryKey, columns } = getTableMetadata(db);

  switch (args.mode) {
    case "pk": {
      const rows = db
        .prepare(`SELECT * FROM ${primaryTable} WHERE ${primaryKey} = ?`)
        .all(args.value) as Array<Record<string, unknown>>;
      printTable(rows, columns);
      if (args.read && rows.length === 1) {
        const recordDir = join(rootDir, String(rows[0][primaryKey]));
        const content = loadFulltext(recordDir);
        if (content) console.log("\n===== content =====\n" + content);
        else console.log(">>> content not found at:", recordDir);
      }
      break;
    }
    case "field": {
      if (!args.field) throw new Error("--field 需要 --value");
      assertColumnExists(columns, args.field, "field");
      const rows = db
        .prepare(`SELECT * FROM ${primaryTable} WHERE ${args.field} = ?`)
        .all(args.value) as Array<Record<string, unknown>>;
      printTable(rows, columns);
      break;
    }
    case "like": {
      if (!args.field) throw new Error("--like 需要 --value");
      assertColumnExists(columns, args.field, "like");
      const rows = db
        .prepare(`SELECT * FROM ${primaryTable} WHERE ${args.field} LIKE ?`)
        .all(`%${args.value}%`) as Array<Record<string, unknown>>;
      printTable(rows, columns);
      break;
    }
    case "json": {
      if (!args.field) throw new Error("--json 需要 --value");
      assertColumnExists(columns, args.field, "json");
      const rows = db
        .prepare(`SELECT * FROM ${primaryTable} WHERE ${args.field} LIKE ?`)
        .all(`%"${args.value}"%`) as Array<Record<string, unknown>>;
      printTable(rows, columns);
      break;
    }
    case "fts-like": {
      // 改进：跨 FTS 字段做 LIKE 搜索（中文友好）
      const rows = searchFtsLike(db, primaryTable, args.value!, 50);
      printTable(rows, columns);
      break;
    }
    case "fts": {
      const hits = searchFts(db, args.value!, 10, { asExpression: args.ftsExpression });
      if (hits.length === 0) {
        console.log(">>> no FTS matches");
      } else {
        for (const h of hits) {
          const ansiSnippet = h.snippet
            .replace(/<mark>/g, "\x1b[1;33m")
            .replace(/<\/mark>/g, "\x1b[0m");
          console.log(`\x1b[1m[${h.score.toFixed(2)}]\x1b[0m ${primaryKey}=${h.row[primaryKey]}`);
          console.log(`  ${ansiSnippet}`);
        }
        console.log(`>>> ${hits.length} FTS match(es)`);
      }
      break;
    }
    case "all": {
      const rows = db
        .prepare(`SELECT * FROM ${primaryTable} ORDER BY ${primaryKey}`)
        .all() as Array<Record<string, unknown>>;
      printTable(rows, columns);
      break;
    }
  }
} finally {
  db.close();
}
