/**
 * yaml.ts 单元测试
 *
 * 重点验证：block scalar 内部行的处理（修复 2026-07-11）。
 * 修复背景：`key: |` 内含 `- item` 行会被旧逻辑误解析为 array。
 *
 * 运行：bun test scripts/yaml.test.ts
 */
import { test, expect } from "bun:test";
import { parseYaml } from "./yaml.ts";

test("block scalar 内嵌 `- item` 列表项：应作为字符串保留全部内容", () => {
  const yaml = `notes: |
  【段落一】这是第一段。

  【段落二】下面是列表：
  - item one
  - item two
  - item three

  【段落三】结尾段落。
`;
  const obj = parseYaml(yaml);
  expect(typeof obj.notes).toBe("string");
  expect(Array.isArray(obj.notes)).toBe(false);
  expect(obj.notes).toContain("【段落一】");
  expect(obj.notes).toContain("【段落二】");
  expect(obj.notes).toContain("【段落三】");
  expect(obj.notes).toContain("- item one");
  expect(obj.notes).toContain("- item two");
  expect(obj.notes).toContain("- item three");
});

test("block scalar 内嵌 `nested: value` 形式：应作为字符串保留", () => {
  const yaml = `notes: |
  第一行普通文本。
  fake_key: fake_value
  还有更多文本。
`;
  const obj = parseYaml(yaml);
  expect(typeof obj.notes).toBe("string");
  expect(obj.notes).toContain("第一行普通文本。");
  expect(obj.notes).toContain("fake_key: fake_value");
  expect(obj.notes).toContain("还有更多文本。");
  // 不应该把 fake_key 当作 root level 的 key
  expect((obj as any).fake_key).toBeUndefined();
});

test("普通 `key:` + 列表（合法用法，不应被破坏）", () => {
  const yaml = `authors:
  - Alice
  - Bob
  - Charlie
`;
  const obj = parseYaml(yaml);
  expect(Array.isArray(obj.authors)).toBe(true);
  expect(obj.authors).toEqual(["Alice", "Bob", "Charlie"]);
});

test("inline array `key: [a, b, c]`（合法用法）", () => {
  const yaml = `tags: [SERS, deep-learning, CNN]
`;
  const obj = parseYaml(yaml);
  expect(Array.isArray(obj.tags)).toBe(true);
  expect(obj.tags).toEqual(["SERS", "deep-learning", "CNN"]);
});

test("block scalar 折叠模式 `>`：行内换行 → 空格", () => {
  const yaml = `summary: >
  This is line one.
  This is line two.

  This is a new paragraph.
`;
  const obj = parseYaml(yaml);
  expect(typeof obj.summary).toBe("string");
  expect(obj.summary).toContain("This is line one. This is line two.");
  expect(obj.summary).toContain("This is a new paragraph.");
});

test("多个 block scalar 共存：互不干扰", () => {
  const yaml = `title: "Test Paper"
notes: |
  这是第一段。
  - list inside notes
  这是最后一段。
abstract: |
  Abstract content here.
  Also has multiple lines.
`;
  const obj = parseYaml(yaml);
  expect(obj.title).toBe("Test Paper");
  expect(typeof obj.notes).toBe("string");
  expect(obj.notes).toContain("这是第一段。");
  expect(obj.notes).toContain("- list inside notes");
  expect(obj.notes).toContain("这是最后一段。");
  expect(typeof obj.abstract).toBe("string");
  expect(obj.abstract).toContain("Abstract content here.");
});

test("block scalar 与合法列表共存：合法列表仍正确解析", () => {
  const yaml = `title: "Test"
authors:
  - Alice
  - Bob
notes: |
  正文段落。
  - this should be string, not array
  更多正文。
tags:
  - tag1
  - tag2
`;
  const obj = parseYaml(yaml);
  expect(obj.title).toBe("Test");
  expect(obj.authors).toEqual(["Alice", "Bob"]);
  expect(typeof obj.notes).toBe("string");
  expect(obj.notes).toContain("正文段落。");
  expect(obj.notes).toContain("- this should be string, not array");
  expect(obj.tags).toEqual(["tag1", "tag2"]);
});

test("block scalar chomp mode `|-` strip：去掉尾部换行", () => {
  const yaml = `text: |-
  line one
  line two
`;
  const obj = parseYaml(yaml);
  expect(obj.text).toBe("line one\nline two");
});

test("嵌套对象中的 block scalar（schema.yaml 常见结构）", () => {
  const yaml = `fields:
  required:
    - { name: title, type: string }
  optional:
    - { name: notes, type: text }
notes: |
  正文。
  - fake list item
`;
  const obj = parseYaml(yaml);
  expect(typeof obj.notes).toBe("string");
  expect(obj.notes).toContain("正文。");
  expect(obj.notes).toContain("- fake list item");
  expect((obj as any).fields).toBeDefined();
  expect((obj as any).fields.required[0].name).toBe("title");
});

test("真实 guo_2026 场景：长 block scalar 含中文 + 列表 + 多段", () => {
  const yaml = `slug: "test"
title: "Test"
notes: |
  【一句话结论】核心贡献。

  【四层防线】
  1. 样品前处理。
  2. 基底选择。

  【两大硬骨头】
  - hotspot 空间异质
  - coffee-ring 沉积不均

  【局限】
  - 每种新表面要单独训练
  - 报告偏差
`;
  const obj = parseYaml(yaml);
  expect(typeof obj.notes).toBe("string");
  expect(obj.notes).toContain("【一句话结论】");
  expect(obj.notes).toContain("【四层防线】");
  expect(obj.notes).toContain("【两大硬骨头】");
  expect(obj.notes).toContain("- hotspot 空间异质");
  expect(obj.notes).toContain("- coffee-ring 沉积不均");
  expect(obj.notes).toContain("【局限】");
  expect(obj.notes).toContain("- 每种新表面要单独训练");
});
