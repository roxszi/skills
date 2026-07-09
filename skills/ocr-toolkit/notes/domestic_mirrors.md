# OCR 工具箱 · 国内源配置(domestic_mirrors)

> 本 skill 是**纯 Python 单栈**,只依赖 `rapidocr-onnxruntime` / `pymupdf` / `pdfplumber` 三个 pip 包。
> 所以这份国内源配置**只覆盖 pip + 模型下载**。

---

## 一、pip 源 (Python)

### 1.1 清华源 (推荐,稳定 + 全)

```bash
# 临时
pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple

# 永久(写到 ~/.pip/pip.conf)
mkdir -p ~/.pip
cat > ~/.pip/pip.conf <<'EOF'
[global]
index-url = https://pypi.tuna.tsinghua.edu.cn/simple
trusted-host = pypi.tuna.tsinghua.edu.cn
EOF
```

### 1.2 阿里源(备选)

```bash
pip install -r requirements.txt -i https://mirrors.aliyun.com/pypi/simple/
```

### 1.3 腾讯源(备选)

```bash
pip install -r requirements.txt -i https://mirrors.cloud.tencent.com/pypi/simple
```

### 1.4 uv 装 venv 时配源

```bash
uv pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple --python .venv-ocr
```

---

## 二、rapidocr 模型下载

rapidocr-onnxruntime 首次调用会下载模型 (PP-OCRv4 mobile, 约 80MB)。

### 2.1 模型来源

- **打包方式**: `rapidocr-onnxruntime` 1.4.4 起,**首次 `RapidOCR()` 调用时自动下载**
- **下载源**: GitHub Releases(`https://github.com/RapidAI/RapidOCR/releases` 下的 `onnx/PP-OCRv4/`)
- **缓存位置**: `C:\Users\<user>\.rapidocr\`

### 2.2 国内可达性

- GitHub 国内直连偶尔慢 (100KB-2MB/s)
- 偶发连接失败: `requests.exceptions.SSLError` 或 `ConnectionResetError`
- **应对**: 重试一次即可; 实在不通, 手动下载 zip 解压到 `~/.rapidocr/`

### 2.3 手动下载模型(网络不通时)

```bash
# 1. 从能访问 GitHub 的机器下载
#    https://github.com/RapidAI/RapidOCR/releases → 找 onnx-ocr-v4-zh-mobile
#    解压得到 .onnx 文件 + dict.txt

# 2. 复制到目标机器
mkdir -p ~/.rapidocr/
cp ch_PP-OCRv4_det_infer.onnx ch_PP-OCRv4_rec_infer.onnx ppocr_keys_v1.txt ~/.rapidocr/

# 3. rapidocr 会自动检测到本地文件,跳过下载
```

### 2.4 自托管模型(企业内网)

```python
# 把 rapidocr 模型目录复制到内网
# 然后强制用本地路径
from rapidocr_onnxruntime import RapidOCR

engine = RapidOCR(
    det_model_path="/internal-share/ocr/ch_PP-OCRv4_det_infer.onnx",
    rec_model_path="/internal-share/ocr/ch_PP-OCRv4_rec_infer.onnx",
    rec_keys_path="/internal-share/ocr/ppocr_keys_v1.txt",
)
```

---

## 三、OCR API 云服务 (可选,本 skill 默认不用)

> **本 skill 默认本地推理**, 云 API 仅在以下场景考虑:
> - 表格结构化 (云 API 表格识别更准)
> - 手写文字 (本地 PP-OCRv4 不支持手写)
> - 批量文档 + 不在意数据脱敏成本

| 服务 | 个人免费 | 国内可达 | 适用 |
|---|---|---|---|
| 腾讯云 OCR | ✅ 1000 次/月 | ✅ | 表格 / 复杂版式 |
| 阿里云 OCR | ✅ 2000 次/月 | ✅ | 身份证 / 发票 |
| 百度 OCR | ✅ 1000 次/月 | ✅ | 手写 + 印刷 |
| Azure OCR | ❌ 收费 | ⚠️ 慢 | 英文最佳 |
| Google Vision | ❌ 收费 | ❌ 难 | 通用 |

⚠️ **敏感数据**: 体检报告 / 病历 = 高敏感数据,云 API **必须脱敏后再上传** (姓名 → 编号、卡号 → hash、医院名 → 编号等)。

---

## 四、开箱即用配置(新 OCR 项目)

```bash
# 1. 复制已有 venv(从 Agent-Main 或 Agent-Health)
cp -r C:/CodeProjects/AI-Agent/Agent-Main/.venv-ocr ./.venv-ocr

# 2. 引导 pip(uv 创建的 venv 不带 pip)
.venv-ocr/Scripts/python.exe -m ensurepip

# 3. 装依赖(清华源)
.venv-ocr/Scripts/python.exe -m pip install -r scripts/requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple

# 4. 跑
.venv-ocr/Scripts/python.exe scripts/python_ocr_pipeline.py <pdf_path> ./output
```

前三步 < 30s,第四步 ~2s。

---

## 五、参考链接

- 清华 PyPI: https://pypi.tuna.tsinghua.edu.cn/simple
- 阿里 PyPI: https://mirrors.aliyun.com/pypi/simple/
- RapidOCR GitHub: https://github.com/RapidAI/RapidOCR
- rapidocr-onnxruntime PyPI: https://pypi.org/project/rapidocr-onnxruntime/