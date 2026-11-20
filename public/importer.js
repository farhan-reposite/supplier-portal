// Reads one PO schedule workbook (the "kw_po.xlsx" layout).
//   file name first word = supplier code      F7 = supplier name (used only for new suppliers)
//   F8 = PO number                            I15 = first day of the month
//   D = part no (from row 17)  G = part name  H = qty per box (lot)
//   I, J, K ... = day 1, day 2, day 3 ... of the month, cell = total pieces for that day
(function (root) {
  var FIRST_ROW = 17;
  var FIRST_DAY_COL = 8; // column I (0-based)

  function text(v) {
    return String(v == null ? '' : v).replace(/^[\s:]+/, '').replace(/\s+/g, ' ').trim();
  }

  function monthFromCell(v) {
    if (typeof v === 'number' && isFinite(v)) return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 7);
    var s = String(v == null ? '' : v).trim(), m;
    if ((m = s.match(/^(\d{4})-(\d{1,2})-\d{1,2}/))) return m[1] + '-' + ('0' + m[2]).slice(-2);
    if ((m = s.match(/^\d{1,2}[\/.-](\d{1,2})[\/.-](\d{4})$/))) return m[2] + '-' + ('0' + m[1]).slice(-2);
    return '';
  }

  function parsePoWorkbook(fileName, wb, XLSX) {
    var out = {
      fileName: fileName, supplierCode: '', supplierName: '', po: '', month: '',
      rows: [], parts: 0, cells: 0, boxes: 0, partialBoxes: 0, emptyParts: 0,
      errors: [], warnings: [],
    };
    var codeMatch = String(fileName).replace(/\.[^.]+$/, '').match(/[A-Za-z0-9]+/);
    out.supplierCode = codeMatch ? codeMatch[0].toUpperCase() : '';
    if (!out.supplierCode) out.errors.push('The file name must start with the supplier code, like KW_po.xlsx');

    var ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) { out.errors.push('The file has no sheets'); return out; }
    var cell = function (addr) { return ws[addr] ? ws[addr].v : undefined; };

    out.supplierName = text(cell('F7'));
    out.po = text(cell('F8')).replace(/;/g, ' ');
    if (!out.po) out.errors.push('PO number is missing in cell F8');

    out.month = monthFromCell(cell('I15'));
    if (!out.month) out.errors.push('Cell I15 must contain the first date of the month');

    if (out.errors.length) return out;

    var y = Number(out.month.slice(0, 4)), mo = Number(out.month.slice(5, 7));
    var days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    var ref = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : { e: { r: 0 } };
    var lastRow = Math.min(ref.e.r + 1, 1000);
    var seen = {};

    for (var r = FIRST_ROW; r <= lastRow; r++) {
      var partNo = String(cell('D' + r) == null ? '' : cell('D' + r)).trim();
      if (!partNo) continue;
      if (partNo.indexOf(';') >= 0) { out.errors.push('Row ' + r + ': part number contains ";"'); continue; }
      var name = text(cell('G' + r));
      var lot = Number(cell('H' + r));
      var rowCells = 0, rowBad = false;

      for (var d = 1; d <= days; d++) {
        var v = cell(XLSX.utils.encode_cell({ r: r - 1, c: FIRST_DAY_COL + d - 1 }));
        if (v === undefined || v === null || String(v).trim() === '') continue;
        var q = Number(v);
        if (!isFinite(q) || q < 0) { out.errors.push('Row ' + r + ', day ' + d + ': "' + v + '" is not a valid quantity'); continue; }
        if (Math.abs(q - Math.round(q)) > 1e-6) { out.errors.push('Row ' + r + ', day ' + d + ': ' + q + ' is not a whole number'); continue; }
        q = Math.round(q);
        if (q === 0) continue;
        if (!(Number.isInteger(lot) && lot > 0)) { rowBad = true; continue; }
        var date = out.month + '-' + ('0' + d).slice(-2);
        out.rows.push({ d: date, p: partNo, n: name, l: lot, q: q, o: r });
        out.cells++;
        out.boxes += Math.ceil(q / lot);
        if (q % lot !== 0) out.partialBoxes++;
        rowCells++;
      }
      if (rowBad) out.errors.push('Row ' + r + ' (' + partNo + '): qty per box in column H is missing');
      if (rowCells) {
        out.parts++;
        if (seen[partNo]) out.warnings.push(partNo + ' appears twice in the file; quantities are added together');
        seen[partNo] = true;
      } else {
        out.emptyParts++;
      }
    }

    if (!out.rows.length && !out.errors.length) out.errors.push('No deliveries found. Check that quantities start at column I (day 1).');
    if (out.partialBoxes) out.warnings.push(out.partialBoxes + ' delivery cell(s) are not a whole number of boxes; the last box carries the remainder');
    return out;
  }

  root.parsePoWorkbook = parsePoWorkbook;
})(typeof window !== 'undefined' ? window : globalThis);
