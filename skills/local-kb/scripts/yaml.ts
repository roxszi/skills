/**
 * local-kb YAML 解析（共享模块，setup.ts / ingest.ts 都引用）。
 *
 * 设计目标：
 * - 零依赖（仅用 node:fs / node:path）
 * - 支持 schema.yaml / meta.yaml 的核心语法
 * - 自动识别关键模式（避免常见误解析）
 *
 * 支持的 YAML 语法：
 * - key: value                          # 普通 KV
 * - key: [a, b, c]                      # inline array
 * - key: { name: x, type: y }           # inline object
 * - key:                                # 嵌套对象 / 列表头
 *   - a
 *   - b
 * - key: |                              # block scalar (literal)
 *   line1
 *   line2
 * - key: >-                             # block scalar (folded, strip trailing)
 *   line1
 *   line2
 * - key: "value with : colons"          # 双引号字符串
 * - # 整行注释
 * - key: value  # 行内注释              # 改进：支持行内注释
 *
 * 自动识别：
 * - ISO 8601 时间戳（YYYY-MM-DDTHH:MM:SS[.sss][Z|+HH:MM]）→ 当字符串返回
 *
 * 不支持（明确边界）：
 * - 多文档 `---`
 * - 锚点 & 引用（& /*）
 * - 复杂 tag（!!str 等）
 */

export type YamlValue = string | number | boolean | string[] | YamlObject | YamlObject[] | unknown[];
export interface YamlObject {
  [key: string]: YamlValue;
}

// ===== 行内注释处理 =====

/**
 * 剥除行内注释（不在引号内的 `# ...` 部分）。
 *
 * 例：`{ name: x, type: string } # 注释` → `{ name: x, type: string }`
 */
export function stripInlineComment(raw: string): string {
  let inQuote: '"' | "'" | null = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === "#") {
      return raw.slice(0, i).replace(/\s+$/, "");  // 去掉尾部空白
    }
  }
  return raw;
}

// ===== ISO 8601 自动识别 =====

const ISO8601_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function looksLikeIso8601(s: string): boolean {
  return ISO8601_RE.test(s);
}

// ===== 主解析函数 =====

/**
 * 解析 YAML 文本为对象。
 *
 * 改进点（相对原内嵌版本）：
 * 1. 支持行内注释 `key: value # 注释`
 * 2. 支持 block scalar (`|` / `>-` / `|-` / `|+`)
 * 3. 自动识别 ISO 8601 时间戳，避免被当 KV 解析
 */
export function parseYaml(text: string): YamlObject {
  const rawLines = text.split(/\r?\n/);

  // 预处理 1：识别 "key:" 后面紧跟列表项 / block scalar 的行号
  const keyWithList = new Set<number>();
  const blockScalarMarkers = new Map<number, { indent: number; chomp: "clip" | "strip" | "keep"; folding: boolean }>();
  // block scalar 内部行号（不含 marker 行）。主循环跳过这些行，避免把 block 内容误解析为 list/kv
  // 修复场景：`key: |` 内部含 `- item` 或 `nested_key: value` 行时，旧逻辑会进入 listMatch/kvMatch 分支
  // 把已赋好的字符串值覆盖为 array/object。详见 test case: block scalar 内嵌列表项。
  const blockScalarInnerLines = new Set<number>();

  for (let i = 0; i < rawLines.length; i++) {
    const cur = rawLines[i];
    if (!cur.trim() || cur.trim().startsWith("#")) continue;

    const stripped = stripInlineComment(cur).trim();
    const curIndent = cur.match(/^ */)?.[0].length ?? 0;

    // 检测 block scalar 头：`key: |` 或 `key: >-` 等
    const blockMatch = stripped.match(/^([\w-]+):\s*([|>])([-+]?)\s*$/);
    if (blockMatch) {
      let chomp: "clip" | "strip" | "keep" = "clip";
      if (blockMatch[3] === "-") chomp = "strip";
      else if (blockMatch[3] === "+") chomp = "keep";
      blockScalarMarkers.set(i, { indent: curIndent, chomp, folding: blockMatch[2] === ">" });
      // 标记 block scalar 占用的内部行号（与主循环 block scalar 收集逻辑严格一致）
      for (let j = i + 1; j < rawLines.length; j++) {
        const next = rawLines[j];
        if (!next.trim()) {
          // 空行属于 block scalar 内容（主循环本来也会跳过，加入 Set 不影响行为）
          blockScalarInnerLines.add(j);
          continue;
        }
        const nextIndent = next.match(/^ */)?.[0].length ?? 0;
        if (nextIndent <= curIndent) break;
        blockScalarInnerLines.add(j);
      }
      continue;
    }

    // 检测 "key:" 后紧跟列表
    if (stripped.match(/^[\w-]+:\s*$/)) {
      if (i + 1 < rawLines.length) {
        const next = rawLines[i + 1];
        const nextIndent = next.match(/^ */)?.[0].length ?? 0;
        const nextTrimmed = next.trim();
        if (nextIndent > curIndent && nextTrimmed.startsWith("- ")) {
          keyWithList.add(i);
        }
      }
    }
  }

  const root: YamlObject = {};
  const stack: { indent: number; obj: any }[] = [{ indent: -1, obj: root }];

  for (let li = 0; li < rawLines.length; li++) {
    const raw = rawLines[li];
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    // 跳过 block scalar 内部行：这些行已在 block marker 行的收集逻辑里整体作为字符串赋值，
    // 不应再进入 listMatch / kvMatch 分支（否则会覆盖已赋好的字符串值）。
    if (blockScalarInnerLines.has(li)) continue;
    const indent = raw.match(/^ */)?.[0].length ?? 0;
    const trimmed = stripInlineComment(raw).trim();

    // Block scalar 处理
    if (blockScalarMarkers.has(li)) {
      const marker = blockScalarMarkers.get(li)!;
      const keyMatch = trimmed.match(/^([\w-]+):\s*[|>][-+]?\s*$/);
      if (!keyMatch) continue;
      const key = keyMatch[1];

      // 找到父对象
      while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
      const parent = stack[stack.length - 1];

      // 收集后续行（缩进 > marker.indent）
      const collected: string[] = [];
      const contentIndent = marker.indent + 2;  // 标准 YAML 要求内容缩进比 key 多
      for (let j = li + 1; j < rawLines.length; j++) {
        const next = rawLines[j];
        if (!next.trim()) {
          collected.push("");
          continue;
        }
        const nextIndent = next.match(/^ */)?.[0].length ?? 0;
        if (nextIndent <= marker.indent) break;
        // 去掉公共缩进
        const strippedNext = next.slice(contentIndent);
        collected.push(strippedNext);
      }

      let value: string;
      if (marker.folding) {
        // `>` 折叠：行内换行 → 空格，段落间换行（连续空行）→ 双换行
        const text = collected.join("\n");
        const paragraphs = text.split(/\n{2,}/);
        value = paragraphs.map(p => p.replace(/\n/g, " ")).join("\n\n");
      } else {
        // `|` literal：保留所有换行
        value = collected.join("\n");
      }

      // chomp 处理
      if (marker.chomp === "strip") {
        value = value.replace(/\n+$/, "");
      } else if (marker.chomp === "keep") {
        // 保留所有尾部换行
      } else {
        // clip 默认：去掉尾部单个换行
        value = value.replace(/\n+$/, "");
      }

      parent.obj[key] = value;
      continue;
    }

    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1];

    // 列表项
    const listMatch = trimmed.match(/^- (.+)$/);
    if (listMatch) {
      const val = parseScalar(listMatch[1]);
      if (Array.isArray(parent.obj)) {
        parent.obj.push(val);
      } else {
        const lastKey = Object.keys(parent.obj).at(-1);
        if (lastKey !== undefined) {
          if (!Array.isArray(parent.obj[lastKey])) {
            parent.obj[lastKey] = [];
          }
          parent.obj[lastKey].push(val);
        }
      }
      continue;
    }

    // key-value
    const kvMatch = trimmed.match(/^([\w-]+):\s*(.*)$/);
    if (!kvMatch) continue;
    const key = kvMatch[1];
    const rawVal = kvMatch[2].trim();

    if (rawVal === "") {
      if (keyWithList.has(li)) {
        parent.obj[key] = [];
      } else {
        parent.obj[key] = {};
      }
      stack.push({ indent, obj: parent.obj[key] });
    } else if (rawVal.startsWith("[") && rawVal.endsWith("]")) {
      parent.obj[key] = parseInlineArray(rawVal.slice(1, -1));
    } else if (rawVal.startsWith("{") && rawVal.endsWith("}")) {
      parent.obj[key] = parseInlineObject(rawVal.slice(1, -1));
    } else {
      parent.obj[key] = parseScalar(rawVal);
    }
  }

  return root;
}

// ===== Scalar / Inline 解析 =====

export function parseScalar(raw: string): YamlValue {
  if (raw === "true") return true;
  if (raw === "false") return false;

  // 改进：自动识别 ISO 8601 时间戳 → 当字符串返回
  if (looksLikeIso8601(raw)) return raw;

  const m = raw.match(/^["'](.*)["']$/);
  if (m) return m[1];
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (raw.startsWith("[") && raw.endsWith("]")) {
    return parseInlineArray(raw.slice(1, -1));
  }
  if (raw.startsWith("{") && raw.endsWith("}")) {
    return parseInlineObject(raw.slice(1, -1));
  }
  const kvMatch = raw.match(/^([\w-]+):\s*(.*)$/);
  if (kvMatch) {
    return { [kvMatch[1]]: parseScalar(kvMatch[2]) };
  }
  return raw;
}

export function parseInlineArray(text: string): string[] {
  const items: string[] = [];
  let buf = "";
  let quote: '"' | "'" | null = null;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      else buf += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ",") {
      items.push(buf.trim());
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) items.push(buf.trim());
  return items;
}

export function parseInlineObject(text: string): YamlObject {
  const obj: YamlObject = {};
  let buf = "";
  let quote: '"' | "'" | null = null;
  let depth = 0;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      buf += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
    } else if (ch === "{") {
      depth++;
      buf += ch;
    } else if (ch === "}") {
      depth--;
      buf += ch;
    } else if (ch === "," && depth === 0) {
      const kv = buf.trim().match(/^([\w-]+):\s*(.*)$/);
      if (kv) obj[kv[1]] = parseScalar(stripInlineComment(kv[2]));
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) {
    const kv = buf.trim().match(/^([\w-]+):\s*(.*)$/);
    if (kv) obj[kv[1]] = parseScalar(stripInlineComment(kv[2]));
  }
  return obj;
}