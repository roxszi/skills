# 出版商网页全文提取通用流程（回退层）

> 适用于任何出版商站点（ACS / Elsevier / Springer / Wiley / RSC / Nature / MDPI 等），以及特化模板失效后的站点改版场景。
> 设计原则：选择器不硬编码，正文容器靠侦察定位；语义 walk 与分块落盘跨站通用。
> 执行环境：在已打开的文章页 tab 内用宿主的浏览器 JS 执行能力（工具名见 SKILL.md §1.0 适配表）运行下方代码；返回体大时分块取，再落盘。无浏览器时用宿主的网页抓取能力取 HTML 作回退。

## 第 1 步：侦察正文容器

```js
(() => {
  var els = Array.from(document.querySelectorAll('div,section,article'))
    .filter(el => el.innerText && el.innerText.length > 3000)
    .map(el => ({ tag: el.tagName, cls: String(el.className).substring(0, 80), id: el.id || '', len: el.innerText.length }));
  return JSON.stringify({ title: document.title, containers: els.slice(0, 20) });
})()
```

正文容器按序判据：

1. 长度显著大于其他候选（期刊正文通常 ≥ 5 万字符）；
2. 子树含 h2–h4 标题层级与多个段落；
3. 同长度祖先链上取语义最明确的内层元素。

排除导航、页脚、推荐列表（特征：短文本链接密度高、无标题层级）。

已知站点容器备忘（仅作起点，命中失败即回本步侦察）：

| 站点 | 容器 |
|---|---|
| ACS（pubs.acs.org） | `.article-body` |
| ScienceDirect | `.Body` |
| Nature | `main` |

## 第 2 步：结构化 walk

遍历正文容器子树，按语义转成带标记的纯文本：

| 元素 | 输出格式 |
|---|---|
| h1–h6 | `#`×(级别+1) + 空格 + 标题文本 |
| p | 平文（trim 后非空才收） |
| figure / figcaption | `[FIGURE] ` + 图注全文 |
| table | `[TABLE]` + 每行 `\| 单元格 \|` 拼接 |
| ul / ol | 每项 `- ` 前缀 |
| 含块级子元素的容器 | 递归 walk |

去重强制：每个输出块 normalize（去除全部空白）后写入 Set，命中即跳过。出版商页面对同一表格或图注常做双渲染（引用编号版与纯文本版各一份），无去重的 walk 产物含重复块。

结果存入 window 变量（如 `window._art`）。首次调用只返回总长 + 标题大纲 + 图表清单，不返回全文。

## 第 3 步：分块落盘

- `substring` 按 3 万字符/段分块，每块单独执行后用文件写入工具落盘；工具直接返回大文本会被截断，落盘是截断防线。
- 合并后核对总字符数与 `window._art` 长度一致。

## 第 4 步：质量自检（入库前必跑）

1. 图表计数：统计合并稿中 `[TABLE]` / `[FIGURE]` 出现次数，与原文图表编号核对；超出原文数量 = 去重失效，回第 2 步。
2. 首尾完整：开头应为标题区或 Abstract，结尾应达 References / 致谢 / 数据可用性段。
3. 锚点体系：版面有页码 → 记 evidence_pages；HTML 版无页码 → 用章节号（§）+ 图表编号作锚点，精读条目中如实申报。

## 第 5 步：落盘与校验

合并稿 → 抽查 → 按 `references\精读条目字段契约.md` 写条目 JSON → `node scripts\validate-reading.mjs` 校验 0 error（或 bun）→ 落盘。

落点：用户指定目录时以用户为准；未指定时落智能体数据目录 `memory\reading-notes\<slug>.json`，文件名与 slug 一致。

read_status 如实申报：HTML 版无页码时 `evidence_pages` 用章节号（§），`evidence_figs` 用图表编号。
