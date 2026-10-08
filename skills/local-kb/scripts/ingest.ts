/**
 * local-kb 入库脚本。
 *
 * 用法：
 *   bun run scripts/ingest.ts <kb-path> --meta <meta.yaml>
 *   bun run scripts/ingest.ts <kb-path> --meta <meta.yaml> --print-slug   # 预校验 + 只算 slug
 *   bun run scripts/ingest.ts <kb-path> --mock                            # mock 数据（入库后提示清理）
 *   bun run scripts/ingest.ts <kb-path> --cleanup-mock                    # 清理 mock 数据
 *
 * 流程：
 *   1. 读 schema.yaml / slug_rule.json
 *   2. 读 meta.yaml，校验必填字段 + 未知字段（v1.4.0）+ 类型（v1.4.0）
 *   3. 算 slug（按 slug_rule）
 *   4. 【v1.5.0 NEW】path / text 字段自动配对加载 + <slug> 占位符展开
 *   5. 冲突检测（unique_fields）
 *   6. mkdir + 写 meta.yaml + 写 content.md（可选）
 *   7. 入库（事务）
 *   8. 输出 inserted/updated 状态
 *
 * 反模式（直接报错）：
 *   - meta.yaml 缺必填字段 → 报错并列出缺失字段
 *   - meta.yaml 含未知字段 → 报错（v1.4.0 约定大于配置）
 *   - 算 slug 失败 → 报错
 *   - 库路径不存在 → 报错（提示先跑 setup）
 *   - schema.yaml / slug_rule.json 缺失 → 报错
 *
 * v1.5.0 新特性：
 *   - path/text 自动配对：schema 同时声明 xxx_path + xxx_text(fts:true) 时，
 *     ingest 自动从 xxx_path 读文件填到 xxx_text（meta.yaml 显式提供的优先）
 *   - <slug> 占位符：path 字段值中的 <slug> 自动展开为 computedSlug
 *   - --print-slug 预校验：跑完整 schema 校验，不用真入库就能发现字段问题
 *   - --cleanup-mock：一键清理 mock 数据（按 slug 模式匹配）
 *   - --mock 入库后输出清理命令
 *
 * v1.6.0 新特性：
 *   - --load <path_field>=<source_file>：直接带外部全文文件入库，自动复制到
 *     <slug>/ 目录并写回路径字段，免手动 print-slug→mkdir→move 四步；
 *     字段名先校验（schema 存在 + type:path + _path↔_text 配对），不合法报错退出
 *   - 唯一字段/主键查重上移到路径处理之前：DOI 已存在沿用旧 slug 时，
 *     <slug> 展开与 --load 落盘均按最终 slug 执行（修复重入库落错目录的时序坑）
 *   - 入库事务后自动 wal_checkpoint(FULL)（busy=1 时告警），并回显 fts 字段长度
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync, copyFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { resolveKbPath, openDb, ensureSchema } from "./db.ts";
import { parseYaml, type YamlObject } from "./yaml.ts";

// ===== Schema / slug rule 加载 =====

export interface FieldDef {
  name: string;
  type: string;
  unique?: boolean;
  indexed?: boolean;
  fts?: boolean;
  json?: boolean;
  related?: boolean;
}

export interface SchemaYaml {
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

export interface SlugRule {
  parts: Array<{ field: string; transform?: string }>;
  separator: string;
  unique_fields?: string[];
}

export function loadSchema(rootDir: string): SchemaYaml {
  const p = join(rootDir, "schema.yaml");
  if (!existsSync(p)) throw new Error(`schema.yaml not found: ${p}。请检查 setup 是否完整。`);
  return parseYaml(readFileSync(p, "utf-8")) as unknown as SchemaYaml;
}

export function loadSlugRule(rootDir: string): SlugRule {
  const p = join(rootDir, ".slug-rule.json");
  if (!existsSync(p)) throw new Error(`.slug-rule.json not found: ${p}。请检查 setup 是否完整。`);
  return JSON.parse(readFileSync(p, "utf-8")) as SlugRule;
}

// ===== meta.yaml 加载 + 校验 =====

export interface MetaYaml {
  [key: string]: unknown;
  slug?: string;
}

export function loadMetaYaml(metaPath: string): MetaYaml {
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

export function validateMeta(meta: MetaYaml, schema: SchemaYaml): { missing: string[]; errors: string[] } {
  const missing: string[] = [];
  const errors: string[] = [];

  // 0. 未知字段检测（约定大于配置：meta.yaml 字段必须在 schema 白名单）
  // 防止今天的 silent failure 再次发生：用户写错字段名（如 tags 而不是 tags_json），
  // 旧逻辑是静默忽略；现在直接 err，列出未知字段名和 schema 合法字段名。
  // v1.4.0 NEW
  const allowedFields = new Set<string>();
  for (const f of schema.fields.required) allowedFields.add(f.name);
  for (const f of schema.fields.optional ?? []) allowedFields.add(f.name);
  // primary_key 也是合法字段（meta.yaml 可以显式指定主键值，如中文 slug）
  if (schema.collection.primary_key) allowedFields.add(schema.collection.primary_key);

  const unknown: string[] = [];
  for (const k of Object.keys(meta)) {
    if (!allowedFields.has(k)) {
      unknown.push(k);
    }
  }
  if (unknown.length > 0) {
    errors.push(
      `meta.yaml contains unknown field(s): ${unknown.join(", ")}\n` +
      `  Schema 合法字段: ${[...allowedFields].sort().join(", ")}\n` +
      `  请对照 schema.yaml 的 fields.required / fields.optional 后修正 meta.yaml`
    );
  }

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

export function generateSlug(meta: MetaYaml, slugRule: SlugRule): string {
  if (meta.slug && typeof meta.slug === "string") return meta.slug;
  const parts: string[] = [];
  for (const p of slugRule.parts) {
    const v = String(meta[p.field] ?? "");
    if (!v) continue;
    parts.push(applyTransform(v, p.transform));
  }
  return parts.join(slugRule.separator ?? "_");
}

// ===== v1.5.0 NEW: path / text 字段自动配对加载 =====

/**
 * 自动加载 path/text 配对字段，并展开 <slug> 占位符。
 *
 * 约定：schema 同时声明
 *   - xxx_path (type: path)
 *   - xxx_text (type: text, fts: true)
 * 字段名满足 xxx_path ↔ xxx_text 配对（如 fulltext_path ↔ fulltext_text）。
 *
 * 行为：
 *   1. 展开 path 字段值中的 <slug> 占位符（写入 meta，db 里存展开后的路径）
 *   2. 若 meta.yaml 没显式提供 xxx_text，则从 xxx_path 指向的文件读取内容填入 xxx_text
 *   3. 路径相对 rootDir 解析
 *   4. 文件不存在 → 警告但不 err（xxx_text 保持 null，FTS 不可见该字段）
 *
 * 设计理由（约定大于配置）：
 *   - 不需要 schema 显式声明 "auto_load_from"
 *   - 字段命名约定已经足够表达意图
 *   - 用户显式提供的 xxx_text 优先级最高（不被自动加载覆盖）
 */
function applyPathTextAutoload(
  meta: MetaYaml,
  schema: SchemaYaml,
  rootDir: string,
  computedSlug: string,
): void {
  const pathFields = (schema.fields.optional ?? []).filter((f) => f.type === "path");
  const ftsTextFields = (schema.fields.optional ?? []).filter(
    (f) => f.type === "text" && f.fts,
  );

  for (const pf of pathFields) {
    // 约定配对：xxx_path ↔ xxx_text
    if (!pf.name.endsWith("_path")) continue;
    const pairName = pf.name.replace(/_path$/, "_text");
    const tf = ftsTextFields.find((f) => f.name === pairName);
    if (!tf) continue; // 没有配对的 fts text 字段，跳过

    let pv = meta[pf.name];
    if (pv === undefined || pv === null) continue;
    pv = String(pv);

    // 1. 展开 <slug> 占位符
    if (pv.includes("<slug>")) {
      pv = pv.replace(/<slug>/g, computedSlug);
      meta[pf.name] = pv; // db 里存展开后的路径
      console.log(`>>> 展开 ${pf.name} 占位符：${pv}`);
    }

    // 2. 自动加载（仅当 meta.yaml 没显式提供 xxx_text）
    const existingText = meta[tf.name];
    if (existingText !== undefined && existingText !== null && existingText !== "") {
      // 用户显式提供的优先，跳过自动加载
      continue;
    }

    const fullPath = resolve(rootDir, pv);
    if (existsSync(fullPath)) {
      const content = readFileSync(fullPath, "utf-8");
      meta[tf.name] = content;
      console.log(
        `>>> 自动加载 ${tf.name} from ${fullPath} (${content.length} chars)`,
      );
    } else {
      console.warn(
        `>>> 警告：${pf.name}=${fullPath} 文件不存在，${tf.name} 将为 null（FTS 不可见该字段）`,
      );
    }
  }
}

// ===== v1.6.0 NEW: --load 外部文件落盘 =====

/**
 * --load <path_field>=<source_file>：把外部文件复制进 record 目录并写回路径字段。
 *
 * 设计：
 * - 只负责放文件 + 写路径，内容加载复用 applyPathTextAutoload 现有链路（不造第二条加载路径）。
 * - 目标解析：meta 已显式写 path 字段（可含 <slug> 占位符）→ 展开后作为目标；
 *   未写 → 默认 <slug>/<field 去掉 _path 后缀>.md，并写回 meta。
 * - 写回 db/落盘的永远是展开后的相对路径（正斜杠归一化，防 YAML 反斜杠转义问题），
 *   不是 resolve 后的绝对结果——保证库可搬迁；复制动作单独用绝对路径。
 * - 准入校验（fail loud）：字段必须在 schema 且 type:path 且存在 _path↔_text(fts) 配对
 *   （与 autoload 同一准入）；同字段重复出现报错（last-wins 会掩盖失误）；
 *   源文件不存在报错。
 * - 源与目标相同 → 跳过复制（部分平台 copyFileSync(src, src) 抛 EPERM）。
 */
function applyLoadArgs(
  meta: MetaYaml,
  schema: SchemaYaml,
  loads: string[],
  rootDir: string,
  finalSlug: string,
): void {
  if (loads.length === 0) return;
  const pathFields = new Map(
    (schema.fields.optional ?? []).filter((f) => f.type === "path").map((f) => [f.name, f]),
  );
  const ftsTextFields = (schema.fields.optional ?? []).filter(
    (f) => f.type === "text" && f.fts,
  );
  const seen = new Set<string>();

  // 第一遍：全部校验（fail loud，不产生任何副作用）
  const parsed: Array<{ fieldName: string; src: string }> = [];
  for (const item of loads) {
    // 首个 "=" 切分（源路径可能含 "="，不能用 split("=")）
    const eq = item.indexOf("=");
    if (eq <= 0) {
      throw new Error(`--load 参数格式错误：'${item}'。应为 --load <path_field>=<source_file>`);
    }
    const fieldName = item.slice(0, eq);
    const src = item.slice(eq + 1);

    if (seen.has(fieldName)) {
      throw new Error(`--load 字段 '${fieldName}' 重复出现（同字段只允许一次）`);
    }
    seen.add(fieldName);

    const pf = pathFields.get(fieldName);
    if (!pf) {
      const legal = [...pathFields.keys()].join(", ") || "（无）";
      throw new Error(
        `--load 字段 '${fieldName}' 不在 schema 的 path 类型字段中。合法 path 字段: ${legal}`,
      );
    }
    if (!fieldName.endsWith("_path")) {
      throw new Error(`--load 字段 '${fieldName}' 不满足 xxx_path 命名约定`);
    }
    const pairName = fieldName.replace(/_path$/, "_text");
    if (!ftsTextFields.some((f) => f.name === pairName)) {
      throw new Error(
        `--load 字段 '${fieldName}' 缺少配对的 fts text 字段 '${pairName}'（schema.yaml 需声明 type: text 且 fts: true）`,
      );
    }
    if (!existsSync(src)) {
      throw new Error(`--load 源文件不存在: ${src}`);
    }
    parsed.push({ fieldName, src });
  }

  // 第二遍：校验全过后统一复制（避免前一条已复制、后一条报错的部分执行状态）
  for (const { fieldName, src } of parsed) {
    // 目标路径：meta 已写（含 <slug> 占位符）→ 展开；未写 → 默认 <slug>/<field 去掉 _path>.md
    const raw = meta[fieldName];
    let rel = raw !== undefined && raw !== null ? String(raw) : "";
    if (rel.includes("<slug>")) rel = rel.replace(/<slug>/g, finalSlug);
    if (!rel) {
      rel = `${finalSlug}/${fieldName.replace(/_path$/, "")}.md`;
    }

    const targetAbs = resolve(rootDir, rel);
    const srcAbs = resolve(src);
    if (srcAbs !== targetAbs) {
      mkdirSync(dirname(targetAbs), { recursive: true });
      copyFileSync(srcAbs, targetAbs);
      console.log(`>>> --load ${fieldName}: ${srcAbs} → ${rel}`);
    } else {
      console.log(`>>> --load ${fieldName}: 源与目标相同，跳过复制`);
    }
    // 写回相对路径（正斜杠），保证 db 与库目录可整体搬迁
    meta[fieldName] = rel.replace(/\\/g, "/");
  }
}

// ===== 入库 =====

function ingestOne(
  kbPath: string,
  metaPath: string,
  loads: string[] = [],
): {
  slug: string;
  inserted: boolean;
  primaryKey: string;
  fts: Array<{ name: string; chars: number | null }>;
} {
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
    //    （v1.6.0 上移：先定最终 slug，再做 --load / autoload 等路径相关处理，
    //     防止重入库时文件落 computedSlug 目录而主键是旧 slug）
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

    // 5. v1.6.0 NEW: --load 外部文件落盘（先于 autoload：autoload 要从 <slug>/ 读内容）
    applyLoadArgs(meta, schema, loads, rootDir, slug);

    // 6. v1.5.0 path/text 自动配对加载 + <slug> 占位符展开（用最终 slug）
    applyPathTextAutoload(meta, schema, rootDir, slug);

    // 7. 建目录 + 写文件
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

    // 8. v1.6.0: 入库后主动 checkpoint（在 close 前，数据对任意新连接立即可见）
    const ck = db.prepare("PRAGMA wal_checkpoint(FULL)").get() as
      | { busy: number; log: number; checkpointed: number }
      | undefined;
    if (ck && ck.busy) {
      console.warn(
        ">>> 警告：wal_checkpoint 返回 busy=1（存在并发连接），本次未完成 FULL checkpoint，数据仍在 WAL 中（不影响读取）",
      );
    }

    // 9. v1.6.0: 回显 fts 字段长度（主表 content 列长度，供自检；非倒排索引内容量）
    const ftsFields = (schema.fields.optional ?? []).filter((f) => f.type === "text" && f.fts);
    const fts: Array<{ name: string; chars: number | null }> = ftsFields.map((f) => {
      try {
        const r = db
          .prepare(`SELECT length(${f.name}) AS len FROM ${primaryTable} WHERE ${primaryKey} = ?`)
          .get(slug) as { len: number | null } | undefined;
        return { name: f.name, chars: r?.len ?? null };
      } catch {
        return { name: f.name, chars: null };
      }
    });

    return { slug, inserted, primaryKey, fts };
  } finally {
    db.close();
  }
}

// ===== Mock meta.yaml（自测用） =====

/**
 * 内置 papers schema mock（向后兼容）。
 * v1.5.0 FIX: tags → tags_json（v1.4.0 严格校验下，mock 自身也必须用对的字段名）
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
tags_json: [SERS, AgNPs, dopamine, electrochemistry]
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

// ===== v1.5.0 NEW: mock 数据清理 =====

/**
 * 清理 mock 数据：按 slug 模式匹配（test_*_mock_* / mock_*_item）。
 *
 * 行为：
 *   1. 从 db 删除匹配的记录
 *   2. 列出对应的 record 目录（如有），提示用户手动删除
 *      （不自动删目录，避免误删——让用户确认）
 */
function cleanupMock(kbPath: string): { cleaned: number; dirs: string[] } {
  const { rootDir } = resolveKbPath(kbPath);
  const schema = loadSchema(rootDir);
  const primaryTable = schema.collection.primary_table;
  const primaryKey = schema.collection.primary_key ?? "slug";

  ensureSchema(kbPath);
  const db = openDb(kbPath);
  try {
    // 匹配两种 mock slug 模式
    const rows = db
      .prepare(
        `SELECT ${primaryKey} AS pk FROM ${primaryTable} ` +
          `WHERE ${primaryKey} LIKE 'test_%\_mock\_%' ESCAPE '\\' ` +
          `OR ${primaryKey} LIKE 'mock\_%\_item' ESCAPE '\\'`,
      )
      .all() as Array<{ pk: string }>;

    if (rows.length === 0) {
      console.log(">>> 没有 mock 数据需要清理");
      return { cleaned: 0, dirs: [] };
    }

    const tx = db.transaction(() => {
      for (const r of rows) {
        db.prepare(
          `DELETE FROM ${primaryTable} WHERE ${primaryKey} = ?`,
        ).run(r.pk);
      }
    });
    tx();

    // v1.6.0: 删库事务后同样 checkpoint（早退分支无写入，不需要）
    const ck = db.prepare("PRAGMA wal_checkpoint(FULL)").get() as { busy: number } | undefined;
    if (ck && ck.busy) {
      console.warn(">>> 警告：wal_checkpoint busy=1，本次未完成 FULL checkpoint");
    }

    const dirs: string[] = [];
    console.log(`>>> 已从 db 清理 ${rows.length} 条 mock 数据：`);
    for (const r of rows) {
      console.log(`    - ${r.pk}`);
      const recordDir = join(rootDir, r.pk);
      if (existsSync(recordDir)) {
        dirs.push(recordDir);
      }
    }

    if (dirs.length > 0) {
      console.log(`>>> 提示：以下 record 目录仍存在，请人工确认后删除（不自动删，防误删）：`);
      for (const d of dirs) {
        console.log(`    rm -rf "${d}"`);
      }
    }

    console.log(`>>> 建议后续：bun run scripts/backup.ts ${kbPath}`);
    return { cleaned: rows.length, dirs };
  } finally {
    db.close();
  }
}

// ===== CLI =====

function parseArgs(): {
  kbPath: string | null;
  metaPath: string | null;
  mock: boolean;
  mockSchemaPath: string | null;
  printSlug: boolean;
  cleanupMock: boolean;
  loads: string[];
} {
  let kbPath: string | null = null;
  let metaPath: string | null = null;
  let mock = false;
  let mockSchemaPath: string | null = null;
  let printSlug = false;
  let cleanupMockFlag = false;
  const loads: string[] = [];
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    const next = process.argv[i + 1];
    if (a === "--meta" && next) {
      metaPath = resolve(next);
      i++;
    } else if (a === "--load" && next) {
      // v1.6.0: 可多次出现，按 argv 顺序处理（各条目针对不同字段，互相独立）
      loads.push(next);
      i++;
    } else if (a === "--mock") {
      mock = true;
    } else if (a === "--schema" && next && mock) {
      // 改进：--mock --schema <path>：用指定 schema 生成 mock meta.yaml
      mockSchemaPath = resolve(next);
      i++;
    } else if (a === "--print-slug") {
      printSlug = true;
    } else if (a === "--cleanup-mock") {
      cleanupMockFlag = true;
    } else if (a === "--help" || a === "-h") {
      console.log(`用法: ingest.ts <kb-path> [options]
  <kb-path>              库路径
  --meta <file>         入库指定的 meta.yaml
  --load <field>=<file>  v1.6.0：把外部文件复制进 <slug>/ 并写回路径字段（可多次；
                         字段须为 schema 中的 xxx_path 类型且配对 fts text 字段）
  --mock                写入内置 mock meta.yaml（papers schema）并入库（向后兼容）
  --mock --schema <file>  用指定 schema 生成 mock meta.yaml 并入库（改进：适配任意业务）
  --print-slug          配合 --meta：预校验 + 只打印 slug 后退出（v1.5.0 加预校验；
                         v1.6.0 附带打印 --load 目标路径，零副作用不复制文件）
  --cleanup-mock        清理 mock 数据（按 slug 模式匹配 test_*_mock_* / mock_*_item）
  --help, -h            本帮助
`);
      process.exit(0);
    } else if (!kbPath) {
      kbPath = resolve(a);
    }
  }
  return { kbPath, metaPath, mock, mockSchemaPath, printSlug, cleanupMock: cleanupMockFlag, loads };
}

// ===== 入口（仅在直接运行时执行；被 import 时不执行）=====

function main(): void {
  const args = parseArgs();
  if (!args.kbPath) {
    console.error("需要 <kb-path>，或 --help");
    process.exit(1);
  }

  if (args.cleanupMock) {
    // v1.5.0 NEW: --cleanup-mock 单独分支（不需要 --meta / --mock）
    cleanupMock(args.kbPath);
  } else if (args.mock) {
    const metaPath = writeMockMeta(args.kbPath, args.mockSchemaPath);
    console.log(`>>> mock meta.yaml 写入：${metaPath}`);
    const { slug, inserted, primaryKey, fts } = ingestOne(args.kbPath, metaPath);
    console.log(`>>> ${inserted ? "inserted" : "updated"} ${primaryKey}: ${slug}`);
    for (const f of fts) {
      console.log(`>>> fts ${f.name}: ${f.chars === null ? "null" : `${f.chars} chars`} (column length)`);
    }
    // v1.5.0 NEW: mock 入库后输出清理命令
    console.log(`>>> 警告：mock 数据已入库（${slug}）`);
    console.log(`>>> 清理：bun run scripts/ingest.ts ${args.kbPath} --cleanup-mock`);
  } else if (args.metaPath) {
    if (args.printSlug) {
      const { rootDir } = resolveKbPath(args.kbPath);
      // v1.5.0 NEW: --print-slug 也跑校验（不用真入库就能发现字段名 / 类型问题）
      const schema = loadSchema(rootDir);
      const slugRule = loadSlugRule(rootDir);
      const meta = loadMetaYaml(args.metaPath);
      const { errors } = validateMeta(meta, schema);
      if (errors.length > 0) {
        throw new Error(
          `meta.yaml 校验失败（--print-slug 预检）：\n${errors.map((e) => `  - ${e}`).join("\n")}`,
        );
      }
      const slug = generateSlug(meta, slugRule);
      // v1.6.0: 预检 --load 目标路径（零副作用：只打印，不复制文件）
      if (args.loads.length > 0) {
        const pathFieldNames = new Set(
          (schema.fields.optional ?? []).filter((f) => f.type === "path").map((f) => f.name),
        );
        for (const item of args.loads) {
          const eq = item.indexOf("=");
          const fieldName = eq > 0 ? item.slice(0, eq) : item;
          const src = eq > 0 ? item.slice(eq + 1) : "";
          const raw = meta[fieldName] !== undefined && meta[fieldName] !== null ? String(meta[fieldName]) : "";
          let rel = raw.includes("<slug>") ? raw.replace(/<slug>/g, slug) : raw;
          if (!rel) rel = `${slug}/${fieldName.replace(/_path$/, "")}.md`;
          const legal = pathFieldNames.has(fieldName) ? "" : "（⚠ 字段不在 schema path 类型中，正式入库将报错）";
          console.log(`>>> --load 预检 ${fieldName}: ${src} → ${rel}${legal}`);
        }
      }
      console.log(slug);
      process.exit(0);
    }
    const { slug, inserted, primaryKey, fts } = ingestOne(args.kbPath, args.metaPath, args.loads);
    console.log(`>>> ${inserted ? "inserted" : "updated"} ${primaryKey}: ${slug}`);
    // v1.6.0: fts 字段长度回显（主表 content 列长度，供自检清单核对）
    for (const f of fts) {
      console.log(
        `>>> fts ${f.name}: ${f.chars === null ? "null" : `${f.chars} chars`} (column length)`,
      );
    }
  } else {
    console.error("需要 --meta <path> 或 --mock，或 --help");
    process.exit(1);
  }
}

// v1.5.1: 用 import.meta.main 守护，被 audit.ts import 时不执行入口
if (import.meta.main) {
  main();
}