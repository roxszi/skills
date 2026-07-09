---
name: OCR 工具箱
slug: ocr-toolkit
description: OCR 工具选型与流水线构建。中文 OCR + PDF 扫描件 + 科研文献 / 书籍 / 体检报告 / 病历 / 发票等场景。基于 Python rapidocr-onnxruntime + pymupdf + pdfplumber 完整流水线。当涉及到"扫描件转文字"、"PDF 文字识别"、"识别图片中的字"等业务时触发。
compatibility: python
metadata:
  author: RoxSzi (SI_Cheng-Yun, 司承运)
  version: 1.0.2
license: MulanPSL v2
---

# OCR 工具箱 skill (ocr-toolkit)

### 何时用

用户需要对以下内容做 OCR (光学字符识别):

- **PDF 报告** (科研文献 / 书籍 / 体检报告 / 检验单 / 病历 / 发票 / 处方)
- **扫描件** (无文本层, 需 OCR 引擎)
- **批量图片 OCR** (文档照片 / 截图)

典型触发语句:

- "帮我 OCR 一下这份体检报告"
- "把扫描件转成文字"
- "PDF 文字识别 / 提取"
- "批量识别图片中的文字"
- "识别这张化验单"

> ⚠️ **本 skill 不适用于**: 英文 PDF 纯文本提取 (用 pdfplumber 更简单); 手写文字 (本 skill 是印刷体 OCR); 手写签名识别; 表格结构化(可用云 API 表格识别)。

### 目录规范

```
ocr-toolkit\
├── SKILL.md                     # 本文件(主文件, 触发器 + 选型 + 规范)
├── README.md                    # 目录索引
├── scripts/
│   ├── python_ocr_pipeline.py   # 通用 Python 流水线 (rapidocr + pymupdf + pdfplumber)
│   └── pdf_render.py            # PDF → PNG 渲染 (200 DPI, 独立可复用)
└── notes/
    ├── known_issues.md          # 踩坑笔记(已知问题 + 修复)
    ├── domestic_mirrors.md      # 国内源配置(pip / 模型下载)
    └── key_fields_extraction.md # 关键字段正则模式
```

---

## 一、工具选型矩阵(决策表)

### 1.1 按语言 / 平台

| 工具 | 语言 | 中文 | 速度 | 部署复杂度 | 状态 | 适用场景 |
|---|---|---|---|---|---|---|
| **rapidocr-onnxruntime** | Python | ⭐⭐⭐⭐⭐ | 快(0.3s/张) | ⭐⭐(venv) | ✅ **生产推荐** | 体检报告 / 病历 OCR |
| **pymupdf** (文本提取) | Python | ⭐⭐⭐⭐⭐ | 极快(<0.1s) | ⭐ | ✅ **必装** | PDF 文本层提取(非 OCR) |
| **pdfplumber** (文本提取) | Python | ⭐⭐⭐⭐ | 快 | ⭐ | ✅ **必装** | PDF 文本层 + 表格 |
| **Tesseract 5 / Tesseract.js** | 跨语言 | ⭐⭐⭐ 一般 | 慢(2-5s/张) | ⭐⭐ | ⚠️ 中文一般 | 英文 / 简单中文 |
| **ppu-paddle-ocr** (PP-OCRv6) | JS/TS | ⭐⭐⭐⭐⭐ | 未知 | ❌ **不可用** | ❌ **opencv-js 阻塞** | 暂不推荐 Node |
| **@gutenye/ocr-node / eSearch-OCR** | JS/TS | ⭐⭐⭐⭐ | 未知 | ⭐⭐ | 🟡 候选 | 纯 ONNX,可试 |
| **云 API**(腾讯/阿里/百度) | HTTP | ⭐⭐⭐⭐⭐ | 极快(<1s) | ⭐⭐(配 key) | ✅ 个人免费额度 | 表格 / 复杂版式 |

### 1.2 按 PDF 类型(决策树)

```
PDF 文件
    │
    ├─ 1. 先判定:有文本层吗?
    │     pymupdf: page.get_text("text") → 字符数 > 0 ?
    │     pdfplumber: page.extract_text() → 字符串非空 ?
    │
    ├─ 是 → 走"文本提取"路线
    │     pdfplumber.extract_text() 直接拿
    │     不需要 OCR 引擎
    │     CER ≈ 0%(原文本层)
    │     耗时 < 0.1s
    │
    └─ 否 → 走"扫描件 OCR"路线
          pymupdf 渲染 200 DPI
          rapidocr-onnxruntime 推理
          端到端 ~2s(含冷启动)
```

### 1.3 选型推荐(2026-07 当前)

**默认推荐**:**Python 端完整流水线**(整个 skill 只此一条栈)

- `pymupdf` 渲染 + `rapidocr-onnxruntime` 推理
- 体检报告端到端 **~2s**(含冷启动)
- 模型:PP-OCRv4 mobile
- 关键字段识别 100%

**为什么不做 JS/TS 端**:`@techstark/opencv-js` 在 Node + ESM 下有两个 blocker,导致主流 JS/TS OCR 库(`ppu-paddle-ocr` 等)在 Node 环境不可用。**单一技术栈**避免在 skill 内同时维护两条工具链,详见 §三 和 `notes/known_issues.md` 坑 #5。

---

## 二、Python 端通用流水线(标准模板)

### 2.1 依赖清单

```txt
# requirements.txt
rapidocr-onnxruntime==1.4.4
pymupdf>=1.24
pdfplumber>=0.11
```

### 2.2 国内源配置

```bash
# 清华 pip 源
python -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple

# uv 创建的 venv 不带 pip,用 ensurepip 引导:
.venv-ocr\Scripts\python.exe -m ensurepip
.venv-ocr\Scripts\python.exe -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
```

> 详见 `notes/domestic_mirrors.md`

### 2.3 标准流水线代码

见 `scripts/python_ocr_pipeline.py`(可直接复用):

- **输入**:PDF 路径 / 图片目录
- **输出**:TXT(纯文本) + JSON(结构化,含框坐标 + 置信度) + Markdown(对比报告)
- **关键字段提取**:正则模式(见 `notes/key_fields_extraction.md`)

---

## 三、防踩坑笔记(常见问题清单)

| # | 现象 | 原因 | 修复 |
|---|---|---|---|
| 1 | "4岁4天" / "4月4天" 不一致 | Read 工具 PDF 渲染 OCR 不稳定 | **关键字段必须用 pdfplumber / pymupdf 二次验证** |
| 2 | "card_no: None"(明明 OCR 文本里有数字) | `\b` 边界在中文/数字交界不工作 | **直接用 `0\d{9,11}`,不用 `\b`** |
| 3 | `pip install` 报 "No module named pip" | uv 创建的 venv 不带 pip | `python -m ensurepip` 或用 `uv pip install` |
| 4 | `ppu-paddle-ocr` 在 Node 报 "image.getContext is not a function" | `@techstark/opencv-js` ESM bug | 暂用 Python 端;或换 `@gutenye/ocr-node` |
| 5 | onnxruntime-node 装包慢(海外 GitHub Releases) | 无国内镜像 | `pnpm config set @onnxruntime/onnxruntime-node_binary_host_mirror https://registry.npmmirror.com/-/binary/onnxruntime` |
| 6 | 体检报告"无文本层"(`pymupdf.get_text() == 0`) | 真扫描件,或 PDF 生成时未嵌入文本 | 走 OCR 路线,不要死磕文本提取 |
| 7 | OCR 数字 1 识别为 l、0 识别为 O | 字体 / 清晰度 | 强制 confidence 阈值 + 关键字段跟原图对比 |
| 8 | uv 装 venv 后没 pip | uv 默认不带 pip | `python -m ensurepip` 引导;或 `uv pip install ...` |
| 9 | ppu-paddle-ocr 模型首次下载 5+ 分钟 | 从 Cloudflare Workers 拉,无国内镜像 | 接受首次慢,后续 cache 命中 |
| 10 | Bun + onnxruntime-node 装完 postinstall 被 block | Bun 安全机制 | `bun pm trust onnxruntime-node` 显式信任 |

更多详见 `notes/known_issues.md`。

---

## 四、关键字段提取(正则模式)

体检报告典型字段的正则(已验证可用):

```python
# 卡号(10-12 位,以 0 开头)
re.search(r"0\d{9,11}", text)        # ⚠️ 不用 \b

# 联系电话
re.search(r"1[3-9]\d{9}", text)       # ⚠️ 不用 \b

# 报告日期
re.search(r"\d{4}[-/.]\d{1,2}[-/.]\d{1,2}", text)

# 年龄(月 / 岁 / 天)
re.search(r"(\d+)\s*(岁|个月|月|天)", text)
```

更多见 `notes/key_fields_extraction.md`。

---

## 五、诚实性红线(不可破)

按医疗级规则:

1. **关键数字 / 剂量 / 卡号必须双重确认** (OCR 文本 + 原图人工对比)
2. **OCR 结果不能直接入库** —— 必须人眼对照原图核实关键字段
3. **CER 数字仅供参考** —— 结构化场景 (体检报告) 看**关键字段准确率**, 不看 CER
4. **扫描件 / 真 OCR 跟原图差异** = **必须主动告知用户** (不要默默用)
5. **OCR 工具 / 引擎选择必须明确** —— 不要混用不同引擎结果而不告知
6. **"已知 vs 待核实泾渭分明"** —— OCR 识别出的数据, 如果人工没核实, 必须标"待核实"再入库

---

## 六、交付前自检清单

- [ ] **§一·决策树**: PDF 真实性质已判定 (有文本层 / 无文本层)?
- [ ] **§二·依赖**: Python venv 已就绪 (pip 包三个就够)?
- [ ] **§二·国内源**: pip 已配清华源?
- [ ] **§四·踩坑笔记**: 本次任务踩到的坑已记录?
- [ ] **§五·关键字段**: 正则已用对 (没误用 `\b`)?
- [ ] **§六·诚实性**: 关键数字已跟原图二次核对?
- [ ] **输出**: TXT / JSON / Markdown 三件套齐全?

---

## 附录 A: 版本历史

- **v1.0.2** (2026-07-09): 内容精简
- **v1.0.1** (2026-07-08): 移除 Node 端参考脚本, 纯 Python 单栈
- **v1.0.0** (2026-07-08): 初版, 基于体检报告 OCR 实测
