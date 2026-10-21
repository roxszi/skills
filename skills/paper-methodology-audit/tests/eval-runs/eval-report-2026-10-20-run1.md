# 技能触发评测报告 · paper-methodology-audit

- 日期：2026-10-20
- 评测集：`tests/eval-queries.json`（24 条，正例 12／负例 12）
- 阈值：召回率 ≥ 90%，精确率 ≥ 80%

## 汇总

TP=12  FP=0  FN=0  TN=12

- 精确率 precision = 100.0%
- 召回率 recall = 100.0%
- F1 = 100.0%，准确率 = 100.0%
- 判定：PASS

## 逐条

| id | 标签 | 用户请求 | 期望 | 实测 | 选中技能 | 对 |
|---|---|---|---|---|---|---|
| P01 | positive | C:\Users\me\Downloads\paper.pdf 看一下这篇 | 加载 | 加载 | paper-methodology-audit | ✓ |
| P02 | positive | 帮我精读一下这篇文献 | 加载 | 加载 | paper-methodology-audit | ✓ |
| P03 | positive | 讲一讲这篇文献 | 加载 | 加载 | paper-methodology-audit | ✓ |
| P04 | positive | 这篇靠谱吗？它的结论站得住吗 | 加载 | 加载 | paper-methodology-audit | ✓ |
| P05 | positive | 这篇论文的方法能不能支撑我设计电化学阻抗实验 | 加载 | 加载 | paper-methodology-audit | ✓ |
| P06 | positive | 帮我对比这三篇文献的异同，哪篇更可信 | 加载 | 加载 | paper-methodology-audit | ✓ |
| P07 | positive | 先快速看一眼这篇，给我个大概印象 | 加载 | 加载 | paper-methodology-audit | ✓ |
| P08 | positive | 这篇只有 DOI，没有本地文件，你帮我读一下：10.1021/acs.analchem.5b00000 | 加载 | 加载 | paper-methodology-audit | ✓ |
| P09 | positive | 帮我评估一下这篇论文的方法学部分 | 加载 | 加载 | paper-methodology-audit | ✓ |
| P10 | positive | D:\文献\博士论文.docx 帮我看看 | 加载 | 加载 | paper-methodology-audit | ✓ |
| P11 | positive | 我要在综述里引用这篇，它的方法学有没有硬伤 | 加载 | 加载 | paper-methodology-audit | ✓ |
| P12 | positive | 这篇里声称的反应机理链自洽吗 | 加载 | 加载 | paper-methodology-audit | ✓ |
| N01 | negative | 羰基伸缩振动峰位一般落在多少？ | 不加载 | 不加载 | none | ✓ |
| N02 | negative | 帮我设计一个电化学阻抗实验方案 | 不加载 | 不加载 | none | ✓ |
| N03 | negative | 这份光谱数据帮我做 PCA 和 PLS 建模 | 不加载 | 不加载 | none | ✓ |
| N04 | negative | 帮我把这段中文润色成英文 | 不加载 | 不加载 | none | ✓ |
| N05 | negative | 写一个关于 SERS 增强机制的技术简报 | 不加载 | 不加载 | tech-brief-writer | ✓ |
| N06 | negative | 把这个 PDF 转成 Word 文档 | 不加载 | 不加载 | office-transform | ✓ |
| N07 | negative | 帮我搜一下近三年电化学领域的高被引文献 | 不加载 | 不加载 | none | ✓ |
| N08 | negative | 解释一下什么是析氢过电位 | 不加载 | 不加载 | none | ✓ |
| N09 | negative | 帮我审一下这个开题报告的逻辑结构 | 不加载 | 不加载 | none | ✓ |
| N10 | negative | 我的仪器报了这个故障码 E-214是什么意思 | 不加载 | 不加载 | none | ✓ |
| N11 | negative | 帮我把这份 Excel 数据画成折线图 | 不加载 | 不加载 | none | ✓ |
| N12 | negative | 综述一下表面增强拉曼在病原体检测方面的研究现状 | 不加载 | 不加载 | tech-brief-writer | ✓ |
