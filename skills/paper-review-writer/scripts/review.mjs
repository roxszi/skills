// review.mjs — 单入口 CLI（子命令分发）
// 用法：node review.mjs <子命令> --project <项目目录> [参数]
// 子命令与流水线阶段一一对应，见 SKILL.md 第 3 节；本文件只做参数解析与分发，不含业务逻辑。

import path from "node:path"
import { fileURLToPath } from "node:url"
import { projectRoot } from "./lib.mjs"
import { cmdDownload, cmdVerify } from "./sources.mjs"
import {
  cmdAssemble, cmdBrief, cmdCheck, cmdDigest, cmdDispatch, cmdExtract, cmdInit, cmdInitSummaries,
  cmdMap, cmdMaterial, cmdSave, cmdValidate,
} from "./pipeline.mjs"
import { cmdFigures, cmdExportHtml } from "./delivery.mjs"

const USAGE = `paper-review-writer — 批量文献调研综述流水线

用法：node review.mjs <子命令> [--project <项目目录>] [参数]

流水线子命令（按阶段顺序）：
  init              建项目骨架（目录 + 模板文件，已存在不覆盖）
  verify            元数据核验（Crossref/OpenAlex/Europe PMC/Unpaywall）→ papers_meta.verified.json
  download [--id]   合规下载（OA 链优先；③档白名单自动；④档第三方默认关）→ papers/*.pdf
  extract [--id]    PDF 逐页文本（EPMC XML 降级）→ papers_txt/*.txt
  digest [--id]     精读缓冲（≤2.6KB/篇，含图题索引）→ digests/*.md
  init-summaries    按清单初始化条目模板（read_status: missing）
  save --id         stdin JSON 落盘条目（校验；子会话专用）
  validate [--id]   校验条目（0 error 才通过）
  brief             主会话路由简报（≤320 字/篇）→ digests/brief.md
  material          综述素材包（校验通过条目）→ review-material.md
  assemble [--out X] 交付件 sections/{NN}_*.md 按序拼装为单文件综述
  check --review X  综述引用编号校验（素材包为合法集）→ review_check.json
  map [--out X]     文献映射章（条目 + 题录作者合流）→ deliverables/sections/09_文献映射.md
  dispatch [--batch N] [--context X]
                    精读派发任务单（待派队列 + 每篇任务卡全文）→ deliverables/dispatch.md
  figures [--id]    第 3.4 步·图表提取：逐篇跑两段提图链路 → figures/{id}_{slug}/fig_N.png + manifest
  export-html [--review X]
                    第 5 步·一键自包含 HTML：综述 md（缺省 deliverables/综述.md）→ 同名 .html（图片 base64 内嵌，零外链，独立可重入）

通用参数：
  --project <目录>  项目根目录（缺省当前目录）
  --id <编号>       只处理该论文（重试用）
  --allow-errors    save 时校验有错也落盘（不推荐）
  --allow-third-party  临时授权第三方渠道（默认关闭，显式开启才尝试）`

/** 极简参数解析：--key value 与 --bool 两种形态 */
function parseArgs(argv) {
  const args = { _: argv[0] || "" }
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith("--")) {
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
      const next = argv[i + 1]
      if (next === undefined || next.startsWith("--")) args[key] = true
      else {
        args[key] = next
        i++
      }
    }
  }
  return args
}

async function main() {
  const argv = process.argv.slice(2)
  const args = parseArgs(argv)
  const root = projectRoot(args)
  switch (args._) {
    case "init": return cmdInit(root)
    case "verify": return cmdVerify(root, args)
    case "download": return cmdDownload(root, args)
    case "extract": return cmdExtract(root, args)
    case "digest": return cmdDigest(root, args)
    case "init-summaries": return cmdInitSummaries(root)
    case "save": {
      if (!args.id) throw new Error("save 需要 --id <编号>")
      return cmdSave(root, args)
    }
    case "validate": return cmdValidate(root, args)
    case "brief": return cmdBrief(root)
    case "material": return cmdMaterial(root)
    case "assemble": return cmdAssemble(root, args)
    case "check": return cmdCheck(root, args)
    case "map": return cmdMap(root, args)
    case "dispatch": return cmdDispatch(root, args)
case "figures": return cmdFigures(root, args)
case "export-html": return cmdExportHtml(root, args)
    default:
      console.log(USAGE)
      if (args._ && args._ !== "help") process.exitCode = 2
  }
}

// bun 亦可直接运行本入口（见 SKILL.md 宿主适配表）；入口检测按文件名，不依赖 cwd
const isMain = process.argv[1] && path.basename(process.argv[1]) === path.basename(fileURLToPath(import.meta.url))
if (isMain) {
  main().catch(e => {
    console.error(`[review] ERROR：${e.message}`)
    process.exitCode = 1
  })
}
