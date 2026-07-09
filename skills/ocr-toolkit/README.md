# OCR 工具箱 (ocr-toolkit)

中文 OCR + PDF 扫描件，科研文献 / 书籍 / 体检报告 / 病历 / 发票等场景的**通用工具选型 + 流水线模板 + 踩坑笔记**。

> 详见 [`SKILL.md`](SKILL.md) —— 主文件,触发器 + 选型矩阵 + 规范 + 诚实性红线

## 目录索引

| 路径 | 用途 |
|---|---|
| [`SKILL.md`](SKILL.md) | 主文件(触发器 + 工具选型 + 决策树 + 规范) |
| `scripts/python_ocr_pipeline.py` | Python 端完整流水线(rapidocr + pymupdf + pdfplumber) |
| `scripts/pdf_render.py` | PDF → PNG 200 DPI 渲染(独立可复用) |
| `scripts/requirements.txt` | Python 依赖清单(三个 pip 包) |
| `notes/known_issues.md` | 踩坑笔记(已知问题 + 修复方案) |
| `notes/domestic_mirrors.md` | 国内源配置(pip / 模型下载) |
| `notes/key_fields_extraction.md` | 关键字段正则模式 |

## 快速上手(默认 Python 端)

```bash
# 1. 准备 venv (从已有 .venv-ocr 复制最快)
cp -r C:/CodeProjects/AI-Agent/Agent-Main/.venv-ocr ./.venv-ocr

# 2. 引导 pip (uv venv 不带 pip)
.venv-ocr/Scripts/python.exe -m ensurepip

# 3. 装依赖 (清华源)
.venv-ocr/Scripts/python.exe -m pip install -r scripts/requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple

# 4. 跑 (把 PDF 路径改了)
.venv-ocr/Scripts/python.exe scripts/python_ocr_pipeline.py <pdf_path> [output_dir]
```

## 何时**不**用本 skill

- 纯文本 PDF 提取 (用 pdfplumber / pymupdf 直接, 不需要 OCR)
- 实时视频流 OCR (本 skill 是离线 PDF / 图片)

## 注意事项

- 以下场景使用本 skill，务必加强审核：
  - 手写文字识别 (本 skill 对印刷体识别效果较好，对手写文字识别效果较差)
  - 表格结构化输出 (可能出现格式错位，若识别效果不理想，可考虑云 API 表格识别)
  - 公式识别 (若识别效果不理想，可考虑云 API 表格识别)
