# 外部 API 契约与出版商端点速查

> 使用者线：改网络层代码（`scripts/sources.mjs` 的核验链与下载候选链）或排查获取失败前先读本表。
> 全部条目带实测日期——与新现象冲突时按新实测覆盖旧条目并更新日期，不凭记忆改代码。
> 实测环境：教育网（CERNET2）出口；其他网络环境可能不同，跨环境使用前先做一次小样本探测。

## A. 学术 API 契约（反直觉事实）

| 事实 | 要点 | 实测 / 依据 |
|---|---|---|
| Crossref `/works/{doi}` 不支持 `select` | 任何 select 组合都 400 parameter-not-allowed；select 仅 `/works` 检索端点可用 | 2026-10-26 实测 |
| OpenAlex 无 key 配额按 IP 共享 | 免费预算按网络出口 IP 全网共享（教育网整校一池）；429 报错原文含「shared by everyone on your network's IP address」；带 key 日预算约 ×10（`apis.openalex_key`） | 官方文档 2026-10-15 + 实测 |
| OpenAlex 批量 OR | 单 filter 内 `\|` 至多 100 值、per-page ≤100；`filter=doi:https://doi.org/a\|b` 实测命中正确——verify 的批量补拉走此路（50/批） | 官方文档 2026-10-23 + 实测 |
| OpenAlex 多算子查询独立限速 | 无 key 时含 >5 个 OR/AND/NOT 的 search 限 1 req/s | 官方文档 |
| OpenAlex select 支持 `abstract_inverted_index` | 倒排索引按位置重排可还原摘要；OpenAlex 摘要覆盖与 EPMC 互补（117 篇实测 66 vs 72，并集 99） | 2026-10-26 实测 |
| OpenAlex 引用网络可用；EPMC 不可用 | `filter=cites:{openalex_id}` 取被引列表实测可用；EPMC 的 `CITES:`/`REFERENCES:` 五种写法全 0 命中，勿用 | 2026-10-26 实测 |
| Semantic Scholar 限流是 IP 级 | 公开配额极紧，429 常态（含 15 秒退避后仍 429）；换网络即恢复；batch 端点单次 500 id / 10 MB，限流期内同样不可用 | 官方文档 + 2026-10-26 实测 |
| S2 `openAccessPdf` 的独特价值 | closed 文献的机构库合法副本唯一系统来源（实测命中 Manchester Metropolis/UC 等仓储副本）；多为作者接受稿，页码与出版版可能不符——精读时按 EPMC XML 无页码源口径处理（章节号锚点） | 2026-10-26 实测 |
| Unpaywall 邮箱 | 缺 `email` 参数 422；占位邮箱实测也返回 200，但正式项目用真实邮箱（礼貌池与统计口径，官方要求勿替用户编造） | 2026-10-26 实测 |
| CORE v3 / OpenAIRE 期望值要低 | 对闭锁 Elsevier/ACS 基本无效（downloadUrl 空 / 解析不出 PDF），不进下载候选链，仅欧洲非 OpenAlex 索引仓储有边际价值 | 2026-10-26 实测 |
| DOI 内容协商 | `Accept: application/vnd.citationstyles.csl+json` 可取题录但无摘要，不作核验主力 | 2026-10-26 实测 |

## B. 出版商直链端点表（脚本直连候选链）

规则：新增渠道先实测再进表进代码（`sources.mjs` 的 `publisherUrls`）；403 常见，本表只是候选链的一档；
浏览器路线与渠道四档是拦截后的主路径。

| 出版商 | 端点模板 | 脚本直连实测（教育网 2026-10-26） |
|---|---|---|
| Springer | `https://link.springer.com/content/pdf/{doi}.pdf`（首选）＋ `…/article/{doi}.pdf`（备） | 200（含部分非 OA 刊） |
| Frontiers | `https://www.frontiersin.org/articles/{doi}/pdf` | 200 |
| MDPI 存档域 | `https://mdpi-res.com/d_attachment/{j}/{j}-{vol2}-{art5}/article_deploy/{j}-{vol2}-{art5}.pdf`；{j}=刊名缩写（Crossref `short-container-title` 小写去非字母；缺该字段回退 `container-title` 全拼——IJMS 存档域名是 ijms，全拼恒 404，2026-10-26 实测 5 刊 short 小写=存档域名）；vol2=卷号补零 2 位，art5=文章号补零 5 位；**卷号/文章号从 Crossref 的 `volume`/`article-number` 取（article-number 缺失时 page 回退，MDPI 实测 page 即文章号），不从 DOI 尾段硬拆**（coatings8110394 = 卷 8 文章 0394，拆成「卷 81」会 404） | 200；缺题录结构字段时放弃不猜 |
| MDPI 主站 | `https://www.mdpi.com/...` | 脚本 403、浏览器 200（浏览器路线净增益） |
| Nature | `https://www.nature.com/articles/{DOI尾段}.pdf` | 沿用既有候选 |
| Wiley | `…/doi/pdfdirect/{doi}` ＋ `…/doi/pdf/{doi}` | 教育网脚本 403 常态 |
| ACS / RSC / AIP | `doi/pdf/{doi}` / `articlepdf/{尾段}` / AIP 模板（见 sources.mjs） | ACS/RSC 脚本 403 + 浏览器 Cloudflare 挑战页（Ray ID） |
| Elsevier | **无可用直链**：DOI 尾段不是 PII，拼不出正确 URL（旧实现从未成立过）；ScienceDirect 对校园 IP 段整段封禁，拒绝页特征 CPE00001 / 列出「IP Address:」/ robot 文案无验证控件，官方说明封禁自动释放 | 处置：换出口（playbook §7）→ 浏览器路线 → 渠道四档 |
