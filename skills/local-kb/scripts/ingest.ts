/**
 * local-kb 入库脚本。
 *
 * 用法：
 *   bun run scripts/ingest.ts <kb-path> --meta <meta.yaml>
 *   bun run scripts/ingest.ts <kb-path> --meta <meta.yaml> --print-slug   # 只算 slug
 *   bun run scripts/ingest.ts <kb-path> --mock                            # mock 数据
 *
 * 流程：
 *   1. 读 schema.yaml / slug_rule.json
 *   2. 读 meta.yaml，校验必填字段
 *   3. 算 slug（按 slug_rule）
 *   4. 冲突检测（unique_fields）
 *   5. mkdir + 写 meta.yaml + 写 content.md（可选）
 *   6. 入库（事务）
 *   7. 输出 inserted/updated 状态
 *
 * 反模式（直接报错）：
 *   - meta.yaml 缺必填字段 → 报错并列出缺失字段
 *   - 算 slug 失败 → 报错
 *   - 库路径不存在 → 报错（提示先跑 setup）
 *   - schema.yaml / slug_rule.json 缺失 → 报错
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { resolveKbPath, openDb, ensureSchema } from "./db.ts";
import { parseYaml, type YamlObject } from "./yaml.ts";

// ===== Schema / slug rule 加载 =====

interface FieldDef {
  name: string;
  type: string;
  unique?: boolean;
  indexed?: boolean;
  fts?: boolean;
  json?: boolean;
  related?: boolean;
}

interface SchemaYaml {
  collection: {
    name: string;
    schema_version: number | string;
    primary_table: string;
    primary_key?: string;
  };
  fields: {
    required: FieldDef[];
    optional?: FieldDef[];
  };
  slug_rule?: {
    parts: Array<{ field: string; transform?: string }>;
    separator?: string;
    unique_fields?: string[];
  };
}

interface SlugRule {
  parts: Array<{ field: string; transform?: string }>;
  separator: string;
  unique_fields?: string[];
}

function loadSchema(rootDir: string): SchemaYaml {
  const p = join(rootDir, "schema.yaml");
  if (!existsSync(p)) throw new Error(`schema.yaml not found: ${p}。请检查 setup 是否完整。`);
  return parseYaml(readFileSync(p, "utf-8")) as unknown as SchemaYaml;
}

function loadSlugRule(rootDir: string): SlugRule {
  const p = join(rootDir, ".slug-rule.json");
  if (!existsSync(p)) throw new Error(`.slug-rule.json not found: ${p}。请检查 setup 是否完整。`);
  return JSON.parse(readFileSync(p, "utf-8")) as SlugRule;
}

// ===== meta.yaml 加载 + 校验 =====

interface MetaYaml {
  [key: string]: unknown;
  slug?: string;
}

function loadMetaYaml(metaPath: string): MetaYaml {
  if (!existsSync(metaPath)) {
    throw new Error(`meta.yaml not found: ${metaPath}`);
  }
  const obj = parseYaml(readFileSync(metaPath, "utf-8"));
  return obj as MetaYaml;
}

// ===== 类型校验（dispatch table） =====
type Validator = (v: unknown) => string | null;

const VALIDATORS: Record<string, Validator> = {
  string:    (v) => (typeof v === "string" || typeof v === "number") ? null : `expected string, got ${typeof v}`,
  int:       (v) => Number.isInteger(Number(v)) ? null : `expected integer, got ${JSON.stringify(v)}`,
  integer:   (v) => Number.isInteger(Number(v)) ? null : `expected integer, got ${JSON.stringify(v)}`,
  number:    (v) => (v === "" || !isNaN(Number(v))) ? null : `expected number, got ${JSON.stringify(v)}`,
  text:      () => null,  // text 接受任意类型
  iso8601:   (v) => /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(String(v)) ? null : `expected ISO 8601 (YYYY-MM-DDThh:mm:ss), got ${JSON.stringify(v)}`,
  date:      (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? null : `expected YYYY-MM-DD, got ${JSON.stringify(v)}`,
  path:      () => null,  // path 接受任意类型
  boolean:   (v) => (v === true || v === false || v === 0 || v === 1 || v === "0" || v === "1" || v === "true" || v === "false") ? null : `expected 0/1/true/false, got ${JSON.stringify(v)}`,
  "string[]": (v) => Array.isArray(v) ? null : `expected array, got ${typeof v}`,
};

function validateMeta(meta: MetaYaml, schema: SchemaYaml): { missing: string[]; errors: string[] } {
  const missing: string[] = [];
  const errors: string[] = [];

  // 1. 必填字段校验
  for (const f of schema.fields.required) {
    if (meta[f.name] === undefined || meta[f.name] === null || meta[f.name] === "") {
      missing.push(f.name);
    }
  }
  if (missing.length > 0) {
    errors.push(`meta.yaml 缺少必填字段: ${missing.join(", ")}`);
  }

  // 2. 类型校验（dispatch table）
  for (const f of [...schema.fields.required, ...(schema.fields.optional ?? [])]) {
    if (meta[f.name] === undefined) continue;
    const validator = VALIDATORS[f.type];
    if (!validator) {
      errors.push(`schema.yaml 字段 ${f.name} 类型 '${f.type}' 无 validator（schema 配置错误）`);
      continue;
    }
    const err = validator(meta[f.name]);
    if (err) {
      errors.push(`${f.name}: ${err}`);
    }
  }
  return { missing, errors };
}

// ===== Slug 生成 =====

function applyTransform(value: string, transform: string | undefined): string {
  if (!transform) return value;
  // 支持的 transform:
  //   lower                            → toLowerCase
  //   strip_nonascii                   → 去非 a-z0-9（保留 ASCII 字母数字 + 空格）
  //   strip_punct_preserve_cjk         → 去标点，保留 Unicode 字母数字（含中日韩）
  //   slice(N)                         → 截前 N 字符
  //   split_space                      → 空格分词
  //   slice_words(N)                   → 取前 N 词
  //   join_underscore                  → 下划线连接
  const steps = transform.split("+");
  let s: string | string[] = value;
  for (const step of steps) {
    if (step === "lower" && typeof s === "string") s = s.toLowerCase();
    else if (step === "strip_nonascii" && typeof s === "string") s = s.replace(/[^a-z0-9 ]/gi, "");
    else if (step === "strip_punct_preserve_cjk" && typeof s === "string") {
      // 改进：保留 Unicode 字母 (\p{L} 包含中日韩) + 数字 (\p{N}) + 空白
      s = s.replace(/[^\p{L}\p{N}\s]/gu, "");
    }
    else if (step.startsWith("slice(") && typeof s === "string") {
      // 兼容 slice(N) 和 slice(0,N) 两种语法
      const m = step.match(/slice\((?:\d+\s*,\s*)?(\d+)\)/);
      if (!m) throw new Error(`transform syntax error: '${step}'。支持 slice(N) 或 slice(start,end)`);
      const n = parseInt(m[1]);
      s = s.slice(0, n);
    } else if (step === "split_space" && typeof s === "string") s = s.split(/\s+/).filter(Boolean);
    else if (step.startsWith("slice_words(") && Array.isArray(s)) {
      const n = parseInt(step.match(/slice_words\((\d+)\)/)![1]);
      s = s.slice(0, n);
    } else if (step === "join_underscore" && Array.isArray(s)) s = s.join("_");
  }
  return Array.isArray(s) ? s.join("_") : s;
}

function generateSlug(meta: MetaYaml, slugRule: SlugRule): string {
  if (meta.slug && typeof meta.slug === "string") return meta.slug;
  const parts: string[] = [];
  for (const p of slugRule.parts) {
    const v = String(meta[p.field] ?? "");
    if (!v) continue;
    parts.push(applyTransform(v, p.transform));
  }
  return parts.join(slugRule.separator ?? "_");
}

// ===== 入库 =====

function ingestOne(kbPath: string, metaPath: string): { slug: string; inserted: boolean; primaryKey: string } {
  const { rootDir } = resolveKbPath(kbPath);

  // 1. 加载 schema / slug rule / meta
  const schema = loadSchema(rootDir);
  const slugRule = loadSlugRule(rootDir);
  const meta = loadMetaYaml(metaPath);

  // 2. 校验
  const { errors } = validateMeta(meta, schema);
  if (errors.length > 0) {
    throw new Error(`meta.yaml 校验失败：\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  }

  const computedSlug = generateSlug(meta, slugRule);
  if (!computedSlug) {
    throw new Error("无法生成 slug：meta.yaml 缺少 slug 字段或 slug_rule 必需字段");
  }

  const primaryTable = schema.collection.primary_table;
  const primaryKey = schema.collection.primary_key ?? "slug";

  ensureSchema(kbPath);
  const db = openDb(kbPath);

  try {
    // 3. 唯一字段稳定性：DOI 等唯一字段已存在时，沿用旧 slug
    let slug = computedSlug;
    let inserted = true;

    for (const uniqueField of slugRule.unique_fields ?? []) {
      const v = meta[uniqueField];
      if (v === undefined || v === "") continue;
      const byUnique = db
        .prepare(`SELECT ${primaryKey} AS pk FROM ${primaryTable} WHERE ${uniqueField} = ?`)
        .get(String(v)) as { pk: string } | undefined;
      if (byUnique) {
        slug = byUnique.pk;
        inserted = false;
        break;
      }
    }

    // 4. 检查主键是否已存在
    if (inserted) {
      const byPk = db
        .prepare(`SELECT ${primaryKey} AS pk FROM ${primaryTable} WHERE ${primaryKey} = ?`)
        .get(computedSlug) as { pk: string } | undefined;
      if (byPk) {
        slug = byPk.pk;
        inserted = false;
      }
    }

    // 5. 建目录 + 写文件
    const recordDir = join(rootDir, slug);
    mkdirSync(recordDir, { recursive: true });
    const savedMetaPath = join(recordDir, "meta.yaml");
    if (!existsSync(savedMetaPath)) {
      writeFileSync(savedMetaPath, readFileSync(metaPath, "utf-8"), "utf-8");
    }

    // 6. 入库（事务）
    const allFields: FieldDef[] = [
      ...schema.fields.required,
      ...(schema.fields.optional ?? []),
    ];
    const cols = [primaryKey, ...allFields.filter((f) => f.name !== primaryKey).map((f) => f.name)];
    const placeholders = cols.map(() => "?").join(", ");
    const values: (string | number | null)[] = [slug];

    for (const f of allFields) {
      if (f.name === primaryKey) continue;
      let v = meta[f.name];
      if (f.json && Array.isArray(v)) {
        v = JSON.stringify(v);
      }
      if (v === undefined || v === null) {
        values.push(null);
      } else if (f.type === "int") {
        values.push(Number(v));
      } else {
        values.push(String(v));
      }
    }

    const tx = db.transaction(() => {
      db.prepare(
        `INSERT OR REPLACE INTO ${primaryTable} (${cols.join(", ")}) VALUES (${placeholders})`
      ).run(...values);
    });
    tx();

    return { slug, inserted, primaryKey };
  } finally {
    db.close();
  }
}

// ===== Mock meta.yaml（自测用） =====

/**
 * 内置 papers schema mock（向后兼容）。
 */
function buildPapersMockYaml(): string {
  return `slug: "test_2024_jacs_mock_paper"
title: "Mock Paper"
first_author: "Test"
authors: [Test, Mock, Author]
year: 2024
journal: "JACS"
volume: 146
issue: 12
pages: "1000-1010"
url: "https://example.org/mock"
fetched_at: "2026-07-08T12:00:00+08:00"
fetch_method: "mock"
tags: [SERS, AgNPs, dopamine, electrochemistry]
abstract: "This is a mock paper for verifying the ingest script works end-to-end. It contains keywords like surface-enhanced Raman scattering and silver nanoparticles for testing FTS5 full-text search."
`;
}

/**
 * 改进：从指定 schema.yaml 生成 mock meta.yaml。
 *
 * 对每个字段（必填 + 部分可选）填入合理的 mock 值：
 * - string → "mock_<name>"
 * - iso8601 → 当前时间
 * - date → 今日
 * - int/number → 0
 * - boolean → true
 * - string[] → ["mock_a", "mock_b"]
 */
function buildSchemaMockYaml(schemaPath: string): string {
  if (!existsSync(schemaPath)) {
    throw new Error(`schema.yaml not found: ${schemaPath}`);
  }
  const obj = parseYaml(readFileSync(schemaPath, "utf-8")) as any;
  const schemaName = obj.collection?.name ?? "mock-kb";
  const fields: Array<{ name: string; type: string; json?: boolean }> = [
    ...(obj.fields?.required ?? []),
    ...(obj.fields?.optional ?? []),
  ];

  const today = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();

  const lines: string[] = [`slug: "mock_${schemaName}_item"`];
  for (const f of fields) {
    if (f.name === "slug") continue;
    let mockVal: string;
    switch (f.type) {
      case "iso8601":
        mockVal = `"${now}"`;
        break;
      case "date":
        mockVal = `"${today}"`;
        break;
      case "int":
      case "integer":
      case "number":
        mockVal = "0";
        break;
      case "boolean":
        mockVal = "true";
        break;
      case "string[]":
        mockVal = '[mock_a, mock_b]';
        break;
      default:
        // string / text / path / 未知类型
        mockVal = `"mock_${f.name}"`;
    }
    lines.push(`${f.name}: ${mockVal}`);
  }
  return lines.join("\n") + "\n";
}

function writeMockMeta(kbPath: string, schemaPath?: string | null): string {
  const { rootDir } = resolveKbPath(kbPath);
  // 根据是否有 schema 选择 mock 来源
  const yaml = schemaPath ? buildSchemaMockYaml(schemaPath) : buildPapersMockYaml();

  // 从 slug 字段提取目录名（避免硬编码 "test_2024_jacs_mock_paper"）
  const slugMatch = yaml.match(/^slug:\s*"?([^"\n]+)"?/m);
  const mockSlug = slugMatch ? slugMatch[1].trim() : "mock_item";
  const dir = join(rootDir, mockSlug);
  mkdirSync(dir, { recursive: true });
  const metaPath = join(dir, "meta.yaml");
  writeFileSync(metaPath, yaml, "utf-8");
  return metaPath;
}

// ===== CLI =====

function parseArgs(): {
  kbPath: string | null;
  metaPath: string | null;
  mock: boolean;
  mockSchemaPath: string | null;
  printSlug: boolean;
} {
  let kbPath: string | null = null;
  let metaPath: string | null = null;
  let mock = false;
  let mockSchemaPath: string | null = null;
  let printSlug = false;
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    const next = process.argv[i + 1];
    if (a === "--meta" && next) {
      metaPath = resolve(next);
      i++;
    } else if (a === "--mock") {
      mock = true;
    } else if (a === "--schema" && next && mock) {
      // 改进：--mock --schema <path>：用指定 schema 生成 mock meta.yaml
      mockSchemaPath = resolve(next);
      i++;
    } else if (a === "--print-slug") {
      printSlug = true;
    } else if (a === "--help" || a === "-h") {
      console.log(`用法: ingest.ts <kb-path> [options]
  <kb-path>              库路径
  --meta <file>         入库指定的 meta.yaml
  --mock                写入内置 mock meta.yaml（papers schema）并入库（向后兼容）
  --mock --schema <file>  用指定 schema 生成 mock meta.yaml 并入库（改进：适配任意业务）
  --print-slug          配合 --meta：只打印 slug 后退出（最快算 slug 的方式）
  --help, -h            本帮助
`);
      process.exit(0);
    } else if (!kbPath) {
      kbPath = resolve(a);
    }
  }
  return { kbPath, metaPath, mock, mockSchemaPath, printSlug };
}

const args = parseArgs();
if (!args.kbPath) {
  console.error("需要 <kb-path>，或 --help");
  process.exit(1);
}

if (args.mock) {
  const metaPath = writeMockMeta(args.kbPath, args.mockSchemaPath);
  console.log(`>>> mock meta.yaml 写入：${metaPath}`);
  const { slug, inserted } = ingestOne(args.kbPath, metaPath);
  console.log(`>>> ${inserted ? "inserted" : "updated"} paper: ${slug}`);
} else if (args.metaPath) {
  if (args.printSlug) {
    const { rootDir } = resolveKbPath(args.kbPath);
    const slugRule = loadSlugRule(rootDir);
    const meta = loadMetaYaml(args.metaPath);
    const slug = generateSlug(meta, slugRule);
    console.log(slug);
    process.exit(0);
  }
  const { slug, inserted, primaryKey } = ingestOne(args.kbPath, args.metaPath);
  console.log(`>>> ${inserted ? "inserted" : "updated"} ${primaryKey}: ${slug}`);
} else {
  console.error("需要 --meta <path> 或 --mock，或 --help");
  process.exit(1);
}