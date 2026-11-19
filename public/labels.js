// Label PDF generator. Page = 80 mm wide (POS-80), one label per page.
// Layout coordinates below are in "grid px" on a 355 x 355 grid, scaled to LABEL_CFG.size mm.

const LABEL_CFG = {
  page: 80,              // mm, page width and height
  size: 72,              // mm, label square (printable width of a POS-80 is ~72 mm)
  qcText: 'QC Passed',
  sjFallback: 'Road Number',  // used when the supplier leaves "No SJ" empty
  emptyField: ' ',       // 4th field of the full QR (a single space in your sample)
  trailer: '.',           // text appended after the supplier code in the full QR (your sample may end with ".")
};

// 2026-07-24;Road Number;BDG120001(AQ); ;150;SWI/200/XI/2026;;;1/1;XXI
function fullQrValue(l) {
  return [
    l.date, l.sj, l.partNo, LABEL_CFG.emptyField, l.qty, l.po, '', '', `${l.box}/${l.boxes}`, l.supplier,
  ].join(';') + LABEL_CFG.trailer;
}

function drawQr(doc, text, x, y, size) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const m = size / n;
  doc.setFillColor(0, 0, 0);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) doc.rect(x + c * m, y + r * m, m + 0.02, m + 0.02, 'F'); // tiny overlap avoids hairline gaps
    }
  }
}

function drawLabel(doc, L) {
  const S = LABEL_CFG.size / 355;
  const ox = (LABEL_CFG.page - LABEL_CFG.size) / 2;
  const oy = ox;
  const X = (v) => ox + v * S;
  const Y = (v) => oy + v * S;
  const PT = (px) => px * S * 2.8346;

  doc.setDrawColor(0);
  doc.setTextColor(0);
  doc.setLineWidth(0.3);
  doc.rect(X(0), Y(0), 355 * S, 355 * S);
  const hl = (y, x1, x2) => doc.line(X(x1), Y(y), X(x2), Y(y));
  const vl = (x, y1, y2) => doc.line(X(x), Y(y1), X(x), Y(y2));
  vl(95, 0, 92); vl(182, 0, 92); hl(52, 95, 182); hl(92, 0, 355);
  vl(277, 92, 140); hl(140, 0, 355); hl(210, 0, 355);
  vl(210, 210, 355); hl(260, 0, 210); hl(305, 0, 210);

  const small = (t, x, y) => {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(PT(11));
    doc.text(t, X(x), Y(y));
  };
  const big = (t, x, y, maxW, px) => {
    doc.setFont('helvetica', 'bold');
    let s = PT(px);
    doc.setFontSize(s);
    const mw = maxW * S;
    while (doc.getTextWidth(t) > mw && s > 4) { s -= 0.25; doc.setFontSize(s); }
    doc.text(t, X(x), Y(y));
  };

  drawQr(doc, L.partNo, X(8), Y(7), 78 * S);
  small('Supplier', 101, 17);   big(L.supplier, 101, 45, 76, 24);
  small('Lot Box', 101, 66);    big(`${L.box}/ ${L.boxes}`, 101, 87, 76, 19);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(PT(14));
  doc.text(LABEL_CFG.qcText, X(268), Y(24), { align: 'center' });

  small('Part No', 6, 108);     big(L.partNo, 6, 133, 262, 20);
  small('Qty', 283, 108);       big(String(L.qty), 283, 133, 66, 20);

  small('Part Name', 6, 156);
  let px = 20, lines;
  doc.setFont('helvetica', 'bold');
  for (;;) {
    doc.setFontSize(PT(px));
    lines = doc.splitTextToSize(L.partName || '', 340 * S);
    if (lines.length <= (px >= 15 ? 1 : 2) || px <= 9) break;
    px -= 1;
  }
  if (lines.length <= 1) doc.text(lines[0] || '', X(6), Y(184));
  else { doc.text(lines[0], X(6), Y(176)); doc.text(lines[1], X(6), Y(196)); }

  small('Received Date', 6, 224); big(L.date, 6, 250, 198, 15);
  small('Nomor PO', 6, 273);      big(L.po, 6, 298, 198, 13);
  small('No SJ', 6, 318);         big(L.sj, 6, 345, 198, 13);

  drawQr(doc, fullQrValue(L), X(220), Y(220), 125 * S);
}

// data = response of POST /api/labels
function buildLabelsPdf(data) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: [LABEL_CFG.page, LABEL_CFG.page], orientation: 'portrait' });
  const sj = (data.sj || '').trim() || LABEL_CFG.sjFallback;
  let first = true;
  for (const line of data.lines) {
    for (let b = 1; b <= line.boxes; b++) {
      if (!first) doc.addPage([LABEL_CFG.page, LABEL_CFG.page], 'portrait');
      first = false;
      drawLabel(doc, {
        date: data.date, sj, supplier: data.supplier.code,
        partNo: line.part_no, partName: line.part_name, qty: line.qty_per_box,
        po: line.po_no, box: b, boxes: line.boxes,
      });
    }
  }
  return doc;
}
