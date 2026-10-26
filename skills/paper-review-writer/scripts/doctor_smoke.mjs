// doctor_smoke.mjs — doctor 子命令的子进程冒烟入口（父进程 scripts/doctor.mjs 逐模式 spawn 本文件）
// 设计思路：原生依赖（sharp / @napi-rs/canvas / pdfjs 渲染链）有「依赖装着、一跑就崩」的静默失败
// 形态（node_modules 残留旧版副本 → 段错误 0xC0000005）。冒烟放独立子进程：进程崩了也不影响父进程
// 自检编排，退出码与 stderr 尾行即健康结论。成功约定：打印 SMOKE_OK、退出码 0；失败：SMOKE_FAIL
// 行 + 非零退出码。环境变量：SMOKE_PDF_B64（父进程程序化构造的最小样张 base64）、
// SMOKE_PDFJS_DIR（pdfjs-dist 包目录，供 cMap/标准字体/wasm 资源定位）。

const mode = process.argv[2]

try {
  if (mode === "marked") {
    const mod = await import("marked")
    const parse = mod.marked?.parse || mod.parse
    if (typeof parse !== "function") throw new Error("marked 导出形态不符（无 parse）")
    const html = String(parse("# t"))
    if (!html.includes("<h1")) throw new Error("marked 解析输出异常")
  } else if (mode === "sharp") {
    const sharp = (await import("sharp")).default
    // 生成 → 读回双向走一遍：编码与解码任一路径断即不健康
    const buf = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 40, b: 40 } } }).png().toBuffer()
    const meta = await sharp(buf).metadata()
    if (meta.width !== 8 || meta.height !== 8) throw new Error("sharp 尺寸断言失败")
  } else if (mode === "canvas") {
    const { createCanvas } = await import("@napi-rs/canvas")
    const c = createCanvas(16, 16)
    const ctx = c.getContext("2d")
    ctx.fillStyle = "#123456"
    ctx.fillRect(0, 0, 16, 16)
    const buf = c.toBuffer("image/png")
    if (buf.length < 50) throw new Error("canvas PNG 输出异常")
  } else if (mode === "pdf-parse") {
    // pdf-parse@2 无 default 导出，类形态 API：new PDFParse({ data }).getText()（与 fig_embed.mjs 同构）
    const { PDFParse } = await import("pdf-parse")
    if (typeof PDFParse !== "function") throw new Error("pdf-parse 导出形态不符（无 PDFParse 类）")
    // 样张缺省守卫：与 pdfjs 分支的 SMOKE_PDFJS_DIR 守卫对称；缺注入时报间接错（提取不到标记文本）会误导排障方向
    if (!process.env.SMOKE_PDF_B64) throw new Error("SMOKE_PDF_B64 未注入（应由 doctor.mjs 父进程注入）")
    const parser = new PDFParse({ data: new Uint8Array(Buffer.from(process.env.SMOKE_PDF_B64 || "", "base64")) })
    const out = await parser.getText()
    const text = String((out && out.text) || "").replace(/\s+/g, "")
    if (!text.includes("SMOKE")) throw new Error("未从样张提取到标记文本")
  } else if (mode === "pdfjs") {
    const { createCanvas } = await import("@napi-rs/canvas")
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs")
    const sharp = (await import("sharp")).default
    // 资源 url 参数要求正斜杠且以 / 结尾（与 fig_render.mjs 同口径，Windows 反斜杠会被 pdfjs 拒绝）
    const dirBase = String(process.env.SMOKE_PDFJS_DIR || "").replace(/\\/g, "/").replace(/\/?$/, "/")
    if (dirBase === "/") throw new Error("SMOKE_PDFJS_DIR 未注入（pdfjs-dist 未安装或解析失败）")
    // 自建 canvasFactory（Node 下 pdfjs 无默认实现；结构与 fig_render.mjs 同构，冒烟才等价于真实渲染热路径）
    const canvasFactory = {
      create(w, h) {
        const c = createCanvas(Math.ceil(w), Math.ceil(h))
        return { canvas: c, context: c.getContext("2d") }
      },
      reset(cc, w, h) {
        cc.canvas.width = Math.ceil(w)
        cc.canvas.height = Math.ceil(h)
      },
      destroy(cc) {
        cc.canvas = null
        cc.context = null
      },
    }
    const doc = await getDocument({
      data: new Uint8Array(Buffer.from(process.env.SMOKE_PDF_B64 || "", "base64")),
      isEvalSupported: false,
      useSystemFonts: true,
      verbosity: 0,
      canvasFactory,
      cMapUrl: dirBase + "cmaps/",
      standardFontDataUrl: dirBase + "standard_fonts/",
      wasmUrl: dirBase + "wasm/",
    }).promise
    const page = await doc.getPage(1)
    const vp = page.getViewport({ scale: 1.5 })
    const cc = canvasFactory.create(vp.width, vp.height)
    await page.render({ canvasContext: cc.context, viewport: vp }).promise
    const png = cc.canvas.toBuffer("image/png")
    canvasFactory.destroy(cc)
    // 空白检测：纯白页各通道 stdev≈0，渲染出文字则明显非零（阈值放宽到 2 防抖动误报）
    const stats = await sharp(png).stats()
    if (!stats.channels.some(ch => ch.stdev > 2)) throw new Error("渲染产物疑似空白页")
  } else {
    throw new Error("未知冒烟模式：" + mode)
  }
  console.log("SMOKE_OK")
} catch (e) {
  console.error("SMOKE_FAIL: " + ((e && e.message) || e))
  process.exitCode = 1
}
