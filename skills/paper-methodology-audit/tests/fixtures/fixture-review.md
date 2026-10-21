# 测试综述样本

本文件用于 check-review-cites.mjs 的回归测试，故意包含合法引用、非法引用、
markdown 链接与代码块等干扰项。

## 结果

电化学沉积 10 圈时基底 RSD 为 6.8% [example-sers-ag-2025]。
一篇不存在的文献结论 [nonexistent-slug] 应被判为非法引用。

## 参考

- 原文 DOI 链接 [DOI](https://doi.org/10.1021/acs.analchem.5b00000) 不应算引用。
- 代码块内的内容不应算引用：

```text
[example-sers-ag-2025] in a code fence
```

- 行内代码 `[example-sers-ag-2025]` 也不应算引用。
