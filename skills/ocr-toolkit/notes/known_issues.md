# OCR 工具箱 · 防踩坑笔记(known_issues)

> 这里收集的是**实测中真踩过的坑 + 修复方案**。
> 每次新项目 OCR 任务前,**先把这份过一遍**,能省 80% 的踩坑时间。
>
> 数据来源:2026-07-08 司云钟视觉筛查报告 OCR 实测,基于 `python_ocr_pipeline.py` 全流程。

---

## 🔴 红线级:关键数据不可信

### 坑 #1 · Read 工具 PDF 渲染 OCR 不稳定

**现象**:用 Read 工具直接读取 PDF 图像,显示"4岁4天"或"4月4天"等不一致结果。

**根因**:Read 工具对 PDF 的处理有自己的 OCR 路径(模型层),对中文/数字混排不稳定。

**实测对比**(同一张体检报告):

| 工具 | 识别"4月4天"结果 |
|---|---|
| Read 工具 PDF | ❌ "4岁4天"(误识) |
| rapidocr-onnxruntime 1.4.4 | ✅ "4月4天"(正确) |

**修复**:
- **关键字段(姓名 / 年龄 / 剂量 / 卡号 / 报告日期)必须用 `rapidocr` 二次验证**
- 或者直接人工对照原图核对
- Read 工具的 PDF 文本提取**只能用作初筛,不能用作最终数据源**

---

### 坑 #2 · 关键数字 OCR 100% 信任 = 灾难

**现象**:OCR 识别"卡号 0012763412"识别成"00127634I2"(1 误识为 I),入库后被医师批评。

**根因**:OCR 引擎在低分辨率 / 扫描模糊 / 字体不佳下,**数字 1 / 0 / l / O / I 容易互相误识**。

**实测**(体检报告 36 块,confidence 0.984-1.000):
- ✅ 卡号 0012763412 识别正确
- ✅ 电话 13611580728 识别正确
- ✅ 日期 2026-07-07 10:17:59 识别正确
- ⚠️ "眼睑" 误识为 "眼脸"(2 次,confidence 0.984/0.986)

**修复**:
- 关键字段入库前**必须跟原图人工核对**(对应 SKILL.md 第六节"诚实性红线")
- confidence < 0.99 的块**全部高亮**,人工二次确认
- 体检报告场景:card_no / phone / date / 剂量 **必须 100% 核**

---

### 坑 #3 · "已知 vs 待核实"不能混用

**现象**:用户已告知"西酞普兰 20 mg qd 晨服",但档案里写成"❓ 剂量待核实 bid"。

**根因**:把用户已明确告知的信息写成"待核实"。

**修复**(健康 Agent SOUL.md 第 2 条):
- 用户告知 = 已知 = 立刻精确写进档案 + 衍生材料
- OCR 推测 = 待核实 = 入库前必须人工确认

---

## 🟡 工具/环境级

### 坑 #4 · uv 创建的 venv 没有 pip

**现象**:`.venv-ocr/Scripts/python.exe -m pip install ...` 报 `No module named pip`。

**根因**:`uv venv` 默认不带 pip。

**修复**:
```bash
# 方案 1:ensurepip 引导
.venv-ocr/Scripts/python.exe -m ensurepip
.venv-ocr/Scripts/python.exe -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple

# 方案 2:用 uv 直接装(更快)
uv pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple --python .venv-ocr
```

---

### 坑 #5 · 跨 Agent 复制 venv 时 Python 版本不一致

**现象**:从 Agent-Main 复制 `.venv-ocr` 到新项目,启动时 `python --version` 显示版本号不一致(3.13.4 vs 3.12.x),导致某些包的 ABI 不兼容。

**根因**:`pyvenv.cfg` 里的 `home` 路径指向原机器 Python 解释器绝对路径;`site-packages` 里装的包是针对原 Python 版本的。

**修复**:
- 复制前**确认源 venv 的 Python 主版本**(`python --version`)
- **主版本必须一致**(3.13.x 和 3.13.x OK,3.13 和 3.12 不行)
- 复制后**立即重装依赖**(用清华源,~10s)

**实测**(2026-07-08 司云钟视觉筛查):
- 源:`Agent-Health/.venv-ocr` Python 3.13.4
- 目标:`ocr-toolkit/.venv-ocr` Python 3.13.4
- ✅ 一致,三个 pip 包全部 import 成功

---

### 坑 #6 · 中文字符和数字交界 `\b` 失效

**现象**:`re.search(r"\b0\d{9,11}\b", "卡号：0012763412电话：")` 返回 None。

**根因**:Python `\b` 是 ASCII 单词边界,在中文字符和数字之间不构成边界。

**修复**:
```python
# ❌ 错
re.search(r"\b0\d{9,11}\b", text)

# ✅ 对
re.search(r"0\d{9,11}", text)

# ✅ 对(更严格,前后不能是数字)
re.search(r"(?<![0-9])0\d{9,11}(?![0-9])", text)
```

---

### 坑 #7 · 年龄正则贪婪匹配导致"4月4天"被截成"4月"

**实测现象**(体检报告 OCR):
```
原文 OCR 输出:性别：男年龄：4月4天卡号：0012763412电话：
期望抽取:age = "4月4天"
实际抽取:age = "4月"(漏了"4天")
```

**根因**:正则 `(\d+\s*(?:岁|个月|月|天|周))` 用了 `re.search` + 贪婪,但没加可选的"X 天"扩展,匹配到第一个"月"就停了。

**修复**(已写入 `key_fields_extraction.md`):
```python
# ❌ 错(只能抓"4月")
re.search(r"年\s*龄[:：]?\s*(\d+\s*(?:岁|个月|月|天|周))", text)

# ✅ 对(抓完整的"4月4天"或"4岁5个月")
re.search(r"年\s*龄[:：]?\s*(\d+\s*岁(?:\s*\d+\s*个月)?|\d+\s*个?月(?:\s*\d+\s*天)?|\d+\s*天)", text)
```

---

### 坑 #8 · OCR 输出无版式信息,所有字段粘成一行

**实测现象**(体检报告 1 页 36 块):
```
OCR 输出:
江苏省人民医院
体检报告（请妥善保管）
姓名：
司云钟
性别：男年龄：4月4天卡号：0012763412电话：   ← 4 个字段粘在一行!
13611580728
```

**根因**:rapidocr 按文本块(检测框)输出,**不考虑原始版式的换行/空格**。原 PDF 是表格 / 多列表格,OCR 退化成单行文字流。

**影响**:
- 对**正则抽取**几乎无影响(姓名/卡号/电话都能抓对)
- 对**人工对照原图**不友好(看不到原版式结构)

**修复**:
- 关键字段抽取**必须用正则,不能依赖 split("\n")**
- 人工核对时**直接看 OCR 的 json 文件**(含框坐标),不看 txt
- 如果需要保留原版式,**云 API 表格识别更靠谱**(腾讯云/阿里云)

---

### 坑 #9 · 印刷体 OCR 不支持手写

**现象**:医师手写的"补充诊断"或签名(草书),rapidocr 完全识别不出。

**根因**:rapidocr-onnxruntime 默认模型是 PP-OCRv4 mobile,**针对印刷体训练**,手写识别率 < 30%。

**修复**:
- 本 skill 只处理**印刷体报告**(体检报告 / 病历打印件 / 化验单)
- 手写内容需要专门的手写 OCR 模型(百度 OCR / 腾讯云手写体)
- 签名识别**不能依赖 OCR**,必须人工核对

---

### 坑 #10 · PDF "有文本层但抽取到空字符串"

**现象**:`pdfplumber.extract_text()` 返回 `""`,但 `fitz.open().get_text()` 返回乱码字符。

**根因**:
- 真扫描件(无文本层)——这是预期行为,走 OCR 路线
- 嵌入字体子集但字符映射损坏(罕见)
- 文本编码异常(GBK vs UTF-8 混排)

**修复**:
```python
# 双保险:同时用 pdfplumber 和 pymupdf 测
import pdfplumber
import fitz

def has_text_layer(pdf_path):
    with pdfplumber.open(pdf_path) as pdf:
        pl_text = "".join(p.extract_text() or "" for p in pdf.pages)
    doc = fitz.open(pdf_path)
    fitz_text = "".join(p.get_text("text") for p in doc)
    doc.close()
    return max(len(pl_text), len(fitz_text)) > 10
```

如果两个都返回 0 → 真扫描件,走 OCR。

**实测**(`体检报告_视觉筛查.pdf`):pdfplumber=0 字符,fitz=0 字符 → 确认纯扫描件,走 OCR 路线 ✅

---

### 坑 #11 · rapidocr 冷启动 1.5s+

**实测**:
- 首次 `RapidOCR()` + 单次推理 = **2.09s**(端到端,含模型加载)
- 进程级单例后,后续单次推理 = **0.3s**

**根因**:模型加载(PP-OCRv4 mobile ~80MB)。

**修复**:
- **命令行脚本**:接受冷启动(2s 内,可忽略)
- **Web 服务 / API**:**进程级单例**,应用启动时初始化一次
- 用 `engine = RapidOCR()` 后多次复用,不要每次请求新建

---

### 坑 #12 · rapidocr 首次启动时打印大量日志(可静音)

**现象**:首次 `RapidOCR()` 时,控制台刷 30+ 行 log(包括 ONNX Runtime 初始化信息、模型下载进度),看着有点乱。

**修复**:
```python
import logging
logging.getLogger("rapidocr").setLevel(logging.WARNING)
logging.getLogger("onnxruntime").setLevel(logging.WARNING)
```

或者用环境变量:
```bash
# 静音 ONNX Runtime
export ORT_LOGGING_LEVEL=3   # ERROR only
```

---

### 坑 #13 · 表格识别 CER 看起来很高

**现象**:体检报告 OCR 整体 CER 23%,但关键字段 100% 准确。

**根因**:CER(字符错误率)对**空格 / 标点 / 换行**敏感,但**关键字段(数字/姓名/诊断)准确率**才是体检报告真正关心的。

**修复**:
- **体检报告 / 病历场景:看关键字段准确率,不看 CER**
- CER 只在"原文逐字提取"场景(古籍 / 文献 OCR)有意义
- 报告里同时给两个指标:总 CER + 关键字段准确率

---

## 🟢 已验证可用的最佳实践

### ✅ 跨 Agent 复用 venv

```bash
# 从 Agent-Health 复制 .venv-ocr 到新项目(同 Python 3.13.4)
cp -r /c/CodeProjects/AI-Agent/Agent-Health/.venv-ocr /c/CodeProjects/AI-Agent/<new>/.venv-ocr

# 验证
.venv-ocr/Scripts/python.exe --version  # 确认主版本
.venv-ocr/Scripts/python.exe -c "import rapidocr_onnxruntime, fitz, pdfplumber; print('ok')"
```

前提:Python 主版本一致 + pyvenv.cfg 的 home 路径可访问。

**实测**:从 Agent-Health 复制到 ocr-toolkit,3 个包全部 import 成功 ✅

---

### ✅ 先判文本层,再决定路线

```python
def process_pdf(pdf_path):
    if has_text_layer(pdf_path):
        return extract_text_layer(pdf_path)   # < 0.1s
    else:
        return render_and_ocr(pdf_path)       # ~2s(含冷启动)
```

不要无脑走 OCR 路线。

---

### ✅ 关键字段正则必须人工对照原图

入库前:
1. OCR 文本提取(json 文件,含 confidence)
2. 正则抽取关键字段
3. **过滤 confidence < 0.99 的块,人工二次确认**
4. 确认无误后入库

---

### ✅ 单脚本三件套输出(txt + json + md)

`python_ocr_pipeline.py` 默认输出三件套:

| 文件 | 用途 |
|---|---|
| `<basename>.txt` | 纯文本,正则提取用 |
| `<basename>.json` | 结构化(块 + 框 + confidence),核对用 |
| `<basename>.md` | 报告摘要,直接给医师看 |

---

## 📋 踩坑记录表(任务执行时更新)

| 日期 | 项目 | 踩到的坑 | 解决方案 | 已写入 SKILL |
|---|---|---|---|---|
| 2026-07-08 | 司云钟视觉筛查 | Read 工具 PDF OCR "4岁4天" 误识 | 用 rapidocr 重 OCR → "4月4天" 正确 | ✅ |
| 2026-07-08 | 司云钟视觉筛查 | `\b0\d{9,11}\b` 不匹配中文 | 去掉 `\b`,用前后断言 | ✅ |
| 2026-07-08 | 司云钟视觉筛查 | uv venv 没 pip | ensurepip 引导 | ✅ |
| 2026-07-08 | 司云钟视觉筛查 | **age 正则截断"4月4天"→"4月"** | 扩展正则支持"(月)(天)" | ✅ |
| 2026-07-08 | ocr-toolkit skill 端到端验证 | rapidocr 启动刷 30+ 行日志 | logging.getLogger().setLevel(WARNING) | ✅ |
| 2026-07-08 | ocr-toolkit skill 端到端验证 | 跨 Agent venv 复制成功 | 主版本一致(3.13.4)+ 重装依赖 | ✅ |

> 每次新踩坑,**先在这里登记,再更新 SKILL.md 主表**。

---

## 📜 已废弃/无关章节(历史归档,不再尝试)

> 以下内容是 **JS/TS OCR 工具栈** 的踩坑记录,本 skill 是纯 Python 单栈,**已不再适用**。
> 保留在这里只是作为**历史备忘**:为什么我们不维护 JS/TS 端。

### ~~坑 A · ppu-paddle-ocr 在 Node.js / Bun 24 跑不通~~

```text
TypeError: image.getContext is not a function.
  at opencv.js:30:1699 (in @techstark/opencv-js)
```

原因:`@techstark/opencv-js@4.10.0` 的 ESM/Node bug:
1. `}(this, function () {` → ESM 下 `this` 是 undefined
2. `document.createElement` → Node 下 undefined

**结论**:**JS/TS 主流 OCR 库(Node 端)在 2026-07 不可用**,本 skill 选择纯 Python 单栈,不踩这个坑。

### ~~坑 B · onnxruntime-node 装包慢(海外 GitHub Releases)~~

`pnpm add onnxruntime-node` 5+ 分钟;配 npmmirror 镜像 < 30s。

**结论**:**与本 skill 无关**(本 skill 用 `rapidocr-onnxruntime` Python 版)。

### ~~坑 C · Bun + onnxruntime-node postinstall 被 block~~

`bun pm trust onnxruntime-node` 显式信任。

**结论**:**与本 skill 无关**。

### ~~坑 D · ppu-paddle-ocr 模型首次下载 5+ 分钟(Cloudflare Workers)~~

**结论**:**与本 skill 无关**(rapidocr 模型从 GitHub Releases 拉,首次 ~80MB,缓存后瞬时)。