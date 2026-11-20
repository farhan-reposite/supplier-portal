const S = {
  supplier: null, today: todayLocal(), months: [], month: '',
  cache: {},                // month -> { lines, printed }
  selected: new Set(),      // selected dates
  lineOn: {},               // line id -> { on, from, to }
  sj: {},                   // date -> No SJ text
};

(async () => {
  const me = await api('/api/me');
  if (me.role === 'admin') { location.href = '/admin'; return; }
  renderTopbar({ who: `<b>${esc(me.supplier_name)}</b> · ${esc(me.supplier_code)}` });
  $('prev').innerHTML = ICON.left;
  $('next').innerHTML = ICON.right;
  await loadMonth();
})();

async function loadMonth(month, force) {
  try {
    if (!force && month && S.cache[month]) { S.month = month; render(); return; }
    $('cal').innerHTML = '<div class="skeleton" style="grid-column:1/-1;height:280px"></div>';
    const d = await api('/api/schedule' + (month ? '?month=' + month : ''));
    S.supplier = d.supplier; S.today = d.today || todayLocal(); S.months = d.months; S.month = d.month;
    S.cache[d.month] = { lines: d.lines, printed: new Set(d.printed) };
    render();
  } catch (e) { toast(e.message, 'err'); }
}

const monthLines = () => (S.cache[S.month] || { lines: [] }).lines;
const allLines = () => Object.values(S.cache).flatMap((c) => c.lines);
function byDate(lines) { const m = {}; lines.forEach((l) => (m[l.delivery_date] = m[l.delivery_date] || []).push(l)); return m; }
const lineState = (l) => (S.lineOn[l.id] = S.lineOn[l.id] || { on: true, from: 1, to: l.boxes });

function render() {
  renderMonthPicker();
  renderOwed();
  renderCalendar();
  renderPanel();
}

/* ---------- month ---------- */
function renderMonthPicker() {
  const months = [...new Set([...S.months, S.month])].sort();
  $('monthsel').innerHTML = months.map((m) => `<option value="${m}" ${m === S.month ? 'selected' : ''}>${esc(fmtMonth(m))}</option>`).join('');
  $('prev').disabled = months.indexOf(S.month) <= 0;
  $('next').disabled = months.indexOf(S.month) >= months.length - 1;
}

function renderOwed() {
  const owed = monthLines().filter((l) => l.status === 'shortage');
  if (!owed.length) { $('owed').innerHTML = ''; return; }
  $('owed').innerHTML = `<section class="card" style="margin-bottom:16px">
    <div class="card-head"><h2>Still owed this month</h2><span class="badge warn">${owed.length} part${owed.length > 1 ? 's' : ''} short</span></div>
    <div class="table-wrap"><table class="list"><thead><tr><th>Date</th><th>Part No</th><th>Part name</th><th class="num">Scheduled</th><th class="num">Received</th><th class="num">Owed</th></tr></thead><tbody>
    ${owed.map((l) => `<tr><td>${esc(fmtDate(l.delivery_date))}</td><td><b>${esc(l.part_no)}</b></td><td class="muted">${esc(l.part_name)}</td>
      <td class="num">${fmtNum(l.qty_total)}</td><td class="num">${fmtNum(l.qty_received)}</td>
      <td class="num"><b style="color:var(--warn)">${fmtNum(l.qty_total - l.qty_received)}</b></td></tr>`).join('')}
    </tbody></table></div></section>`;
}

/* ---------- calendar ---------- */
function renderCalendar() {
  const lines = monthLines(), dates = byDate(lines), cache = S.cache[S.month];
  const first = S.month + '-01';
  let html = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<div class="dow">${d}</div>`).join('');
  html += '<div></div>'.repeat(dowMon(first));
  for (let d = 1; d <= daysIn(S.month); d++) {
    const date = `${S.month}-${String(d).padStart(2, '0')}`;
    const ls = dates[date];
    const cls = ['d'];
    let mark = '', boxes = '';
    if (ls) {
      cls.push('has');
      boxes = ls.reduce((n, l) => n + l.boxes, 0) + ' box';
      if (ls.every((l) => l.status === 'received')) mark = 'ok';
      else if (ls.some((l) => l.status === 'shortage')) mark = 'warn';
      else if (date < S.today) mark = 'late';
    }
    if (S.selected.has(date)) cls.push('sel');
    if (date === S.today) cls.push('today');
    const isPrinted = !!(ls && cache.printed.has(date));
    if (isPrinted) boxes += ' ✓';
    const printed = isPrinted ? ' · labels already downloaded' : '';
    html += `<button class="${cls.join(' ')}" data-date="${date}" ${ls ? '' : 'disabled'} aria-pressed="${S.selected.has(date)}"
      aria-label="${esc(fmtDate(date))}${ls ? ', ' + boxes : ', no delivery'}${printed}">
      <span class="n">${d}</span><span class="b">${boxes}</span>${mark ? `<i class="mk ${mark}"></i>` : ''}</button>`;
  }
  $('cal').innerHTML = html;
}

$('cal').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-date]');
  if (!b) return;
  const date = b.dataset.date;
  if (S.selected.has(date)) S.selected.delete(date); else S.selected.add(date);
  renderCalendar(); renderPanel();
});
$('prev').onclick = () => step(-1);
$('next').onclick = () => step(1);
function step(dir) {
  const months = [...new Set([...S.months, S.month])].sort();
  const m = months[months.indexOf(S.month) + dir];
  if (m) loadMonth(m);
}
$('monthsel').onchange = (e) => loadMonth(e.target.value);

async function selectDate(date) {
  const m = date.slice(0, 7);
  if (m !== S.month) await loadMonth(m);
  S.selected.add(date);
  render();
}
$('q-today').onclick = async () => {
  const t = S.today;
  await loadMonth(t.slice(0, 7));
  if (byDate(monthLines())[t]) { S.selected.add(t); render(); } else toast('No delivery scheduled today', 'err');
};
$('q-next').onclick = async () => {
  const cur = S.today.slice(0, 7);
  for (const m of [...new Set([...S.months, cur])].sort().filter((x) => x >= cur)) {
    if (!S.cache[m]) await loadMonth(m);
    const next = Object.keys(byDate(S.cache[m].lines)).sort().find((d) => d >= S.today);
    if (next) { await selectDate(next); return; }
  }
  toast('No upcoming deliveries', 'err');
};
$('q-clear').onclick = () => { S.selected.clear(); render(); };

/* ---------- selected dates panel ---------- */
function renderPanel() {
  const dates = [...S.selected].sort();
  if (!dates.length) {
    $('panel').innerHTML = `<div class="card empty">${ICON.box}<h3>Choose a delivery date</h3>
      <p>Select one or more dates on the calendar to see the parts and print their labels.</p>
      <button class="primary" onclick="$('q-next').click()">Select next delivery</button></div>`;
    return;
  }
  const grouped = byDate(allLines());
  let labels = 0;
  const blocks = dates.map((date) => {
    const ls = grouped[date] || [];
    const pos = [...new Set(ls.map((l) => l.po_no))];
    const multi = pos.length > 1;
    const onCount = ls.filter((l) => lineState(l).on).length;
    let n = 0;
    const rows = ls.map((l) => {
      const st = lineState(l);
      const cnt = st.on ? Math.max(0, st.to - st.from + 1) : 0;
      n += cnt;
      const short = l.status === 'shortage' ? ` <span class="badge shortage">owed ${fmtNum(l.qty_total - l.qty_received)}</span>`
        : l.status === 'received' ? ' <span class="badge received">received</span>' : '';
      return `<tr class="${st.on ? '' : 'off'}" data-line="${l.id}">
        <td><input type="checkbox" data-act="on" ${st.on ? 'checked' : ''} aria-label="Print ${esc(l.part_no)}"></td>
        <td><b>${esc(l.part_no)}</b>${short}<div class="muted small">${esc(l.part_name)}</div></td>
        ${multi ? `<td class="muted small">${esc(l.po_no)}</td>` : ''}
        <td class="num">${fmtNum(l.qty_total)}<div class="muted small">${l.boxes} box × ${fmtNum(l.qty_per_box)}</div></td>
        <td><span class="range"><input type="number" data-act="from" min="1" max="${l.boxes}" value="${st.from}" ${st.on ? '' : 'disabled'} aria-label="From box">
          –<input type="number" data-act="to" min="1" max="${l.boxes}" value="${st.to}" ${st.on ? '' : 'disabled'} aria-label="To box"></span></td>
        <td class="num"><b>${cnt}</b></td></tr>`;
    }).join('');
    labels += n;
    return `<section class="card dateblock" data-date="${date}">
      <div class="dh"><div style="flex:1 1 auto"><h3>${esc(fmtDate(date, true))}</h3>
          ${multi ? '' : `<div class="muted small">PO ${esc(pos[0] || '')}</div>`}</div>
        <div class="sj"><input data-act="sj" maxlength="40" placeholder="No SJ for this date" value="${esc(S.sj[date] || '')}" aria-label="No SJ for ${esc(date)}"></div>
        <button class="sm ghost icon" data-act="remove" aria-label="Remove date">${ICON.close}</button></div>
      <div class="table-wrap"><table class="list"><thead><tr>
        <th><input type="checkbox" data-act="all" ${onCount === ls.length ? 'checked' : ''} aria-label="Select all parts"></th>
        <th>Part</th>${multi ? '<th>PO</th>' : ''}<th class="num">Scheduled</th><th>Boxes to print</th><th class="num">Labels</th></tr></thead>
      <tbody>${rows}</tbody></table></div></section>`;
  }).join('');

  $('panel').innerHTML = blocks + `<div class="sticky-bar">
    <div class="grow"><b>${fmtNum(labels)}</b> label${labels === 1 ? '' : 's'} <span class="muted">from ${dates.length} date${dates.length > 1 ? 's' : ''}</span></div>
    ${dates.length > 1 ? `<button class="sm ghost" data-act="sjall" data-icon="check">Copy first No SJ to all</button>` : ''}
    <div class="btn-row">
      <button class="primary" id="dlpdf" data-icon="filedown" ${labels ? '' : 'disabled'}>Download PDF</button>
    </div></div>`;
  applyIcons($('panel'));
}      

// <button class="sm ghost" data-act="printer" title="Choose which printer the labels go to">${esc(store.get('printer', '') ? 'Printer: ' + store.get('printer', '') : 'Choose printer')}</button>
// <button id="print" class="primary" data-icon="print" ${labels ? '' : 'disabled'} title="Sends the labels straight to the printer, one 80 × 80 mm label each">Print labels</button>

$('panel').addEventListener('input', (e) => {
  const act = e.target.dataset.act;
  if (act === 'sj') { S.sj[e.target.closest('.dateblock').dataset.date] = e.target.value; return; }
  const tr = e.target.closest('tr[data-line]');
  if (!tr || (act !== 'from' && act !== 'to')) return;
  const l = allLines().find((x) => x.id === Number(tr.dataset.line));
  const st = lineState(l);
  const v = Math.min(l.boxes, Math.max(1, parseInt(e.target.value, 10) || 1));
  st[act] = v;
  refreshCounts();
});
$('panel').addEventListener('change', (e) => {
  if (e.target.dataset.act === 'all') {
    const date = e.target.closest('.dateblock').dataset.date;
    (byDate(allLines())[date] || []).forEach((l) => { lineState(l).on = e.target.checked; });
    renderPanel(); return;
  }
  const tr = e.target.closest('tr[data-line]');
  if (!tr) return;
  const l = allLines().find((x) => x.id === Number(tr.dataset.line));
  const st = lineState(l);
  if (e.target.dataset.act === 'on') { st.on = e.target.checked; renderPanel(); }
  else if (e.target.dataset.act === 'from' || e.target.dataset.act === 'to') {
    if (st.from > st.to) { if (e.target.dataset.act === 'from') st.to = st.from; else st.from = st.to; }
    renderPanel();
  }
});
function refreshCounts() { // update label totals while typing, without re-rendering the inputs
  let total = 0;
  document.querySelectorAll('#panel tr[data-line]').forEach((tr) => {
    const l = allLines().find((x) => x.id === Number(tr.dataset.line));
    const st = lineState(l);
    const n = st.on ? Math.max(0, st.to - st.from + 1) : 0;
    tr.querySelector('td:last-child b').textContent = n;
    total += n;
  });
  const g = document.querySelector('.sticky-bar .grow b'); if (g) g.textContent = fmtNum(total);
  ['dlpdf', 'print'].forEach((id) => { const b = $(id); if (b) b.disabled = !total; });
}
$('panel').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  if (btn.dataset.act === 'remove') { S.selected.delete(btn.closest('.dateblock').dataset.date); renderCalendar(); renderPanel(); }
  else if (btn.dataset.act === 'printer') {
    try { await choosePrinter(true); renderPanel(); }
    catch (e) { if (e.code === 'NO_QZ') showNoQz(); else if (e.code !== 'CANCELLED') toast(e.message, 'err'); }
  } else if (btn.dataset.act === 'sjall') {
    const dates = [...S.selected].sort(); dates.forEach((d) => (S.sj[d] = S.sj[dates[0]] || '')); renderPanel();
  } else if (btn.id === 'dlpdf') await labelAction('pdf');
  else if (btn.id === 'print') await labelAction('print');
});

function collectItems() {
  const dates = [...S.selected].sort();
  const grouped = byDate(allLines());
  const items = [];
  dates.forEach((date) => (grouped[date] || []).forEach((l) => {
    const st = lineState(l);
    if (st.on && st.to >= st.from) items.push({ line_id: l.id, from: st.from, to: st.to, sj: S.sj[date] || '' });
  }));
  return { dates, items, total: items.reduce((n, i) => n + i.to - i.from + 1, 0) };
}

function refreshPrinterBtn() {
  const b = document.querySelector('[data-act="printer"]');
  if (b) b.textContent = store.get('printer', '') ? 'Printer: ' + store.get('printer', '') : 'Choose printer';
}

function showNoQz() {
  return confirmBox('Direct printing is not available',
    'QZ Tray is not running on this computer. Start QZ Tray (the printer icon near the clock) and try again, or use the browser print window instead. The browser window may not print the label at the exact size.',
    'Use browser print');
}

// kind = 'pdf' (download a file) or 'print' (straight to the printer)
async function labelAction(kind) {
  const { dates, items, total } = collectItems();
  if (!items.length) return;
  if (kind === 'print' && total > 300 &&
      !(await confirmBox(`Print ${fmtNum(total)} labels?`, 'This is a lot of labels. They are sent to the printer in batches, so it can take a few minutes. Printing one or two dates at a time is faster.', 'Print anyway'))) return;

  const btns = ['dlpdf', 'print'].map($).filter(Boolean);
  const saved = btns.map((b) => b.innerHTML);
  const busy = btns.find((b) => b.id === (kind === 'pdf' ? 'dlpdf' : 'print'));
  const spin = '<span class="spin"' + (kind === 'print' ? ' style="border-top-color:#fff"' : '') + '></span> ';
  const restore = () => btns.forEach((b, i) => { b.innerHTML = saved[i]; b.disabled = false; });
  btns.forEach((b) => (b.disabled = true));
  busy.innerHTML = spin + 'Preparing…';
  try {
    // Pick the printer BEFORE anything is logged as downloaded, so cancelling leaves no trace.
    let printer = null;
    if (kind === 'print') {
      try { printer = await choosePrinter(false); refreshPrinterBtn(); }
      catch (e) {
        if (e.code === 'CANCELLED') return restore();
        if (e.code !== 'NO_QZ') throw e;
        if (!(await showNoQz())) return restore();   // no helper: browser print, only if the user agrees
      }
    }
    const data = await api('/api/labels', { method: 'POST', body: { items } });
    await new Promise((r) => setTimeout(r, 30)); // let the button repaint before the heavy work
    const name = `labels_${S.supplier.code}_${dates.length === 1 ? dates[0] : `${dates[0]}_to_${dates[dates.length - 1]}`}`;
    if (kind === 'pdf') {
      buildLabelsPdf(data).save(name + '.pdf');
      toast(`${fmtNum(data.total)} labels downloaded`);
    } else if (printer) {
      await printDirect(data, printer, (n, all) => { busy.innerHTML = `${spin}Printing ${fmtNum(n)} / ${fmtNum(all)}`; });
      toast(`${fmtNum(data.total)} labels sent to ${printer}`);
    } else {
      await printLabels(data, name);
      toast(`${fmtNum(data.total)} labels sent to the print window`);
    }
    dates.forEach((d) => { const c = S.cache[d.slice(0, 7)]; if (c) c.printed.add(d); });
    renderCalendar();
  } catch (e) { toast(e && e.message ? e.message : 'Printing failed', 'err'); }
  restore();
}
