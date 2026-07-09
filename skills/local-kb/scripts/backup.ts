/**
 * local-kb 备份脚本（SQLite WAL checkpoint + 轮转）。
 *
 * 用法：
 *   bun run scripts/backup.ts <kb-path>
 *   bun run scripts/backup.ts <kb-path> --dest <dir> --keep <n>
 *
 * 默认：
 *   --dest：库目录同级的 backups/<kb-name>/
 *   --keep：8 份
 *
 * 流程：
 *   1. PRAGMA wal_checkpoint(FULL) 把 WAL 合并到主文件
 *   2. copyFileSync 复制 db 主文件
 *   3. utimesSync(now, now) 刷 mtime（⚠️ 必须！避免同日多次备份 mtime 相同）
 *   4. readonly 模式打开 backup 做 verify
 *   5. 按 mtime 升序排，保留最新 N 份
 *   6. 清理 .db-shm / .db-wal（Windows mmap 锁定需延迟重试）
 *
 * **关键反模式**（绝不能犯）：
 *   ❌ 用 Array.sort() 默认字典序排 backup 文件名
 *      → `kb-2026-07-08.172353.db`（"1" 码点 0x31 < "d" 0x64）会被排到
 *        `kb-2026-07-08.db` 前面，导致新备份被误删为"最老的"
 *   ❌ copyFileSync 后不 utimesSync 刷 mtime
 *      → 同日多次备份 mtime 全相同，sort 退化成不稳定排序
 *   ❌ 备份目录与库目录在同一块磁盘
 *      → 硬盘故障一起挂
 */

import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  statSync,
  readdirSync,
  unlinkSync,
  copyFileSync,
  utimesSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { resolveKbPath } from "./db.ts";

function parseArgs(): { kbPath: string | null; dest: string; keep: number } {
  let kbPath: string | null = null;
  let dest = "";
  let keep = 8;
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    const next = process.argv[i + 1];
    if (a === "--dest" && next) {
      dest = next;
      i++;
    } else if (a === "--keep" && next) {
      keep = Number(next);
      i++;
    } else if (a === "--help" || a === "-h") {
      console.log(`用法: backup.ts <kb-path> [--dest <dir>] [--keep <n>]
  --dest <dir>    备份目录（默认 <kb-path>/../backups/<kb-name>）
  --keep <n>      保留份数（默认 8）
  --help, -h      本帮助
`);
      process.exit(0);
    } else if (!kbPath) {
      kbPath = a;
    }
  }
  return { kbPath, dest, keep };
}

function isoDateStamp(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const args = parseArgs();
if (!args.kbPath) {
  console.error("需要 <kb-path>");
  process.exit(1);
}

const { dbPath, rootDir } = resolveKbPath(args.kbPath);
if (!existsSync(dbPath)) {
  console.error(`>>> 数据库不存在: ${dbPath}`);
  console.error(">>> 请先运行 setup.ts 建库");
  process.exit(1);
}

const kbName = args.kbPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "kb";
const dest = args.dest || join(dirname(rootDir), "backups", kbName);
mkdirSync(dest, { recursive: true });

const baseName = `${kbName}-${isoDateStamp()}.db`;
let outPath = join(dest, baseName);

if (existsSync(outPath)) {
  const d = new Date();
  const stamp = `${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}`;
  outPath = join(dest, `${kbName}-${isoDateStamp(d)}.${stamp}.db`);
}

// 1. WAL checkpoint
const db = new Database(dbPath);
try {
  const ck = db.prepare("PRAGMA wal_checkpoint(FULL)").get() as {
    busy: number;
    log: number;
    checkpointed: number;
  };
  if (ck.busy !== 0) {
    console.warn(`>>> checkpoint busy=${ck.busy}（其他连接在写），备份可能略陈旧`);
  }
} finally {
  db.close();
}

// 2. copyFileSync
try {
  copyFileSync(dbPath, outPath);
} catch (e) {
  console.error(`>>> copyFile 失败: ${(e as Error).message}`);
  process.exit(1);
}

// 3. ⚠️ utimesSync 刷 mtime
const now = new Date();
try {
  utimesSync(outPath, now, now);
} catch (e) {
  console.warn(`>>> utimes 失败（不影响备份完整性，仅影响轮转排序）: ${(e as Error).message}`);
}

// 4. verify
let verifyMsg = "";
try {
  const v = new Database(outPath, { readonly: true });
  const tables = v
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' OR type='view'")
    .get() as { n: number };
  v.close();
  verifyMsg = `${tables.n} table(s)/view(s)`;
} catch (e) {
  verifyMsg = `verify failed: ${(e as Error).message}`;
}

let sizeMsg = "";
try {
  sizeMsg = `${statSync(outPath).size} bytes`;
} catch {
  sizeMsg = "(size unavailable)";
}

console.log(`>>> backup OK: ${outPath}`);
console.log(`    ${sizeMsg}, ${verifyMsg}`);

// 5. 清理临时文件
async function tryRemove(path: string, attempts = 5): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (!existsSync(path)) return true;
    try {
      unlinkSync(path);
      return true;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return true;
      if (code !== "EBUSY" && code !== "EPERM") {
        console.warn(`>>> 清理 ${path} 失败: ${(e as Error).message}`);
        return false;
      }
      await new Promise((r) => setTimeout(r, 80 + i * 60));
    }
  }
  return false;
}

queueMicrotask(async () => {
  for (const suffix of ["-shm", "-wal"]) {
    const f = outPath + suffix;
    if (await tryRemove(f)) {
      if (!existsSync(f)) console.log(`>>> removed: ${f}`);
    }
  }
});

// 6. 轮转
function listBackups(): string[] {
  if (!existsSync(dest)) return [];
  return readdirSync(dest)
    .filter((f) => f.startsWith(`${kbName}-`) && f.endsWith(".db"))
    .map((f) => {
      const full = join(dest, f);
      return { full, mtime: statSync(full).mtimeMs };
    })
    .sort((a, b) => a.mtime - b.mtime)
    .map((x) => x.full);
}

function pruneOldBackups(keep: number): string[] {
  if (keep <= 0) return [];
  const all = listBackups();
  const toDelete = all.slice(0, Math.max(0, all.length - keep));
  const removed: string[] = [];
  for (const f of toDelete) {
    try {
      unlinkSync(f);
      removed.push(f);
    } catch (e) {
      console.warn(`>>> 清理旧备份失败: ${f}: ${(e as Error).message}`);
    }
  }
  return removed;
}

const removed = pruneOldBackups(args.keep);
if (removed.length > 0) {
  console.log(`>>> pruned ${removed.length} old backup(s):`);
  for (const f of removed) console.log(`    - ${f}`);
}
console.log(`>>> kept last ${args.keep} backup(s) in ${dest}`);