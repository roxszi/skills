// ACS（pubs.acs.org）全文提取模板 · 适配 2026-10 版页面结构
// 用法：三段分别用宿主的浏览器 JS 执行能力（工具名见 SKILL.md §1.0 适配表）在已打开的文章页内执行；返回体大时分块取，再落盘。
// 站点改版致 .article-body 失效 → 回 assets/publisher-extract.md 通用流程。
// 零依赖；亦可在页面 console 直接执行。

// ── 段 1：侦察（确认 .article-body 仍在且含正文）──────────────────
(() => {
  var els = Array.from(document.querySelectorAll('div,section,article'))
    .filter(el => el.innerText && el.innerText.length > 3000)
    .map(el => ({ tag: el.tagName, cls: String(el.className).substring(0, 80), id: el.id || '', len: el.innerText.length }));
  return JSON.stringify({ title: document.title, containers: els.slice(0, 20) });
})()

// ── 段 2：结构化 walk + hash 去重 + window 暂存 ──────────────────
// 去重集合用于对抗出版商对同一表格/图注的双渲染（引用编号版与纯文本版）。
(() => {
  var root = document.querySelector('.article-body');
  if (!root) return JSON.stringify({ ok: false, reason: 'NO .article-body → 走通用流程 publisher-extract.md' });
  var out = [];
  var seen = new Set();
  function clean(s) { return (s || '').replace(/\s+/g, ' ').trim(); }
  function push(t) { var k = t.replace(/\s+/g, ''); if (seen.has(k)) return; seen.add(k); out.push(t); }
  function walk(el) {
    var kids = el.children;
    for (var i = 0; i < kids.length; i++) {
      var c = kids[i], tag = c.tagName, cls = String(c.className || '');
      if (/^H[1-6]$/.test(tag)) {
        push('\n\n' + '#'.repeat(parseInt(tag.substring(1)) + 1) + ' ' + clean(c.innerText));
      } else if (tag === 'P' && !c.querySelector('figure')) {
        var t = clean(c.innerText); if (t) push(t);
      } else if (tag === 'FIGURE' || cls.indexOf('figure') >= 0 || tag === 'FIGCAPTION') {
        var cap = c.querySelector('figcaption') || c;
        var ft = clean(cap.innerText); if (ft) push('[FIGURE] ' + ft);
      } else if (tag === 'TABLE') {
        var rows = c.querySelectorAll('tr'), tbl = [];
        for (var r = 0; r < rows.length; r++) {
          var cells = rows[r].querySelectorAll('th,td'), row = [];
          for (var k = 0; k < cells.length; k++) row.push(clean(cells[k].innerText));
          tbl.push('| ' + row.join(' | ') + ' |');
        }
        if (tbl.length) push('[TABLE]\n' + tbl.join('\n'));
      } else if (tag === 'UL' || tag === 'OL') {
        var items = c.querySelectorAll(':scope > li'), lis = [];
        for (var m = 0; m < items.length; m++) lis.push('- ' + clean(items[m].innerText));
        if (lis.length) push(lis.join('\n'));
      } else if (c.querySelector('h2,h3,h4,p,figure,table')) {
        walk(c);
      } else {
        var t2 = clean(c.innerText);
        if (t2 && t2.length > 40 && !c.querySelector('*')) push(t2);
      }
    }
  }
  walk(root);
  window._art = out.join('\n\n');
  var headings = out.filter(x => /^#/.test(x)).map(x => x.trim());
  var figs = out.filter(x => x.indexOf('[FIGURE]') === 0).map(x => x.substring(0, 120));
  var tblCount = out.filter(x => x.indexOf('[TABLE]') === 0).length;
  return JSON.stringify({ totalLen: window._art.length, headings: headings, figures: figs, tableCount: tblCount });
})()

// ── 段 3：分块取段（改两个数字；末段第二参省略即取到结尾）──────────
(() => { return window._art.substring(0, 30000); })()
