# Changelog — local-kb

版本历史正本。格式参考 [Keep a Changelog](https://keepachangelog.com/)；版本号遵循 SemVer；当前版本以 SKILL.md frontmatter `version` 为准。

## [1.7.0] - 2026-10-21

### 文档结构重组（对齐仓库 CONTRIBUTING.md 规范）

- `INTEGRATION_GUIDE.md` 迁入 `references/integration-guide.md`：架构 / 部署 / 宿主指令文件精简 / 迁移 / 故障排查；§8 版本演进表迁入本文件
- 解耦私有概念：「Agent SOUL」表述改为「宿主指令文件（CLAUDE.md / AGENTS.md / SOUL.md，按宿主叫法）」；删除对维护者本机路径、宿主全局规则的引用；业务专属踩坑归属表述泛化为「宿主侧知识文件」
- `template.md` 去草稿化：删除草稿状态声明、维护者本机路径来源说明、§13 重构元说明；§11 踩坑表与集成指南重复，收敛为指向 `references/integration-guide.md §5`（单一正本，防两处漂移）
- SKILL.md frontmatter `description` 精简为纯路由信息（触发场景 + 适用场景），删除执行机制说明句
- `scripts/yaml.test.ts` 迁入 `tests/yaml.test.ts`（import 路径同步改为 `../scripts/yaml.ts`）
- `package.json`：license 修正为 `MulanPSL v2`；新增 `test` script（`bun test tests/`）

## [1.6.0]

- `clean.ts`：`--trim-head` / `--trim-tail` 锚点截断（出版社页面固定 chrome 一次截净；fail loud，未命中报错退出）
- `ingest.ts`：`--load` 直接带外部全文文件入库（自动复制到 `<slug>/` + 写回路径字段 + 自动 checkpoint + fts 字段长度回显）；`--print-slug` 附带打印 `--load` 目标路径（零副作用）

## [1.5.1] - 2026-07-10

- 新增 `scripts/audit.ts`：5 维度只读对账 + JSON 输出 + 退出码语义（0 健康 / 1 warning / 2 error / 3 参数错误）
- `ingest.ts` 导出 `loadSchema` / `loadSlugRule` / `loadMetaYaml` / `generateSlug` / `validateMeta` 及类型供 `audit.ts` 复用；入口加 `import.meta.main` 保护
- SKILL.md 补 audit 触发表、命令文档、反模式与自检清单

## [1.5.2] - 2026-07-11

- `yaml.ts`：修复 `key: |` block scalar 内含 `- item` 行被旧逻辑误解析为 array 的问题（已赋字符串值被覆盖）

## [1.5.0] - 2026-07-10

- `ingest.ts`：path/text 自动配对加载 + `<slug>` 占位符展开 + `--print-slug` 预校验 + `--cleanup-mock` 子命令 + mock yaml 字段名修正
- `template.md` 补 path/text 配对说明；集成指南补踩坑与故障排查

## [1.4.0] - 2026-07-10

- 架构重构：新增 `template.md` 通用接入指南 + `INTEGRATION_GUIDE.md` 集成指南
- `ingest.ts` 加 meta.yaml 字段名严格校验（约定大于配置：未知字段直接 err）

## [1.3.0] - 2026-07-10

- 业务别名（`query_aliases`）：schema.yaml 声明业务别名，setup 写入 `.slug-rule.json`，query / related 运行时自动翻译

## [1.2.0] - 2026-07-09

- 多项兼容性更新

## [1.0.0] - 2026-07-08

- 真正重构：补全 7 个 ts 脚本（setup / ingest / query / related / clean / backup / db），SKILL.md 只剩脚本调用入口

## [0.2.0] - 2026-07-08

- 改为「agent 直接照做的 Markdown 工作流」——仍无 scripts，方向错误

## [0.1.0] - 2026-07-08

- 初版：基于 papers/ + health_records/ 提炼的「通用方法论」——错误方向
