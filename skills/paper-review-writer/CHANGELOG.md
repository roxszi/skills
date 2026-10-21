# paper-review-writer 版本历史

> 本文件面向 skill 编写者：版本演进、设计取舍、致谢声明记录于此。使用者业务闭环不需要读本文件；SKILL.md 正文不携带版本历史。

## 0.1.2（2026-10-21）

- 运行时可移植整改（用户指出 pnpm install 写死属宿主依赖）：安装指引兼容 npm/pnpm/bun；适配表注明「示例命令以 node 书写，bun 等价可跑」；extract 依赖缺失报错改中性表述；SKILL.md 与条目契约的命令示例及产物路径全部改正斜杠（跨平台通吃）；运行时下限实测校准为 node ≥ 22.13（pdfjs-dist 6 engines 要求 `>=22.13.0 || >=24`，曾误写 18）。

## 0.1.1（2026-10-21）

- 按「skill 双线规则」整改（正本 `ai-shared\shared-note\skill-dual-line.md`）：版本历史与设计渊源移出 SKILL.md 主文落本文件；description 删负例排除句「单篇精读与逐篇方法学审查不适用本技能」（路由靠正例命中，负例不入简介）。
- node_modules 移出 skill 目录（分发资产保持轻量）：package.json 与 pnpm-lock.yaml 保留，首次使用前在 skill 目录执行 `pnpm install`；extract 命令对依赖缺失给明确报错。

## 0.1.0（2026-10-21）

- 首版。由 Paper-review-kit v0.3.0（MIT，castiel0519/Paper-review-kit）迁移重造。致谢：其 token 四层分层、证据强制、素材包与引用校验闭环的设计思想为本技能直接来源；schema、脚本与工作流按本技能场景全部用 Node 重写。
- 保留：token 四层分层／证据强制／元数据核验链（Crossref→OpenAlex→Europe PMC→Unpaywall）／合规下载链（第三方渠道默认关）／素材包与引用编号校验。
- 改造：Python 24 脚本 → Node 单入口 `scripts\review.mjs` 11 子命令；YAML 配置 → 全 JSON；阅读深度三态升级为四态并对齐宿主精读类技能词汇；条目字段命名对齐同类技能（化学扩展字段默认含、标注可按领域增删）。
- 裁撤：DOCX 读书报告与每篇两页 PPT（综述 MD 正本，交稿格式走宿主文档能力）；PyMuPDF 图提取（改 digest 尾部图题页码索引，看图按页码用宿主 PDF 能力）。
- 验证：回归 18 断言；JCIM 28 页真实 PDF 提取/切块/图题索引实测；核验链真实 API 实测（Crossref/OpenAlex 回填成功；Unpaywall 拒假邮箱属预期）；引用校验剔除逻辑实测。
