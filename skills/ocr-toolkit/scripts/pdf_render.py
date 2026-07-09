"""
PDF → PNG 200 DPI 渲染(独立脚本)
================================

为什么单独拆出来?
  - 跨语言复用:Node 端 / 其他 Python 脚本都可能需要把 PDF 渲染成图
  - 单职责:不做 OCR,只渲染
  - 可批量

依赖:pymupdf>=1.24
  pip install pymupdf -i https://pypi.tuna.tsinghua.edu.cn/simple

用法:
  python pdf_render.py <pdf_path> [output_dir] [--dpi 200]

示例:
  python pdf_render.py report.pdf
  python pdf_render.py report.pdf ./imgs --dpi 300

作者:司承运 / 2026-07-08
许可:MulanPSL v2
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import fitz  # pymupdf


def render_pdf(pdf_path: Path, out_dir: Path, dpi: int = 200) -> list[Path]:
    """
    把 PDF 每页渲染成 PNG
    返回: PNG 路径列表(按页码顺序)
    """
    if not pdf_path.exists():
        raise FileNotFoundError(f"PDF 文件不存在:{pdf_path}")

    out_dir.mkdir(parents=True, exist_ok=True)
    doc = fitz.open(pdf_path)
    n = doc.page_count
    print(f"📄 {pdf_path.name} 共 {n} 页,DPI={dpi}")

    png_paths = []
    for i, page in enumerate(doc, start=1):
        # 计算缩放比(DPI / 72,PDF 默认 72 DPI)
        zoom = dpi / 72
        matrix = fitz.Matrix(zoom, zoom)
        pix = page.get_pixmap(matrix=matrix, alpha=False)

        # 文件名:report_page_001_200dpi.png
        png_path = out_dir / f"{pdf_path.stem}_page_{i:03d}_{dpi}dpi.png"
        pix.save(str(png_path))
        png_paths.append(png_path)
        print(f"  ✓ Page {i}/{n} → {png_path.name}  ({pix.width}×{pix.height})")

    doc.close()
    return png_paths


def main() -> None:
    parser = argparse.ArgumentParser(
        description="PDF → PNG 渲染(pymupdf,默认 200 DPI)",
    )
    parser.add_argument("pdf_path", type=Path, help="PDF 文件路径")
    parser.add_argument(
        "output_dir",
        type=Path,
        nargs="?",
        default=None,
        help="输出目录(默认: <pdf_path>/<basename>_pages/)",
    )
    parser.add_argument(
        "--dpi",
        type=int,
        default=200,
        help="渲染 DPI(默认 200,印刷扫描件推荐 200-300)",
    )

    args = parser.parse_args()

    out_dir = args.output_dir or args.pdf_path.parent / f"{args.pdf_path.stem}_pages"

    t0 = time.perf_counter()
    pngs = render_pdf(args.pdf_path, out_dir, args.dpi)
    elapsed = time.perf_counter() - t0

    print(f"\n✅ 完成 {len(pngs)} 张 · 耗时 {elapsed:.2f}s · 输出目录:{out_dir}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"\n❌ 错误:{e}", file=sys.stderr)
        sys.exit(1)