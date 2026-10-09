// verify-interaction.mjs — 交互演示交付断言·数据层薄壳（零依赖，纯 Node vm）
// 设计思路：jsdom 不带 canvas 2D 实现，像素级验证只能在浏览器做（SKILL.md §二「交付前自测」目验 +
//   template 内嵌 runSelfTests()）。本壳只负责数据层三件事：
//   ① 提取管线三重断言（开闭计数 / 锚点符号 / 长度下限，直击"漏收尾标签→空提取→node --check 假通过"）；
//   ② vm 沙箱加载业务层（最小 DOM stub，要求演示已按 compute/draw 分离纪律落地）；
//   ③ 发现 compute* 纯函数（优先读演示挂的 globalThis.COMPUTE_EXPORTS，回退扫描 function 声明）。
// 设计边界：requestAnimationFrame 回调永不触发属设计——壳只保 compute 层加载与断言，
//   draw 层验证归浏览器目验 + 内嵌自测；ctx stub 任意方法返回 undefined（measureText 除外，返回 {width:0}）同属此边界。
// 用法 A（CLI 自检）：node verify-interaction.mjs <demo.html> [锚点1,锚点2,...]
//   锚点默认 CONFIG,SLIDER_IDS,updateAll,drawAxes（按演示实际函数名单定制）
// 用法 B（矩阵断言脚本复用）：import { loadDemoHtml, assertClose, assertTrue, assertFiniteArray }
//   const { ok, errors, sandbox, computeFns } = loadDemoHtml("demo.html")
//   // computeFns 是函数名数组，经 sandbox[name](...) 调用；每控件 min/max/step 两端 + 默认态逐格断言（含无响应格输出不变）
import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"
import vm from "node:vm"

// 断言辅助（本壳与外部矩阵断言脚本复用；与 template.html 自测块 __assertClose 同构，expected≈0 时传 absTol 兜底）
export function assertClose(actual, expected, relTol, label, absTol) {
  const ok = Math.abs(actual - expected) <= Math.max(relTol * Math.abs(expected), absTol || 0)
  if (!ok) console.error("[矩阵断言失败] " + label + ": 实际 " + actual + " 期望 " + expected + " (relTol " + relTol + ", absTol " + (absTol || 0) + ")")
  return ok
}
export function assertTrue(cond, label) {
  if (!cond) console.error("[矩阵断言失败] " + label)
  return !!cond
}
export function assertFiniteArray(arr, label) {
  return assertTrue(Array.isArray(arr) && arr.length > 0 && arr.every(Number.isFinite), "NaN/Infinity 零容忍: " + label)
}

const DEFAULT_ANCHORS = ["CONFIG", "SLIDER_IDS", "updateAll", "drawAxes"]

// 提取 + 三重断言 + 沙箱加载 + compute 发现。返回 { ok, errors, js, sandbox, computeFns }；
// ok=false 时 errors 含全部失败原因，js/sandbox/computeFns 为 undefined。
export function loadDemoHtml(file, anchors) {
  const list = anchors && anchors.length ? anchors : DEFAULT_ANCHORS
  const errors = []
  let html
  try { html = readFileSync(file, "utf8") }
  catch (e) { return { ok: false, errors: ["读文件失败: " + e.message] } }

  // 三重断言 1：script 开闭计数相等（防漏收尾标签）
  const openN = (html.match(/<script\b/g) || []).length
  const closeN = (html.match(/<\/script>/g) || []).length
  if (openN !== closeN) errors.push("三重断言1: <script> 开 " + openN + " / 闭 " + closeN + " 不相等（疑漏收尾标签）")

  // 三重断言 2/3：锚点全命中 + 长度 > 500（只防"提取到空气"，不设绝对大阈值）
  const blocks = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1])
  const js = blocks.filter(b => !/\bsrc=/.test(b)).join("\n;\n")
  const missing = list.filter(a => !js.includes(a))
  if (missing.length) errors.push("三重断言2: 锚点未命中 " + missing.join(", "))
  if (js.length <= 500) errors.push("三重断言3: 提取长度 " + js.length + " ≤ 500（提取到空气？）")
  if (errors.length) return { ok: false, errors }

  // 最小 DOM stub：覆盖演示顶层常见触点（定时器/选择器/视口/热图 LUT/手测量尺寸）
  const ctxStub = () => new Proxy({}, {
    get: (t, p) => (p === "canvas" ? {} : (p === "measureText" ? () => ({ width: 0 }) : () => {})),
    set: () => true,
  })
  const elStub = () => ({
    addEventListener() {}, getContext: ctxStub,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 450, width: 800, height: 450 }),
    parentElement: { observe() {} },
    clientWidth: 800, clientHeight: 450, value: "50", textContent: "",
    style: {}, appendChild() {},
  })
  const sandbox = {
    console, Math, Number, Array, Object, JSON, parseFloat, parseInt, isFinite,
    setTimeout() {}, setInterval() {}, clearTimeout() {}, clearInterval() {},
    document: {
      getElementById: () => elStub(),
      querySelector: () => elStub(),
      querySelectorAll: () => [],
      createElement: () => elStub(),
      body: elStub(),
      addEventListener() {},
    },
    window: { devicePixelRatio: 1, innerWidth: 1280, innerHeight: 800, addEventListener() {} },
    devicePixelRatio: 1, innerWidth: 1280, innerHeight: 800,
    navigator: { userAgent: "verify-shell", maxTouchPoints: 0 },
    location: { href: "file:///demo.html", search: "", hash: "" },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    performance: { now: () => 0 },
    requestAnimationFrame() {},
    ResizeObserver: class { observe() {} disconnect() {} },
    ImageData: class { constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4) } },
    Image: class { constructor() { this.width = 0; this.height = 0 } },
  }
  vm.createContext(sandbox)
  try { vm.runInContext(js, sandbox, { filename: file }) }
  catch (e) { return { ok: false, errors: ["沙箱加载失败: " + e.message] } }

  // compute 发现：优先 COMPUTE_EXPORTS（vm 顶层 const 箭头函数不进全局对象，演示须显式挂出），
  // 回退扫描 function 声明（覆盖不全，提示演示补挂）
  let computeFns
  if (sandbox.COMPUTE_EXPORTS && typeof sandbox.COMPUTE_EXPORTS === "object") {
    computeFns = Object.keys(sandbox.COMPUTE_EXPORTS).filter(k => typeof sandbox.COMPUTE_EXPORTS[k] === "function")
  } else {
    computeFns = Object.keys(sandbox).filter(k => /^compute/i.test(k) && typeof sandbox[k] === "function")
  }
  return { ok: true, errors, js, sandbox, computeFns }
}

// CLI 入口守卫：被 import 时不执行（否则 argv 缺失直接 exit 杀死导入方）
async function main() {
  const file = process.argv[2]
  if (!file) { console.error("用法:node verify-interaction.mjs <demo.html> [锚点1,锚点2,...]"); process.exit(2) }
  const anchors = process.argv[3] ? process.argv[3].split(",").map(s => s.trim()).filter(Boolean) : undefined
  const r = loadDemoHtml(file, anchors)
  if (!r.ok) { for (const e of r.errors) console.error("✗ " + e); process.exit(1) }
  console.log("✓ 三重断言通过（script 开闭相等 / 锚点全命中 / 提取长度 > 500）")
  console.log("✓ 沙箱加载通过（顶层执行无异常；浏览器侧 runSelfTests 结果以浏览器 console 为准）")
  if (r.computeFns.length) console.log("compute* 纯函数: " + r.computeFns.join(", "))
  else console.log("⚠ 未发现 compute* 纯函数——演示未挂 globalThis.COMPUTE_EXPORTS 且无 function 声明的 compute*？见 SKILL.md §二「交付断言自检」")
  console.log("下一步:import 本文件 loadDemoHtml + assert 辅助，按 SKILL.md 断言触发表补写 控件×面板 响应矩阵断言")
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) { main() }
