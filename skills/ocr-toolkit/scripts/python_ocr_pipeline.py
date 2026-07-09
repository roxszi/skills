"""
通用 PDF/图片 OCR 流水线(Python 端,生产推荐)
==========================================

引擎组合:
  - pymupdf  (PDF 渲染 + 文本层提取)
  - pdfplumber  (PDF 文本层 + 表格提取,优先用)
  - rapidocr-onnxruntime  (PP-OCRv4 mobile,无文本层时走 OCR)

输入:
  python python_ocr_pipeline.py <pdf_or_image_path> [output_dir]

输出:
  <output_dir>/
    ├── <basename>.txt         纯文本(合并所有页)
    ├── <basename>.json        结构化(每页 + 每文本块:文本/框坐标/置信度)
    ├── <basename>.md          Markdown 摘要(页数 + 引擎 + 耗时 + 文本预览)
    └── page_<n>_<dpi>dpi.png  渲染图(仅扫描件时生成)

特性:
  - 智能判定:有文本层 → 直接抽取;无文本层 → 渲染 + OCR
  - 中英文混排识别
  - 端到端 ~2s(扫描件,含冷启动)
  - 离线运行(模型首次下载 ~80MB,后续 cache 命中)

依赖:
  pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple

作者:司承运 / 2026-07-08
许可:MulanPSL v2
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path
from typing import Any

import fitz  # pymupdf
import pdfplumber
from rapidocr_onnxruntime import RapidOCR


# ============== 常量 ==============
TEXT_LAYER_MIN_CHARS = 10       # 文本层字符数阈值(< 视为"无文本层")
RENDER_DPI = 200                # PDF → PNG 渲染 DPI
OCR_DET_THRESHOLD = 0.3         # 检测阈值(rapidocr 默认)
OCR_REC_THRESHOLD = 0.5         # 识别阈值


# ============== 核心函数 ==============

def has_text_layer(pdf_path: Path) -> tuple[bool, str]:
    """
    判定 PDF 是否包含文本层
    返回: (是否有文本层, 抽取到的文本)
    """
    try:
        with pdfplumber.open(pdf_path) as pdf:
            full_text = ""
            for page in pdf.pages:
                full_text += page.extract_text() or ""
                if len(full_text) >= TEXT_LAYER_MIN_CHARS:
                    return True, full_text
        return len(full_text) >= TEXT_LAYER_MIN_CHARS, full_text
    except Exception as e:
        print(f"  ⚠️  pdfplumber 抽取失败: {e}")
        return False, ""


def extract_text_layer(pdf_path: Path) -> list[dict[str, Any]]:
    """
    直接抽取 PDF 文本层(非 OCR)
    返回: [{"page": 1, "text": "...", "chars": 1234}, ...]
    """
    pages_data = []
    with pdfplumber.open(pdf_path) as pdf:
        for i, page in enumerate(pdf.pages, start=1):
            text = page.extract_text() or ""
            pages_data.append({
                "page": i,
                "method": "pdfplumber_text_layer",
                "text": text,
                "chars": len(text),
            })
    return pages_data


def render_pdf_to_images(pdf_path: Path, out_dir: Path, dpi: int = RENDER_DPI) -> list[Path]:
    """
    用 pymupdf 把 PDF 每页渲染成 PNG
    返回: PNG 路径列表
    """
    image_paths = []
    doc = fitz.open(pdf_path)
    out_dir.mkdir(parents=True, exist_ok=True)
    for i, page in enumerate(doc, start=1):
        pix = page.get_pixmap(dpi=dpi)
        png_path = out_dir / f"page_{i:02d}_{dpi}dpi.png"
        pix.save(str(png_path))
        image_paths.append(png_path)
    doc.close()
    return image_paths


def run_rapidocr(image_paths: list[Path]) -> list[dict[str, Any]]:
    """
    对图片列表跑 rapidocr 推理
    返回: [{"page": 1, "blocks": [{text, box, score}], ...}, ...]
    """
    engine = RapidOCR()
    pages_data = []
    for i, img_path in enumerate(image_paths, start=1):
        result, _elapse = engine(str(img_path))
        # result 格式: [[box, text, score], ...] 或 None
        blocks = []
        if result:
            for box, text, score in result:
                blocks.append({
                    "text": text,
                    "box": [[float(x), float(y)] for x, y in box],
                    "score": float(score),
                })
        pages_data.append({
            "page": i,
            "method": "rapidocr_onnxruntime",
            "blocks": blocks,
            "char_count": sum(len(b["text"]) for b in blocks),
        })
    return pages_data


def to_txt(pages_data: list[dict[str, Any]], text_layer_text: str = "") -> str:
    """合并所有页文本"""
    if text_layer_text:
        return text_layer_text
    return "\n\n".join(
        f"--- Page {p['page']} ---\n" + "\n".join(b["text"] for b in p.get("blocks", []))
        for p in pages_data
    )


def to_json(src_path: Path, pages_data: list[dict[str, Any]], method: str) -> dict[str, Any]:
    """结构化 JSON"""
    return {
        "source_file": str(src_path),
        "engine": method,
        "page_count": len(pages_data),
        "total_chars": sum(p.get("chars", p.get("char_count", 0)) for p in pages_data),
        "pages": pages_data,
    }


def to_markdown(src_path: Path, pages_data: list[dict[str, Any]], method: str,
                elapsed: float, has_text_layer_flag: bool) -> str:
    """Markdown 摘要报告"""
    total_chars = sum(p.get("chars", p.get("char_count", 0)) for p in pages_data)
    lines = [
        f"# OCR 报告 · {src_path.name}",
        "",
        f"- **源文件**:`{src_path}`",
        f"- **页数**:{len(pages_data)}",
        f"- **引擎**:{method}",
        f"- **文本层**:{'✅ 有' if has_text_layer_flag else '❌ 无(纯扫描件)'}",
        f"- **总字符数**:{total_chars}",
        f"- **耗时**:{elapsed:.2f}s",
        "",
        "## 文本预览(前 500 字)",
        "",
        "```text",
        (to_txt(pages_data)[:500] if not has_text_layer_flag else pages_data[0]["text"][:500]),
        "```",
        "",
    ]
    if not has_text_layer_flag:
        lines.extend([
            "## 详细块信息",
            "",
        ])
        for p in pages_data:
            lines.append(f"### Page {p['page']} ({len(p.get('blocks', []))} 块)")
            lines.append("")
            for b in p.get("blocks", []):
                lines.append(f"- `{b['score']:.3f}` {b['text']}")
            lines.append("")
    return "\n".join(lines)


# ============== 主流程 ==============

def process(src: Path, out_dir: Path) -> dict[str, Any]:
    """主入口"""
    out_dir.mkdir(parents=True, exist_ok=True)
    basename = src.stem
    print(f"\n{'='*60}")
    print(f"📄 输入:{src}")
    print(f"📁 输出:{out_dir}")
    print(f"{'='*60}")

    t0 = time.perf_counter()

    # 路径 1:PDF
    if src.suffix.lower() == ".pdf":
        has_text, layer_text = has_text_layer(src)
        print(f"  文本层判定:{'✅ 有' if has_text else '❌ 无'} (字符数: {len(layer_text)})")

        if has_text:
            print("  → 走「文本层抽取」路线")
            pages_data = extract_text_layer(src)
            method = "pdfplumber_text_layer"
        else:
            print("  → 走「扫描件 OCR」路线")
            pngs = render_pdf_to_images(src, out_dir / f"{basename}_pages")
            print(f"  → 已渲染 {len(pngs)} 页 @ {RENDER_DPI} DPI")
            print(f"  → 调用 rapidocr...")
            pages_data = run_rapidocr(pngs)
            method = "rapidocr_onnxruntime"

    # 路径 2:图片
    elif src.suffix.lower() in {".png", ".jpg", ".jpeg", ".bmp", ".webp", ".tif", ".tiff"}:
        print("  → 走「图片 OCR」路线")
        pages_data = run_rapidocr([src])
        method = "rapidocr_onnxruntime"
        has_text = False

    else:
        raise ValueError(f"不支持的文件类型:{src.suffix}")

    elapsed = time.perf_counter() - t0

    # 输出三件套
    txt_path = out_dir / f"{basename}.txt"
    json_path = out_dir / f"{basename}.json"
    md_path = out_dir / f"{basename}.md"

    txt_content = to_txt(pages_data, layer_text if has_text else "")
    txt_path.write_text(txt_content, encoding="utf-8")

    json_path.write_text(
        json.dumps(to_json(src, pages_data, method), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    md_path.write_text(
        to_markdown(src, pages_data, method, elapsed, has_text),
        encoding="utf-8",
    )

    print(f"\n{'─'*60}")
    print(f"✅ 完成 耗时 {elapsed:.2f}s")
    print(f"   - {txt_path.name}  ({len(txt_content)} chars)")
    print(f"   - {json_path.name}")
    print(f"   - {md_path.name}")
    print(f"{'─'*60}\n")

    return {
        "elapsed": elapsed,
        "method": method,
        "page_count": len(pages_data),
        "total_chars": sum(p.get("chars", p.get("char_count", 0)) for p in pages_data),
    }


def main() -> None:
    if len(sys.argv) < 2:
        print("用法:python python_ocr_pipeline.py <pdf_or_image_path> [output_dir]")
        print()
        print("示例:")
        print('  python python_ocr_pipeline.py "C:\\path\\to\\report.pdf" ./output')
        sys.exit(1)

    src = Path(sys.argv[1]).resolve()
    if not src.exists():
        print(f"❌ 文件不存在:{src}")
        sys.exit(1)

    out_dir = Path(sys.argv[2]).resolve() if len(sys.argv) >= 3 else src.parent / "ocr_output"

    result = process(src, out_dir)
    print(f"📊 结果摘要:{json.dumps(result, ensure_ascii=False, indent=2)}")


if __name__ == "__main__":
    main()