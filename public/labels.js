// Label generator.
// One layout (layoutLabel) feeds two outputs, so they always match:
//   buildLabelsPdf()  -> PDF download, 80 x 80 mm pages
//   printLabels()     -> print window, one 80 x 80 mm page per label (@page size); fallback only
//   direct-print.js   -> same layout drawn as a bitmap and sent straight to the printer through QZ Tray
// Layout coordinates are "grid px" on a 355 x 355 grid, scaled to LABEL_CFG.size mm.

const LABEL_CFG = {
  page: 80,              // mm, page width and height
  size: 72,              // mm, label square (printable width of a POS-80 is ~72 mm)
  qcText: 'QC Passed',
  sjFallback: 'Road Number',  // used when the supplier leaves "No SJ" empty
  emptyField: ' ',       // 4th field of the full QR (a single space in your sample)
  trailer: '',           // text appended after the supplier code in the full QR
  // Direct printing (public/direct-print.js): bitmap sent to the printer as ESC/POS, no print window.
  printer: {
    dpi: 203,            // print head resolution of the POS-80 (203 dots per inch is the normal value)
    widthDots: 576,      // dots across the label = 72 mm at 203 dpi (the printable width of an 80 mm head)
    feedMm: 8,           // paper pushed out after each label: 72 mm label + 8 mm = 80 mm per label
    cut: true,           // cut after each label
    perJob: 20,          // labels sent to the printer per job (keeps big prints stable)
  },
};
const GRID = 355;

// 2026-07-24;Road Number;BDG120001(AQ); ;150;SWI/200/XI/2026;;;1/1;XXI
function fullQrValue(l) {
  return [
    l.date, l.sj, l.partNo, LABEL_CFG.emptyField, l.qty, l.po, '', '', `${l.box}/${l.boxes}`, l.supplier,
  ].join(';') + LABEL_CFG.trailer;
}

/* ---------- shared pieces ---------- */

// QR as horizontal runs of dark modules: [[row, startCol, length], ...]
function qrRuns(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const runs = [];
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (!qr.isDark(r, c)) { c++; continue; }
      const start = c;
      while (c < n && qr.isDark(r, c)) c++;
      runs.push([r, start, c - start]);
    }
  }
  return { n, runs };
}

// Text width in grid px, using Helvetica metrics (same in PDF and print, so fitting is identical).
let _measureDoc = null;
function measureFn() {
  if (!_measureDoc) _measureDoc = new window.jspdf.jsPDF({ unit: 'mm', format: [80, 80] });
  const S = LABEL_CFG.size / GRID;
  return (t, px, bold) => {
    _measureDoc.setFont('helvetica', bold ? 'bold' : 'normal');
    _measureDoc.setFontSize(px * S * 2.8346);
    return _measureDoc.getTextWidth(t) / S;
  };
}

function wrapWords(text, maxW, px, measure) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? cur + ' ' + w : w;
    if (cur && measure(next, px, true) > maxW) { lines.push(cur); cur = w; } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

/* ---------- layout: list of drawing primitives in grid px ---------- */
function layoutLabel(L, measure) {
  const P = [];
  const line = (x1, y1, x2, y2) => P.push({ k: 'line', x1, y1, x2, y2 });
  const small = (s, x, y) => P.push({ k: 'text', s, x, y, px: 11, b: false });
  const big = (s, x, y, maxW, px) => {
    let size = px;
    while (measure(s, size, true) > maxW && size > 7) size -= 0.4;
    P.push({ k: 'text', s, x, y, px: size, b: true });
  };

  P.push({ k: 'rect', x: 0, y: 0, w: GRID, h: GRID });
  line(95, 0, 95, 92); line(182, 0, 182, 92); line(95, 52, 182, 52); line(0, 92, 355, 92);
  line(277, 92, 277, 140); line(0, 140, 355, 140); line(0, 210, 355, 210);
  line(210, 210, 210, 355); line(0, 260, 210, 260); line(0, 305, 210, 305);

  P.push({ k: 'qr', text: L.partNo, x: 8, y: 7, size: 78 });
  small('Supplier', 101, 17);   big(L.supplier, 101, 45, 76, 24);
  small('Lot Box', 101, 66);    big(`${L.box}/ ${L.boxes}`, 101, 87, 76, 19);
  P.push({ k: 'text', s: LABEL_CFG.qcText, x: 268, y: 24, px: 14, b: false, a: 'middle' });

  small('Part No', 6, 108);     big(L.partNo, 6, 133, 262, 20);
  small('Qty', 283, 108);       big(String(L.qty), 283, 133, 66, 20);

  small('Part Name', 6, 156);
  let px = 20, lines;
  for (;;) {
    lines = wrapWords(L.partName, 340, px, measure);
    if (lines.length <= (px >= 15 ? 1 : 2) || px <= 9) break;
    px -= 1;
  }
  if (lines.length <= 1) P.push({ k: 'text', s: lines[0], x: 6, y: 184, px, b: true });
  else { P.push({ k: 'text', s: lines[0], x: 6, y: 176, px, b: true }); P.push({ k: 'text', s: lines[1], x: 6, y: 196, px, b: true }); }

  small('Received Date', 6, 224); big(L.date, 6, 250, 198, 15);
  small('Nomor PO', 6, 273);      big(L.po, 6, 298, 198, 13);
  small('No SJ', 6, 318);         big(L.sj, 6, 345, 198, 13);

  P.push({ k: 'qr', text: fullQrValue(L), x: 220, y: 220, size: 125 });
  return P;
}

/* ---------- PDF renderer ---------- */
function renderLabelPdf(doc, prims) {
  const S = LABEL_CFG.size / GRID;
  const o = (LABEL_CFG.page - LABEL_CFG.size) / 2;
  const X = (v) => o + v * S;
  const Y = (v) => o + v * S;
  doc.setDrawColor(0);
  doc.setTextColor(0);
  doc.setLineWidth(0.3);
  for (const p of prims) {
    if (p.k === 'rect') doc.rect(X(p.x), Y(p.y), p.w * S, p.h * S);
    else if (p.k === 'line') doc.line(X(p.x1), Y(p.y1), X(p.x2), Y(p.y2));
    else if (p.k === 'text') {
      doc.setFont('helvetica', p.b ? 'bold' : 'normal');
      doc.setFontSize(p.px * S * 2.8346);
      doc.text(p.s, X(p.x), Y(p.y), p.a === 'middle' ? { align: 'center' } : undefined);
    } else if (p.k === 'qr') {
      const { n, runs } = qrRuns(p.text);
      const m = (p.size * S) / n, x0 = X(p.x), y0 = Y(p.y);
      const k = doc.internal.scaleFactor;
      const pageH = doc.internal.pageSize.getHeight();
      const f = (v) => (v * k).toFixed(2);
      let ops = '0 g\n';
      for (const [r, c, len] of runs) {
        // tiny overlap avoids hairline gaps between rows on thermal printers
        ops += `${f(x0 + c * m)} ${f(pageH - (y0 + r * m) - m - 0.01)} ${f(len * m + 0.02)} ${f(m + 0.02)} re\n`;
      }
      doc.internal.write(ops + 'f');
    }
  }
}

/* ---------- SVG renderer (for printing) ---------- */
const svgEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function renderLabelSvg(prims) {
  const lw = (0.3 / (LABEL_CFG.size / GRID)).toFixed(2);
  let out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GRID} ${GRID}" shape-rendering="crispEdges">` +
    `<g fill="none" stroke="#000" stroke-width="${lw}" stroke-linecap="square">`;
  let texts = '', qrs = '';
  for (const p of prims) {
    if (p.k === 'rect') out += `<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}"/>`;
    else if (p.k === 'line') out += `<path d="M${p.x1} ${p.y1}L${p.x2} ${p.y2}"/>`;
    else if (p.k === 'text') {
      texts += `<text x="${p.x}" y="${p.y}" font-size="${p.px.toFixed(2)}" font-weight="${p.b ? 700 : 400}"` +
        `${p.a === 'middle' ? ' text-anchor="middle"' : ''}>${svgEsc(p.s)}</text>`;
    } else if (p.k === 'qr') {
      const { n, runs } = qrRuns(p.text);
      const m = p.size / n;
      let d = '';
      for (const [r, c, len] of runs) {
        d += `M${(p.x + c * m).toFixed(2)} ${(p.y + r * m).toFixed(2)}h${(len * m + 0.05).toFixed(2)}v${(m + 0.05).toFixed(2)}h-${(len * m + 0.05).toFixed(2)}z`;
      }
      qrs += `<path d="${d}" fill="#000" stroke="none"/>`;
    }
  }
  return out + '</g>' + qrs +
    `<g fill="#000" stroke="none" font-family="Helvetica, Arial, 'Liberation Sans', sans-serif">${texts}</g></svg>`;
}

/* ---------- public API ---------- */

// Every box holds qty_per_box, except the last one, which holds the remainder.
function boxQty(l, box) {
  return box < l.boxes ? l.qty_per_box : l.qty_total - l.qty_per_box * (l.boxes - 1);
}

// data = response of POST /api/labels -> flat list of single labels
function expandLabels(data) {
  const list = [];
  for (const l of data.labels) {
    const sj = (l.sj || '').trim() || LABEL_CFG.sjFallback;
    for (let b = l.from; b <= l.to; b++) {
      list.push({
        date: l.date, sj, supplier: data.supplier.code,
        partNo: l.part_no, partName: l.part_name, qty: boxQty(l, b),
        po: l.po_no, box: b, boxes: l.boxes,
      });
    }
  }
  return list;
}

function buildLabelsPdf(data) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: [LABEL_CFG.page, LABEL_CFG.page], orientation: 'portrait', compress: true });
  const measure = measureFn();
  expandLabels(data).forEach((L, i) => {
    if (i) doc.addPage([LABEL_CFG.page, LABEL_CFG.page], 'portrait');
    renderLabelPdf(doc, layoutLabel(L, measure));
  });
  return doc;
}

// A page sized exactly 80 x 80 mm per label, no margins, a page break after each one.
function buildPrintHtml(data, title) {
  const measure = measureFn();
  const pages = expandLabels(data)
    .map((L) => `<div class="pg">${renderLabelSvg(layoutLabel(L, measure))}</div>`).join('');
  const pg = LABEL_CFG.page + 'mm', sz = LABEL_CFG.size + 'mm';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${svgEsc(title || 'Labels')}</title><style>
@page { size: ${pg} ${pg}; margin: 0; }
html, body { margin: 0; padding: 0; background: #fff; }
* { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.pg { width: ${pg}; height: ${pg}; display: flex; align-items: center; justify-content: center; overflow: hidden;
      break-after: page; page-break-after: always; }
.pg:last-child { break-after: auto; page-break-after: auto; }
.pg svg { width: ${sz}; height: ${sz}; display: block; overflow: visible; }
</style></head><body>${pages}</body></html>`;
}

// Opens the browser print window with the labels. The user picks the POS-80 printer there.
function printLabels(data, title) {
  const old = document.getElementById('print-frame');
  if (old) old.remove();
  const f = document.createElement('iframe');
  f.id = 'print-frame';
  f.setAttribute('aria-hidden', 'true');
  f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  document.body.appendChild(f);
  const w = f.contentWindow;
  w.document.open();
  w.document.write(buildPrintHtml(data, title));
  w.document.close();
  return new Promise((resolve) => {
    setTimeout(() => { w.focus(); w.print(); resolve(); }, 300); // let the page lay out first
  });
}
