# 触发评测归档：lexical 离线覆盖（v1.0.0 融合版）

- 日期：2026-10-20
- 触发原因：SKILL.md frontmatter description 更新（v1.0.0 融合版：插入 L0／L1／L2 档位词汇与「入库」「存档」「给我个专门的报告」触发语；原有全部触发词保留，纯超集式增强，未删除任何同学版 v0.3.0 触发词）。
- 命令：`node scripts\run_eval.mjs --queries tests\eval-queries.json --lexical`
- 结果：正例覆盖 12 / 12；负例显式排除条目 0（评测集无负例配置 expect_any，与 v0.3.0 基线一致，非本次改动引入）；退出码 0，达标。
- 模型路由探针（24 条子会话 + F1）：**待重跑**。理由：本次 description 为超集式增强，破坏路由的风险低；且模型探针依赖宿主子会话批量投递，成本高。安排：下次 description 实质性改动、技能清单增删或更换模型时，按 `references\触发评测流程.md` 一并重跑并归档到本目录（沿用 run 编号递增）。
- 运行环境：EasyClaw / Windows / node v22.19.0。
