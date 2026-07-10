/**
 * local-kb 共享数据库访问层。
 *
 * 设计目标：
 * - 通用：支持任意 schema（由 setup.ts 生成 .schema.sql）
 * - 零依赖：bun:sqlite 内置
 * - 库路径参数化：每个项目用自己的 kb.db
 *
 * 用法：
 *   import { openDb, ensureSchema, searchFts, describeDb } from "./db.ts";
 *
 *   const db = openDb("<kb-path>");
 *   ensureSchema("<kb-path>");  // 幂等建表
 *   const hits = searchFts(db, "<query>", 10);
 */

import { Database } from "bun:sqlite";
import { dirname, resolve } from "node:path";
import { existsSync, statSync, readFileSync } from "node:fs";

/** 每次连接必须设置的 PRAGMA（per-connection） */
const PRAGMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA temp_store = MEMORY;
`;

/**
 * 业务别名（query / related 共用）。
 *
 * 设计目标：让 SOUL / agent / 用户能用 `--doi 10.1021/...`、`--author Li` 这类
 * 业务友好的 flag，而 skill 脚本本身保持通用（不硬编码任何业务字段）。
 *
 * 数据来源：schema.yaml 的 `query_aliases` 节，由 setup.ts 写入 .slug-rule.json。
 *
 * 别名命中后的"翻译规则"：
 *   mode="field"    → query.ts --field <field> --value <v>
 *   mode="like"     → query.ts --like <field> --value <v>
 *   mode="json"     → query.ts --json <field> --value <v>
 *   mode="pk"       → query.ts --pk <v>
 *   mode="fts-like" → query.ts --fts-like <v>
 *   mode="fts"      → query.ts --fts <v>
 *
 * 在 related.ts 里：所有别名都翻译成"先按 alias.mode 查主键，再走 related 逻辑"。
 */
export interface QueryAlias {
  /** flag 名（不含 --），例如 "doi"、"author"、"tag" */
  name: string;
  /** 翻译到的字段名（fts-like / fts / pk 模式下可为空） */
  field?: string;
  /** 翻译模式 */
  mode: "field" | "like" | "json" | "pk" | "fts-like" | "fts";
}

/**
 * 从 .slug-rule.json 读 query_aliases。
 *
 * 没有配置或文件不存在时返回空数组（完全向后兼容）。
 */
export function loadAliases(rootDir: string): QueryAlias[] {
  const p = `${rootDir}/.slug-rule.json`;
  if (!existsSync(p)) return [];
  try {
    const rule = JSON.parse(readFileSync(p, "utf-8")) as { query_aliases?: QueryAlias[] };
    if (!Array.isArray(rule.query_aliases)) return [];
    // 字段校验：只接受 { name, field?, mode } 形状，过滤脏数据
    return rule.query_aliases.filter(
      (a) => a && typeof a.name === "string" && typeof a.mode === "string"
    );
  } catch {
    return [];
  }
}

/**
 * 解析 kb-path：可以是 .db 文件路径，也可以是库根目录（自动追加 /kb.db）。
 *
 *   "C:/Data/MyKB"        → "C:/Data/MyKB/kb.db"
 *   "C:/Data/MyKB/"       → "C:/Data/MyKB/kb.db"
 *   "C:/Data/MyKB/kb.db"  → "C:/Data/MyKB/kb.db"
 */
export function resolveKbPath(kbPath: string): { dbPath: string; rootDir: string } {
  const normalized = kbPath.replace(/\\/g, "/").replace(/\/$/, "");
  let dbPath: string;
  let rootDir: string;
  if (normalized.endsWith(".db")) {
    dbPath = normalized;
    rootDir = dirname(normalized);
  } else {
    rootDir = normalized;
    dbPath = `${normalized}/kb.db`;
  }
  return { dbPath, rootDir };
}

/**
 * 打开数据库。默认读写；readonly=true 用于查询 / 备份验证。
 *
 * 注意：每次调用都执行 PRAGMA（per-connection 设置）。
 */
export function openDb(kbPath: string, opts: { readonly?: boolean } = {}): Database {
  const { dbPath } = resolveKbPath(kbPath);
  const db = opts.readonly
    ? new Database(dbPath, { readonly: true })
    : new Database(dbPath);
  db.exec(PRAGMA_SQL);
  return db;
}

/**
 * 确保 schema 存在。幂等——重复执行安全。
 *
 * 行为：
 * - 跑 .schema.sql 建表
 * - 从 .schema.sql 头部注释读 schema_version / primary_table / primary_key
 * - 写入 schema_meta（q/r 的 single source of truth）
 * - 旧库（已存在 schema_version）走"补齐缺失元数据"路径，向后兼容
 *
 * 验证：检查 schema_meta.schema_version 是否匹配 .schema.sql 里的版本号。
 * 不匹配时抛错（防止新脚本被旧 db 误用）。
 */
export function ensureSchema(kbPath: string): { created: boolean; version: string } {
  const { dbPath, rootDir } = resolveKbPath(kbPath);
  const schemaSqlPath = `${rootDir}/.schema.sql`;
  if (!existsSync(schemaSqlPath)) {
    throw new Error(
      `未找到 ${schemaSqlPath}。请先运行 setup.ts 建库。`
    );
  }

  const sql = readFileSync(schemaSqlPath, "utf-8");
  const db = openDb(kbPath);
  try {
    db.exec(sql);

    // schema_meta 表可能不在 .schema.sql 里（用户自定义 schema）
    // 自动建一个
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    const versionMatch = sql.match(/--\s*schema_version:\s*(\S+)/i);
    const schemaVersion = versionMatch ? versionMatch[1] : "unknown";

    const primaryTableMatch = sql.match(/--\s*primary_table:\s*(\S+)/i);
    const primaryTable = primaryTableMatch ? primaryTableMatch[1] : "items";

    const primaryKeyMatch = sql.match(/--\s*primary_key:\s*(\S+)/i);
    const primaryKey = primaryKeyMatch ? primaryKeyMatch[1] : "slug";

    const existed = db
      .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;

    if (existed) {
      // 旧库：版本校验 + 补齐缺失元数据
      if (existed.value !== schemaVersion) {
        throw new Error(
          `schema version mismatch: db=${existed.value}, .schema.sql=${schemaVersion}。请运行 migrate 脚本升级。`
        );
      }
      // INSERT OR IGNORE：已有 key 不覆盖（避免覆盖用户手动改的元数据）
      const upsert = db.prepare("INSERT OR IGNORE INTO schema_meta (key, value) VALUES (?, ?)");
      upsert.run("primary_table", primaryTable);
      upsert.run("primary_key", primaryKey);
      return { created: false, version: schemaVersion };
    }

    // 全新库：写入所有元数据
    const insert = db.prepare("INSERT INTO schema_meta (key, value) VALUES (?, ?)");
    insert.run("schema_version", schemaVersion);
    insert.run("primary_table", primaryTable);
    insert.run("primary_key", primaryKey);
    return { created: true, version: schemaVersion };
  } finally {
    db.close();
  }
}

/**
 * FTS5 全文检索（通用版）。
 *
 * 通过查询 sqlite_master 找到第一个 FTS5 虚拟表，自动对其做 BM25 检索。
 * 这避免了硬编码表名，让脚本支持任意 schema。
 *
 * 返回 BM25 排序的命中行，按 score 升序排（BM25 越小越相关）。
 */
export interface FtsHit {
  /** 行 id（来自主表）*/
  rowid: number;
  /** 主表名（自动探测） */
  source_table: string;
  /** 命中片段（含 <mark> 标签） */
  snippet: string;
  /** BM25 分数 */
  score: number;
  /** 命中行的所有字段（动态） */
  row: Record<string, unknown>;
}

/**
 * 自动探测库里的 FTS5 虚拟表，并返回 BM25 排序的命中。
 *
 * 限制：只支持单个 FTS5 虚拟表。如果库里有多个，需在 schema 里标记主表。
 */
export function searchFts(
  db: Database,
  query: string,
  limit = 10,
  opts: { asExpression?: boolean } = {}
): FtsHit[] {
  // 找 FTS5 虚拟表
  const ftsTables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%VIRTUAL TABLE%fts5%'"
    )
    .all() as { name: string }[];

  if (ftsTables.length === 0) {
    throw new Error("未找到 FTS5 虚拟表。请在 .schema.sql 里定义 FTS5 索引。");
  }
  if (ftsTables.length > 1) {
    // 取第一个，或让 schema 标记 primary_fts
    console.warn(`>>> 多个 FTS5 虚拟表：${ftsTables.map(t => t.name).join(", ")}，使用第一个`);
  }
  const ftsName = ftsTables[0].name;

  // 找 content='xxx' 的主表
  const ftsDef = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?")
    .get(ftsName) as { sql: string };
  const contentMatch = ftsDef.sql.match(/content='(\w+)'/);
  const mainTable = contentMatch ? contentMatch[1] : null;
  if (!mainTable) {
    throw new Error(`FTS5 虚拟表 ${ftsName} 未指定 content='xxx' 主表。`);
  }

  // 安全转义 query
  const safeQuery = opts.asExpression
    ? query
    : `"${query.replace(/"/g, '""')}"`;

  // 找主表的所有列名（用于返回行）
  const cols = db
    .prepare(`PRAGMA table_info(${mainTable})`)
    .all() as { name: string }[];
  const colNames = cols.map((c) => c.name);

  const rows = db
    .prepare(
      `SELECT
         m.rowid AS rowid,
         bm25(${ftsName}) AS score,
         snippet(${ftsName}, -1, '<mark>', '</mark>', '…', 32) AS snip
       FROM ${ftsName}
       JOIN ${mainTable} m ON m.rowid = ${ftsName}.rowid
       WHERE ${ftsName} MATCH ?
       ORDER BY score
       LIMIT ?`
    )
    .all(safeQuery, limit) as Array<{ rowid: number; score: number; snip: string }>;

  // 取每行的所有列
  return rows.map((r) => {
    const row = db
      .prepare(`SELECT * FROM ${mainTable} WHERE rowid = ?`)
      .get(r.rowid) as Record<string, unknown>;
    return {
      rowid: r.rowid,
      source_table: mainTable,
      snippet: r.snip,
      score: r.score,
      row,
    };
  });
}

/** 调试用：打印数据库路径与基本信息 */
export function describeDb(kbPath: string): void {
  const { dbPath } = resolveKbPath(kbPath);
  const exists = existsSync(dbPath);
  console.log(`KB_PATH:    ${kbPath}`);
  console.log(`DB_PATH:    ${dbPath}`);
  console.log(`exists:     ${exists}`);
  if (!exists) {
    console.log(`size:       (not created)`);
    return;
  }
  const stat = statSync(dbPath);
  console.log(`size:       ${stat.size} bytes (主文件，不含 -wal/-shm)`);
  const db = openDb(kbPath, { readonly: true });
  try {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name"
      )
      .all() as { name: string }[];
    console.log(`tables:     ${tables.map((t) => t.name).join(", ")}`);
    const ver = db
      .prepare("SELECT value FROM schema_meta WHERE key='schema_version'")
      .get() as { value: string } | undefined;
    console.log(`schema:     v${ver?.value ?? "?"}`);
    const journalMode = db.prepare("PRAGMA journal_mode").get() as {
      journal_mode: string;
    };
    console.log(`journal:    ${journalMode.journal_mode}`);
  } finally {
    db.close();
  }
}