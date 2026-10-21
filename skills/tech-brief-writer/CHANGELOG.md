# CHANGELOG - tech-brief-writer

> 本文件面向本技能的编辑者。SKILL.md 是运行时注入面，只放执行指令；版本历史与维护契约一律落本文件。

## 维护契约

- 本技能无 tests 目录，改动 SKILL.md 后跑 `scan_zh_punct.mjs`（标点降级扫描）＋关键锚点 grep（确认引用的章节条目存在）。
- 改动同步两处：源码 `C:\CodeProjects\AI-Skills\skills\tech-brief-writer\` 与宿主副本 `workspace-chem\skills\tech-brief-writer\`，写回后 hash 比对一致才算完成。
- 修改 SKILL.md 或本文件后，在下方版本历史追加条目，只写改了什么。
- 范式简报（LTRS／SERDS 目录）是 skill 自带教学资产，随 skill 一起分发（2026-10-20 用户拍板）。

## 版本历史

- v4.4.0（2026-10-20）：运行时注入面瘦身（A 档，用户拍板）——① Mermaid 渲染验证 SOP 的 HTML 模板外置 `references/mermaid-verify-template.html`；② Canvas 散点反模式删 mulberry32 完整代码块（template.html 已封装），保留症状-修复-验证方法与关键纪律；③ 反模式 A/B/D 压成症状-根因-修复链，删展开代码；④ §五自检清单全部条目压缩为「项名＋一句合格判定＋指针」，删除与 §一／§二／§三／§四 的重复表述；⑤ DOI 决策树 ASCII 压成文字降级链；⑥ 删 §三·3.3「文件命名示意」条（原第 6 条 viewBox 顺移为第 5 条）；⑦ scripts 首选 .html 理由 4 条压 1 段。SKILL.md 32363 → 28662 字符（省 11.4%）；规则条目与清单项数零删减。
- v4.3.0 及更早：历史条目未另立档案，见各宿主副本历史记录。
