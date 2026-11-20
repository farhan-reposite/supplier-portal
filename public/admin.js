const A = {
  today: todayLocal(),
  month: store.get('month', '') || todayLocal().slice(0, 7),
  supplierId: Number(store.get('supplier', 0)) || 0,
  months: [], msup: [], lines: [], suppliers: [], users: [],
  view: 'all', q: '', files: [], lastImported: null, scrolled: false,
};
const D = { date: '', focusId: 0, dirty: false };   // receiving drawer state
const TABS = ['schedule', 'import', 'suppliers', 'downloads'];

(async () => {
  const me = await api('/api/me');
  if (me.role !== 'admin') { location.href = '/app'; return; }
  renderTopbar({
    who: `<b>${esc(me.username)}</b>`,
    nav: [
      { id: 'schedule', href: '#schedule', label: 'Schedule & receiving', icon: 'table' },
      { id: 'import', href: '#import', label: 'Import', icon: 'upload' },
      { id: 'suppliers', href: '#suppliers', label: 'Suppliers', icon: 'users' },
      { id: 'downloads', href: '#downloads', label: 'Downloads', icon: 'download', badge: true },
    ],
  });
  $('search-ic').innerHTML = ICON.search; $('search-ic2').innerHTML = ICON.search;
  $('drop-ic').innerHTML = ICON.upload;
  $('add-sup').innerHTML = ICON.plus + ' Add supplier';
  await loadSuppliers();
  window.addEventListener('hashchange', route);
  route();
  refreshPendingBadge();
})();

function route() {
  const tab = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'schedule';
  TABS.forEach((t) => ($('tab-' + t).hidden = t !== tab));
  setNavCurrent(tab);
  closeDrawer(true);
  if (tab === 'schedule') loadSchedule();
  if (tab === 'import') { renderFiles(); loadSuppliers().then(renderFiles).catch(() => {}); }
  if (tab === 'suppliers') renderSuppliers();
  if (tab === 'downloads') loadDownloads();
}
const goto = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };

async function guard(fn) { try { await fn(); } catch (e) { toast(e.message, 'err'); } }

/* ======================================================================
   Suppliers (shared data + tab)
   ====================================================================== */
async function loadSuppliers() {
  const d = await api('/api/admin/suppliers');
  A.suppliers = d.suppliers; A.users = d.users;
}

function renderSuppliers() {
  const q = $('sq').value.trim().toLowerCase();
  const list = A.suppliers.filter((s) => !q || (s.code + ' ' + s.name).toLowerCase().includes(q));
  $('sup-body').innerHTML = list.length ? list.map((s) => {
    const us = A.users.filter((u) => u.supplier_id === s.id);
    const logins = us.length
      ? us.map((u) => `<div>${esc(u.username)} <button class="sm ghost" data-reset="${u.id}" data-user="${esc(u.username)}">${ICON.key} Reset password</button></div>`).join('')
      : '<span class="faint">No login yet</span>';
    return `<tr><td><b>${esc(s.code)}</b></td>
      <td>${esc(s.name)}</td>
      <td>${logins}</td>
      <td><span class="badge ${s.status === 'active' ? 'ok' : 'bad'}">${s.status}</span></td>
      <td style="text-align:right;white-space:nowrap"><button class="sm" data-update="${s.id}">${ICON.pencil} Update supplier</button>
        <button class="sm" data-addlogin="${s.id}">${ICON.userplus} Add login</button>
        <button class="sm ${s.status === 'active' ? 'danger' : ''}" data-toggle="${s.id}" data-status="${s.status}">${s.status === 'active' ? ICON.ban + ' Disable' : ICON.okcircle + ' Enable'}</button>
        <button class="sm danger" data-delete="${s.id}">${ICON.trash} Delete</button></td></tr>`;
  }).join('') : `<tr><td colspan="5"><div class="empty">${ICON.box}<h3>${A.suppliers.length ? 'No match' : 'No suppliers yet'}</h3>
      <p>${A.suppliers.length ? 'Try another search.' : 'Add your suppliers here first. A PO file can only be imported for a supplier that exists.'}</p></div></td></tr>`;
}
$('sq').oninput = debounce(renderSuppliers, 100);

$('add-sup').onclick = () => guard(async () => {
  const v = await dialog({
    title: 'Add supplier', ok: 'Add supplier',
    html: `<div class="field-row"><div><label class="field" for="d-code">Code (printed on labels)</label><input id="d-code" maxlength="20" required placeholder="KW" style="text-transform:uppercase"></div></div>
           <div class="field-row"><div><label class="field" for="d-name">Name</label><input id="d-name" required placeholder="PT Example Supplier"></div></div>`,
    collect: (d) => ({ code: d.querySelector('#d-code').value, name: d.querySelector('#d-name').value }),
  });
  if (!v) return;
  await api('/api/admin/suppliers', { method: 'POST', body: v });
  await loadSuppliers(); renderSuppliers(); toast('Supplier added');
});

$('sup-body').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  guard(async () => {
    if (b.dataset.addlogin) {
      const sup = A.suppliers.find((s) => s.id === Number(b.dataset.addlogin));
      const v = await dialog({
        title: `New login for ${sup.code}`, ok: 'Create login',
        html: `<div class="field-row"><div><label class="field" for="d-user">Username</label><input id="d-user" required autocapitalize="none" placeholder="${esc(sup.code.toLowerCase())}.warehouse"></div></div>
               <div class="field-row"><div><label class="field" for="d-pass">Password (min 8 characters)</label>
               <div style="display:flex;gap:8px"><input id="d-pass" required minlength="8" autocomplete="off" value="${randomPassword()}">
               <button type="button" class="fit" id="d-gen">New</button></div></div></div>
               <p class="small" style="margin-top:10px">Copy the password now. It cannot be shown again.</p>`,
        onOpen: (d) => { d.querySelector('#d-gen').onclick = () => (d.querySelector('#d-pass').value = randomPassword()); },
        collect: (d) => ({ supplier_id: sup.id, username: d.querySelector('#d-user').value, password: d.querySelector('#d-pass').value }),
      });
      if (!v) return;
      await api('/api/admin/users', { method: 'POST', body: v });
      await copyText(`Username: ${v.username.trim().toLowerCase()}\nPassword: ${v.password}`);
      await loadSuppliers(); renderSuppliers(); toast('Login created. Username and password copied');
    } else if (b.dataset.reset) {
      const v = await dialog({
        title: `Reset password for ${b.dataset.user}`, ok: 'Reset password',
        html: `<div class="field-row"><div><label class="field" for="d-pass">New password (min 8 characters)</label>
               <div style="display:flex;gap:8px"><input id="d-pass" required minlength="8" autocomplete="off" value="${randomPassword()}"><button type="button" class="fit" id="d-gen">New</button></div></div></div>
               <p class="small" style="margin-top:10px">The user is logged out. The new password is copied for you.</p>`,
        onOpen: (d) => { d.querySelector('#d-gen').onclick = () => (d.querySelector('#d-pass').value = randomPassword()); },
        collect: (d) => d.querySelector('#d-pass').value,
      });
      if (!v) return;
      await api(`/api/admin/users/${b.dataset.reset}/password`, { method: 'POST', body: { password: v } });
      await copyText(v); toast('Password changed and copied');
    } else if (b.dataset.update) {
      const sup = A.suppliers.find((s) => s.id === Number(b.dataset.update));
      const v = await dialog({
        title: `Update supplier ${sup.code}`, ok: 'Save changes',
        html: `<div class="field-row"><div><label class="field" for="d-code">Code (printed on labels)</label><input id="d-code" maxlength="20" required value="${esc(sup.code)}" style="text-transform:uppercase"></div></div>
               <div class="field-row"><div><label class="field" for="d-name">Name</label><input id="d-name" required value="${esc(sup.name)}"></div></div>
               <p class="small" style="margin-top:10px">If you change the code, new labels and PO file names use the new code. The schedule and logins stay as they are.</p>`,
        collect: (d) => ({ code: d.querySelector('#d-code').value, name: d.querySelector('#d-name').value }),
      });
      if (!v) return;
      await api(`/api/admin/suppliers/${sup.id}/update`, { method: 'POST', body: v });
      await loadSuppliers(); renderSuppliers(); toast('Supplier updated');
    } else if (b.dataset.delete) {
      const sup = A.suppliers.find((s) => s.id === Number(b.dataset.delete));
      const typed = await dialog({
        title: `Delete supplier ${sup.code}?`, ok: 'Delete supplier', danger: true,
        html: `<p>This permanently deletes <b>${esc(sup.name)}</b> with its logins, its whole delivery schedule and its label download history. It cannot be undone.</p>
               <div class="field-row"><div><label class="field" for="d-confirm">Type <b>${esc(sup.code)}</b> to confirm</label><input id="d-confirm" autocomplete="off" autocapitalize="characters" spellcheck="false"></div></div>`,
        collect: (d) => d.querySelector('#d-confirm').value.trim().toUpperCase(),
      });
      if (typed === null) return;
      if (typed !== sup.code) { toast('Code did not match. Nothing was deleted', 'err'); return; }
      await api(`/api/admin/suppliers/${sup.id}`, { method: 'DELETE' });
      if (A.supplierId === sup.id) { A.supplierId = 0; store.set('supplier', 0); }
      await loadSuppliers(); renderSuppliers(); refreshPendingBadge(); toast(`Supplier ${sup.code} deleted`);
    } else if (b.dataset.toggle) {
      const disabling = b.dataset.status === 'active';
      if (disabling && !(await confirmBox('Disable this supplier?', 'Their users will not be able to log in until you enable them again.', 'Disable', true))) return;
      await api(`/api/admin/suppliers/${b.dataset.toggle}/status`, { method: 'POST', body: { status: disabling ? 'disabled' : 'active' } });
      await loadSuppliers(); renderSuppliers();
    }
  });
});

/* ======================================================================
   Schedule & receiving
   ====================================================================== */
async function loadSchedule() {
  A.scrolled = false;
  renderMonthBar();
  $('chips').innerHTML = '<div class="skeleton" style="height:48px;width:260px"></div>';
  await guard(async () => {
    const d = await api('/api/admin/month-suppliers?month=' + A.month);
    A.msup = d.suppliers; A.months = d.months; A.today = d.today;
    if (!A.msup.some((s) => s.id === A.supplierId)) A.supplierId = A.msup[0] ? A.msup[0].id : 0;
    renderMonthBar(); renderChips();
    await loadMatrix();
  });
}

function renderMonthBar() {
  $('month-bar').innerHTML = `
    <button class="icon" id="m-prev" aria-label="Previous month">${ICON.left}</button>
    <input type="month" id="m-input" value="${A.month}" style="width:170px" aria-label="Month">
    <button class="icon" id="m-next" aria-label="Next month">${ICON.right}</button>
    <button id="m-today">${ICON.calendar} This month</button>`;
  $('m-prev').onclick = () => setMonth(monthAdd(A.month, -1));
  $('m-next').onclick = () => setMonth(monthAdd(A.month, 1));
  $('m-today').onclick = () => setMonth(todayLocal().slice(0, 7));
  $('m-input').onchange = (e) => e.target.value && setMonth(e.target.value);
}
function setMonth(m) { A.month = m; A.scrolled = false; store.set('month', m); loadSchedule(); }

function renderChips() {
  if (!A.msup.length) { $('chips').innerHTML = ''; return; }
  $('chips').innerHTML = A.msup.map((s) => {
    const dot = s.overdue_lines ? '<i class="dot bad"></i>' : (s.short_qty ? '<i class="dot"></i>' : '');
    const tip = [s.overdue_lines ? `${s.overdue_lines} overdue` : '', s.short_qty ? `${fmtNum(s.short_qty)} pcs short` : ''].filter(Boolean).join(' · ');
    return `<button class="chip" data-sup="${s.id}" aria-pressed="${s.id === A.supplierId}" title="${esc(s.name)}${tip ? ' — ' + tip : ''}">
      <b>${esc(s.code)}</b><small>${fmtNum(s.boxes)} boxes</small>${dot}</button>`;
  }).join('');
}
$('chips').addEventListener('click', (e) => {
  const b = e.target.closest('[data-sup]'); if (!b) return;
  A.supplierId = Number(b.dataset.sup); A.scrolled = false; store.set('supplier', A.supplierId);
  renderChips(); guard(loadMatrix);
});

async function loadMatrix() {
  if (!A.supplierId) {
    A.lines = [];
    $('matrix-card').hidden = true;
    $('chips').innerHTML = `<div class="card empty" style="width:100%">${ICON.table}<h3>No schedule for ${esc(fmtMonth(A.month))}</h3>
      <p>${!A.suppliers.length ? 'Add a supplier first, then import its PO file.' : (A.months.length ? 'Pick another month above, or import the PO files for this month.' : 'Import your first PO file to get started.')}</p>
      <button class="primary" onclick="goto('${A.suppliers.length ? '#import' : '#suppliers'}')">${A.suppliers.length ? 'Import PO files' : 'Add a supplier'}</button></div>`;
    return;
  }
  const d = await api(`/api/admin/matrix?month=${A.month}&supplier_id=${A.supplierId}`);
  A.lines = d.lines;
  renderSubtitle(); renderMatrix();
}

function renderSubtitle() {
  const sup = A.msup.find((s) => s.id === A.supplierId);
  const pos = [...new Set(A.lines.map((l) => l.po_no))];
  $('sched-sub').innerHTML = `${esc(sup ? sup.name : '')} · PO ${pos.map(esc).join(', ')}`;
}

function groups() {
  const map = new Map();
  for (const l of A.lines) {
    const key = l.po_no + '\u0000' + l.part_no;
    let g = map.get(key);
    if (!g) { g = { po: l.po_no, part: l.part_no, name: l.part_name, lot: l.qty_per_box, days: {}, total: 0, recv: 0, open: false, short: false }; map.set(key, g); }
    g.days[l.delivery_date] = l;
    g.total += l.qty_total;
    if (l.status !== 'scheduled') g.recv += l.qty_received; else g.open = true;
    if (l.status === 'shortage') g.short = true;
  }
  const q = A.q.trim().toLowerCase();
  return [...map.values()].filter((g) =>
    (!q || (g.part + ' ' + g.name + ' ' + g.po).toLowerCase().includes(q)) &&
    (A.view === 'all' || (A.view === 'open' && g.open) || (A.view === 'short' && g.short)));
}

function renderMatrix() {
  $('matrix-card').hidden = false;
  const G = groups(), n = daysIn(A.month);
  const pos = [...new Set(G.map((g) => g.po))];
  const dates = Array.from({ length: n }, (_, i) => `${A.month}-${String(i + 1).padStart(2, '0')}`);
  const dowOf = dates.map(dowMon);
  const colCount = 4 + n + 2;
  let head = '<tr><th class="c-no">No</th><th class="c-part" style="text-align:left">Part No</th><th class="c-name" style="text-align:left">Part name</th><th class="c-lot">Lot</th>';
  dates.forEach((d, i) => {
    head += `<th class="dayh ${dowOf[i] > 4 ? 'we' : ''} ${d === A.today ? 'tod' : ''}" data-date="${d}" title="Receive deliveries for ${esc(fmtDate(d))}">${i + 1}<small>${'MTWTFSS'[dowOf[i]]}</small></th>`;
  });
  head += '<th class="c-tot">Total</th><th class="c-rec">Received</th></tr>';

  const boxes = new Array(n).fill(0);
  let body = '', lastPo = null, idx = 0;
  if (!G.length) body = `<tr><td colspan="${colCount}" style="height:120px;text-align:center;color:var(--muted)">Nothing matches this filter.</td></tr>`;
  for (const g of G) {
    if (pos.length > 1 && g.po !== lastPo) { body += `<tr class="po-row"><td colspan="${colCount}">PO ${esc(g.po)}</td></tr>`; lastPo = g.po; }
    idx++;
    let cells = '';
    dates.forEach((d, i) => {
      const l = g.days[d];
      const base = (dowOf[i] > 4 ? 'we ' : '') + (d === A.today ? 'tod ' : '');
      if (!l) { cells += `<td class="day ${base}"></td>`; return; }
      boxes[i] += l.boxes;
      const late = l.status === 'scheduled' && d < A.today;
      const tip = `${g.part} · ${fmtDate(d)}\nScheduled ${fmtNum(l.qty_total)} pcs (${l.boxes} box${l.boxes > 1 ? 'es' : ''})` +
        (l.status === 'scheduled' ? (late ? '\nNot received yet' : '') : `\nReceived ${fmtNum(l.qty_received)}` + (l.status === 'shortage' ? ` · short ${fmtNum(l.qty_total - l.qty_received)}` : ''));
      cells += `<td class="day has ${base}${l.status === 'scheduled' ? '' : l.status} ${late ? 'late' : ''}" data-date="${d}" data-id="${l.id}" title="${esc(tip)}">${l.qty_total}</td>`;
    });
    const short = g.recv && g.recv < g.total && !g.open;
    body += `<tr><td class="c-no">${idx}</td><td class="c-part" title="${esc(g.part)}">${esc(g.part)}</td><td class="c-name" title="${esc(g.name)}">${esc(g.name)}</td>
      <td class="c-lot">${fmtNum(g.lot)}</td>${cells}<td class="c-tot">${fmtNum(g.total)}</td><td class="c-rec ${short ? 'short' : ''}">${g.recv ? fmtNum(g.recv) : ''}</td></tr>`;
  }
  const foot = `<tr><td class="c-label" colspan="4">Boxes per day</td>${boxes.map((b, i) => `<td class="${dowOf[i] > 4 ? 'we' : ''}">${b || ''}</td>`).join('')}<td></td><td></td></tr>`;
  $('matrix').innerHTML = `<table class="matrix"><thead>${head}</thead><tbody>${body}</tbody><tfoot>${foot}</tfoot></table>`;

  if (!A.scrolled && A.month === todayLocal().slice(0, 7)) {
    A.scrolled = true;
    const t = $('matrix').querySelector('th.tod');
    if (t) $('matrix').scrollLeft = Math.max(0, t.offsetLeft - 520);
  }
}

$('matrix').addEventListener('click', (e) => {
  const cell = e.target.closest('td.has'), head = e.target.closest('th.dayh');
  if (cell) openDay(cell.dataset.date, Number(cell.dataset.id));
  else if (head) openDay(head.dataset.date, 0);
});
document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
  A.view = b.dataset.view;
  document.querySelectorAll('[data-view]').forEach((x) => x.setAttribute('aria-pressed', x === b));
  renderMatrix();
}));
$('q').oninput = debounce((e) => { A.q = e.target.value; renderMatrix(); }, 120);

$('export').onclick = () => {
  const G = groups(), n = daysIn(A.month);
  const hdr = ['PO', 'Part No', 'Part name', 'Lot', ...Array.from({ length: n }, (_, i) => i + 1), 'Total', 'Received'];
  const mk = (pick) => [hdr, ...G.map((g) => [g.po, g.part, g.name, g.lot,
    ...Array.from({ length: n }, (_, i) => { const l = g.days[`${A.month}-${String(i + 1).padStart(2, '0')}`]; return l ? pick(l) : ''; }),
    g.total, g.recv || ''])];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(mk((l) => l.qty_total)), 'Scheduled');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(mk((l) => (l.status === 'scheduled' ? '' : l.qty_received))), 'Received');
  const sup = A.msup.find((s) => s.id === A.supplierId);
  XLSX.writeFile(wb, `${sup ? sup.code : 'schedule'}_${A.month}.xlsx`);
};

$('remove').onclick = () => guard(async () => {
  const sup = A.msup.find((s) => s.id === A.supplierId);
  if (!(await confirmBox(`Remove ${sup.code} · ${fmtMonth(A.month)}?`,
    'This deletes every delivery in this month that has not been received. Lines already marked received or short are kept.', 'Remove', true))) return;
  const r = await api('/api/admin/schedule/remove', { method: 'POST', body: { month: A.month, supplier_id: A.supplierId } });
  toast(`${r.removed} lines removed`); await loadSchedule();
});

/* ---------- receiving drawer ---------- */
function deliveryDates() { return [...new Set(A.lines.map((l) => l.delivery_date))].sort(); }

function openDay(date, focusId) {
  D.date = date; D.focusId = focusId; D.dirty = false;
  const dr = $('drawer'), sc = $('scrim');
  dr.hidden = false; sc.hidden = false;
  renderDrawer();
  requestAnimationFrame(() => { dr.classList.add('open'); sc.classList.add('open'); });
  const f = dr.querySelector('.rrow.focus input') || dr.querySelector('input.qty');
  setTimeout(() => f && f.focus(), 200);
}

function closeDrawer(instant) {
  const dr = $('drawer'), sc = $('scrim');
  if (dr.hidden) return;
  dr.classList.remove('open'); sc.classList.remove('open');
  const done = () => { dr.hidden = true; sc.hidden = true; dr.innerHTML = ''; };
  if (instant) done(); else setTimeout(done, 200);
}
async function tryClose() {
  if (D.dirty && !(await confirmBox('Discard changes?', 'You have unsaved received quantities.', 'Discard', true))) return;
  closeDrawer();
}
$('scrim').onclick = tryClose;

function rowStatus(total, val) {
  if (val === '' || val == null) return ['scheduled', 'Not received'];
  const q = Number(val);
  if (!Number.isInteger(q) || q < 0) return ['bad', 'Invalid'];
  return q >= total ? ['received', 'Received'] : ['shortage', `Short ${fmtNum(total - q)}`];
}

function renderDrawer() {
  const lines = A.lines.filter((l) => l.delivery_date === D.date);
  const dates = deliveryDates(), i = dates.indexOf(D.date);
  const sup = A.msup.find((s) => s.id === A.supplierId);
  const multiPo = new Set(lines.map((l) => l.po_no)).size > 1;
  const boxes = lines.reduce((n, l) => n + l.boxes, 0);
  $('drawer').innerHTML = `
    <div class="drawer-head">
      <button class="icon sm ghost" id="d-prev" aria-label="Previous delivery date" ${i > 0 ? '' : 'disabled'}>${ICON.left}</button>
      <div class="t"><h2>${esc(fmtDate(D.date, true))}</h2><div class="muted small">${esc(sup ? sup.code : '')} · ${lines.length} part${lines.length === 1 ? '' : 's'} · ${fmtNum(boxes)} boxes</div></div>
      <button class="icon sm ghost" id="d-next" aria-label="Next delivery date" ${i < dates.length - 1 ? '' : 'disabled'}>${ICON.right}</button>
      <button class="icon sm ghost" id="d-close" aria-label="Close">${ICON.close}</button>
    </div>
    <div class="drawer-body">${lines.length ? lines.map((l) => {
      const val = l.status === 'scheduled' ? '' : l.qty_received;
      const [cls, txt] = rowStatus(l.qty_total, val);
      return `<div class="rrow ${l.id === D.focusId ? 'focus' : ''}" data-id="${l.id}" data-total="${l.qty_total}" data-orig="${val}">
        <div><div class="p">${esc(l.part_no)}</div><div class="n">${esc(l.part_name)}${multiPo ? ' · ' + esc(l.po_no) : ''}</div></div>
        <div class="sched" style="text-align:right"><b style="color:var(--ink)">${fmtNum(l.qty_total)}</b> pcs<br>${l.boxes} box${l.boxes > 1 ? 'es' : ''}</div>
        <div class="ctl"><label class="sr-only" for="r${l.id}">Received qty for ${esc(l.part_no)}</label>
          <input class="qty" id="r${l.id}" type="number" min="0" inputmode="numeric" placeholder="Received" value="${val}" style="width:112px">
          <button class="sm" data-full title="Received in full">${ICON.check} Full</button>
          <button class="sm ghost" data-clear title="Clear">${ICON.close} Clear</button>
          <span class="badge ${cls}">${esc(txt)}</span></div></div>`;
    }).join('') : '<div class="empty">No deliveries on this date.</div>'}</div>
    <div class="drawer-foot">
      <button id="d-all">${ICON.checkall} Mark all received in full</button>
      <span class="grow"></span>
      <button id="d-cancel" class="ghost">Close</button>
      <button id="d-save" class="primary" disabled>${ICON.save} Save changes</button>
    </div>`;
  $('d-close').onclick = $('d-cancel').onclick = tryClose;
  $('d-prev').onclick = () => moveDay(-1); $('d-next').onclick = () => moveDay(1);
  $('d-all').onclick = () => { document.querySelectorAll('.rrow').forEach((r) => { r.querySelector('input').value = r.dataset.total; }); updateDrawerState(); };
  $('d-save').onclick = saveDrawer;
}
async function moveDay(dir) {
  if (D.dirty && !(await confirmBox('Discard changes?', 'You have unsaved received quantities.', 'Discard', true))) return;
  const dates = deliveryDates(), j = dates.indexOf(D.date) + dir;
  if (dates[j]) { D.date = dates[j]; D.focusId = 0; D.dirty = false; renderDrawer(); }
}
function updateDrawerState() {
  let dirty = false, bad = false;
  document.querySelectorAll('.rrow').forEach((r) => {
    const v = r.querySelector('input').value;
    const [cls, txt] = rowStatus(Number(r.dataset.total), v);
    const b = r.querySelector('.badge'); b.className = 'badge ' + cls; b.textContent = txt;
    if (cls === 'bad') bad = true;
    if (v !== r.dataset.orig) dirty = true;
  });
  D.dirty = dirty;
  const s = $('d-save'); if (s) s.disabled = !dirty || bad;
}
$('drawer').addEventListener('input', (e) => { if (e.target.matches('input.qty')) updateDrawerState(); });
$('drawer').addEventListener('click', (e) => {
  const r = e.target.closest('.rrow'); if (!r) return;
  if (e.target.closest('[data-full]')) { r.querySelector('input').value = r.dataset.total; updateDrawerState(); }
  if (e.target.closest('[data-clear]')) { r.querySelector('input').value = ''; updateDrawerState(); }
});
$('drawer').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !e.target.matches('input.qty')) return;
  e.preventDefault();
  const inputs = [...document.querySelectorAll('.rrow input.qty')];
  const next = inputs[inputs.indexOf(e.target) + 1];
  if (next) { next.focus(); next.select(); } else if (!$('d-save').disabled) saveDrawer();
});

async function saveDrawer() {
  const items = [];
  document.querySelectorAll('.rrow').forEach((r) => {
    const v = r.querySelector('input').value;
    if (v !== r.dataset.orig) items.push({ id: Number(r.dataset.id), qty_received: v === '' ? null : Number(v) });
  });
  if (!items.length) return;
  const btn = $('d-save'); btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Saving…';
  try {
    const r = await api('/api/admin/lines/receive', { method: 'POST', body: { items } });
    r.lines.forEach((u) => { const l = A.lines.find((x) => x.id === u.id); if (l) { l.qty_received = u.qty_received; l.status = u.status; } });
    D.dirty = false;
    toast(`${items.length} line${items.length > 1 ? 's' : ''} saved`);
    renderMatrix(); renderDrawer();
    api('/api/admin/month-suppliers?month=' + A.month).then((d) => { A.msup = d.suppliers; renderChips(); });
  } catch (e) { toast(e.message, 'err'); btn.disabled = false; btn.innerHTML = ICON.save + ' Save changes'; }
}

document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
  if (e.key === 'Escape' && !$('drawer').hidden && !document.querySelector('dialog[open]')) { tryClose(); return; }
  if (typing || e.ctrlKey || e.metaKey || e.altKey || document.querySelector('dialog[open]')) return;
  if (location.hash.slice(1) && location.hash.slice(1) !== 'schedule') return;
  if (e.key === '/') { e.preventDefault(); $('q').focus(); }
  if (e.key === '[') setMonth(monthAdd(A.month, -1));
  if (e.key === ']') setMonth(monthAdd(A.month, 1));
});

/* ======================================================================
   Import (many files at once)
   ====================================================================== */
const drop = $('drop');
drop.onclick = () => $('file').click();
drop.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); } };
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
$('file').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };

async function addFiles(fileList) {
  const picked = Array.from(fileList);     // copy first: the input is cleared right after this call
  await loadSuppliers().catch(() => {});   // make sure the supplier list is current
  for (const f of picked) {
    if (!/\.xlsx?$/i.test(f.name)) { toast(`${f.name} is not an Excel file`, 'err'); continue; }
    const item = { id: Math.random().toString(36).slice(2), name: f.name, state: 'ready', result: null };
    try {
      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
      item.parsed = parsePoWorkbook(f.name, wb, XLSX);
    } catch (e) {
      item.parsed = { fileName: f.name, errors: ['Could not read this file. Is it a valid .xlsx?'], warnings: [], rows: [] };
    }
    A.files.push(item);
  }
  checkDuplicates(); renderFiles();
}

function checkDuplicates() {
  const seen = new Map();
  A.files.forEach((f) => { f.dup = ''; });
  A.files.forEach((f) => {
    const p = f.parsed;
    if (!p || p.errors.length || f.state === 'done') return;
    const key = `${p.supplierCode}|${p.month}|${p.po}`;
    if (seen.has(key)) f.dup = `Same supplier, month and PO as ${seen.get(key)}`;
    else seen.set(key, f.name);
  });
}
const knownCodes = () => new Set(A.suppliers.map((s) => s.code));
const unknownSupplier = (f) => !!(f.parsed && f.parsed.supplierCode && !knownCodes().has(f.parsed.supplierCode));
const fileOk = (f) => f.state === 'ready' && f.parsed && !f.parsed.errors.length && !f.dup && !unknownSupplier(f);

function renderFiles() {
  const box = $('files');
  box.hidden = !A.files.length; $('import-actions').hidden = !A.files.length;
  if (!A.files.length) return;
  box.innerHTML = A.files.map((f) => {
    const p = f.parsed;
    const sup = A.suppliers.find((x) => x.code === p.supplierCode);
    const errs = [...p.errors];
    if (!sup && p.supplierCode && f.state !== 'done') {
      errs.unshift(`Supplier "${p.supplierCode}" is not registered. Add it in the Suppliers tab, or rename the file so it starts with an existing supplier code.`);
    }
    if (f.dup) errs.push(f.dup);
    let right = `<button class="sm ghost" data-rm="${f.id}" aria-label="Remove file">${ICON.close}</button>`;
    let notes = errs.slice(0, 6).map((e) => `<div class="e">${esc(e)}</div>`).join('') + (errs.length > 6 ? `<div class="e">…and ${errs.length - 6} more problems</div>` : '');
    if (!errs.length) notes += p.warnings.map((w) => `<div class="w">${esc(w)}</div>`).join('');
    if (f.state === 'working') right = '<span class="spin"></span>';
    if (f.state === 'done') { right = '<span class="badge ok">Imported</span>'; notes = `<div class="o">${fmtNum(f.result.lines)} deliveries · ${fmtNum(f.result.boxes)} boxes saved</div>`; }
    if (f.state === 'failed') notes = `<div class="e">${esc(f.error)}</div>`;
    return `<div class="fcard"><div>
      <div class="fname">${ICON.file.replace('<svg', '<svg width="16" height="16" style="vertical-align:-3px;margin-right:6px;color:var(--faint)"')}${esc(f.name)}</div>
      ${p.month && !p.errors.length ? `<div class="meta"><span>Supplier <b>${esc(p.supplierCode)}</b></span>
        ${sup ? `<span>${esc(sup.name)}</span>` : ''}<span>PO <b>${esc(p.po)}</b></span><span><b>${esc(fmtMonth(p.month))}</b></span>
        <span><b>${p.parts}</b> parts</span><span><b>${fmtNum(p.cells)}</b> deliveries</span><span><b>${fmtNum(p.boxes)}</b> boxes</span></div>` : ''}
      </div><div>${right}</div><div class="notes">${notes}</div></div>`;
  }).join('');
  const n = A.files.filter(fileOk).length;
  const working = A.files.some((f) => f.state === 'working');
  $('go').disabled = !n || working;
  $('go').innerHTML = working ? '<span class="spin" style="border-top-color:#fff"></span> Importing…' : (n ? `${ICON.upload} Import ${n} file${n > 1 ? 's' : ''}` : 'Nothing to import');
}
$('files').addEventListener('click', (e) => {
  const b = e.target.closest('[data-rm]'); if (!b) return;
  A.files = A.files.filter((f) => f.id !== b.dataset.rm); checkDuplicates(); renderFiles();
});
$('clearfiles').onclick = () => { A.files = []; renderFiles(); };

$('go').onclick = async () => {
  const todo = A.files.filter(fileOk);
  let ok = 0, bad = 0;
  for (const f of todo) {
    f.state = 'working'; renderFiles();
    try {
      const p = f.parsed;
      f.result = await api('/api/admin/schedule/import', { method: 'POST',
        body: { supplier_code: p.supplierCode, month: p.month, po_no: p.po, rows: p.rows } });
      f.state = 'done'; ok++; A.lastImported = { supplierId: f.result.supplier_id, month: p.month };
    } catch (e) { f.state = 'failed'; f.error = e.message; bad++; }
    renderFiles();
  }
  await loadSuppliers();
  renderFiles();
  if (ok) {
    toast(`${ok} file${ok > 1 ? 's' : ''} imported${bad ? `, ${bad} failed` : ''}`, bad ? 'err' : 'ok');
    if (!bad && A.lastImported) {
      A.month = A.lastImported.month; A.supplierId = A.lastImported.supplierId; A.scrolled = false;
      store.set('month', A.month); store.set('supplier', A.supplierId);
      $('go').insertAdjacentHTML('afterend', ' <button class="primary" id="view-sched">${ICON.table} View schedule</button>');
      $('view-sched').onclick = () => { A.files = []; goto('#schedule'); };
    }
  }
};

$('tpl').onclick = () => guard(async () => {
  if (!A.suppliers.length) { toast('Add a supplier first, then download its template', 'err'); return; }
  const code = await dialog({
    title: 'Download template', ok: 'Download',
    html: `<p>The file name starts with the supplier code, so the import knows who it is for.</p>
      <div class="field-row"><div><label class="field" for="d-code">Supplier</label>
      <select id="d-code">${A.suppliers.map((s) => `<option value="${esc(s.code)}">${esc(s.code)} · ${esc(s.name)}</option>`).join('')}</select></div></div>`,
    collect: (d) => d.querySelector('#d-code').value,
  });
  if (!code) return;
  const res = await fetch('/po_template.xlsx');
  if (!res.ok) throw new Error('Template not found');
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a'); a.href = url; a.download = `${code}_po.xlsx`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
});

/* ======================================================================
   Downloads
   ====================================================================== */
async function refreshPendingBadge() {
  try {
    const d = await api('/api/admin/downloads');
    const el = $('nav-downloads');
    if (el) { el.textContent = d.pending.length; el.hidden = !d.pending.length; }
  } catch (e) { /* ignore */ }
}
async function loadDownloads() {
  $('dl-sup').innerHTML = '<option value="">All suppliers</option>' + A.suppliers.map((s) => `<option value="${s.id}">${esc(s.code)} · ${esc(s.name)}</option>`).join('');
  $('dl-sup').value = A.dlSup || '';
  await guard(async () => {
    const d = await api('/api/admin/downloads' + (A.dlSup ? '?supplier_id=' + A.dlSup : ''));
    const pend = d.pending.filter((p) => !A.dlSup || A.suppliers.find((s) => s.id === Number(A.dlSup) && s.code === p.supplier_code));
    $('pending-card').hidden = !pend.length;
    $('pending-body').innerHTML = pend.map((p) => {
      const dt = dateObj(p.delivery_date);
      const when = p.delivery_date === d.today ? 'today' : (p.delivery_date < d.today ? 'late' : '');
      return `<div class="tile ${when}" title="${esc(fmtDate(p.delivery_date, true))} · ${esc(p.supplier_code)} · ${fmtNum(p.boxes)} boxes">
        <span class="qr">${ICON.qr}</span>
        <span class="dow">${dt.toLocaleDateString('en-GB', { weekday: 'short' })}</span>
        <span class="day">${dt.getDate()}</span>
        <span class="mon">${dt.toLocaleDateString('en-GB', { month: 'short' })}</span>
        <b class="sup">${esc(p.supplier_code)}</b>
        <span class="bx">${fmtNum(p.boxes)} box${Number(p.boxes) === 1 ? '' : 'es'}</span>
        ${when === 'today' ? '<i class="flag">Today</i>' : ''}</div>`;
    }).join('');
    $('dl-body').innerHTML = d.downloads.length ? d.downloads.map((r) =>
      `<tr><td>${esc(fmtDateTime(r.downloaded_at))}</td><td><b>${esc(r.supplier_code)}</b></td><td>${esc(r.username)}</td><td>${esc(fmtDate(r.delivery_date))}</td><td>${esc(r.sj_no || '–')}</td><td class="num">${fmtNum(r.labels_count)}</td></tr>`).join('')
      : `<tr><td colspan="6"><div class="empty">${ICON.download}<h3>No downloads yet</h3><p>When a supplier downloads labels, it shows up here.</p></div></td></tr>`;
    const el = $('nav-downloads'); if (el && !A.dlSup) { el.textContent = d.pending.length; el.hidden = !d.pending.length; }
  });
}
$('dl-sup').onchange = (e) => { A.dlSup = e.target.value; loadDownloads(); };
