# 触发评测归档：lexical 离线覆盖（v1.1.0 术语清理后复检）

- 日期：2026-10-20
- 触发原因：用户裁决「内部术语不外泄用户交互面」后，description 去 L0／L1／L2 代号（含残留的「（L2）」括号标注），档位表述改为「速览／精读／精读后成文存档」。
- 命令：`node scripts\run_eval.mjs --queries tests\eval-queries.json --lexical`
- 结果：正例覆盖 12 / 12；description 367 字符；负例显式排除条目 0（评测集无负例配置 expect_any，与基线一致）；退出码 0，达标。
- 同批验证：回归测试 13 断言 ALL PASS；SKILL.md 全文 L 代号残留扫描——仅剩 §11 红线禁令条款（引用术语以禁止之，合法）与版本历史（历史事实记录，合法）。
- 模型路由探针（24 条子会话 + F1）：待重跑，理由同 run2（超集式/低风险改动 + 探针成本高），下次 description 实质改动或换模型时一并跑。
- 运行环境：EasyClaw / Windows / node v22.19.0。
