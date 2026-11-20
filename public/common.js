/* ---------- API ---------- */
async function api(path, opts = {}) {
  const method = opts.method || 'GET';
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : (method !== 'GET' ? '{}' : undefined),
    credentials: 'same-origin',
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* empty body */ }
  if (res.status === 401 && !opts.noRedirect) {
    location.href = '/';
    throw new Error('Please log in again');
  }
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

/* ---------- small helpers ---------- */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
const $ = (id) => document.getElementById(id);
const fmtNum = (n) => Number(n || 0).toLocaleString('en-US');
function debounce(fn, ms = 150) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

const store = {
  get(k, d) { try { const v = localStorage.getItem('sp.' + k); return v == null ? d : v; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('sp.' + k, v); } catch (e) { /* private mode */ } },
};

/* ---------- dates ---------- */
function todayLocal() { return new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
function dateObj(iso) { return new Date(iso + 'T00:00:00'); }
function fmtDate(iso, long) {
  return dateObj(iso).toLocaleDateString('en-GB', long
    ? { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }
    : { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}
function fmtMonth(m, short) { return dateObj(m + '-01').toLocaleDateString('en-GB', { month: short ? 'short' : 'long', year: 'numeric' }); }
function monthAdd(m, delta) {
  const d = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7) - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}
function daysIn(m) { return new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).getUTCDate(); }
function dowMon(iso) { return (dateObj(iso).getDay() + 6) % 7; } // 0 = Monday
function fmtDateTime(sqlUtc) { return new Date(sqlUtc.replace(' ', 'T') + 'Z').toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }); }

/* ---------- icons (inline, no network) ---------- */
const ICON = {
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  left: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>',
  right: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 20h14"/></svg>',
  upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V5m0 0L8 9m4-4 4 4M5 19h14"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  table: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 4v16"/></svg>',
  box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8 12 3 3 8l9 5 9-5ZM3 8v8l9 5 9-5V8M12 13v8"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"/><path d="M14 3v5h5"/></svg>',
};
// small stroke icons, all 24x24
[
  ['print', '<path d="M7 9V4h10v5M7 17H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2M7 14h10v6H7z"/>'],
  ['calendar', '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>'],
  ['userplus', '<circle cx="9.5" cy="8" r="3.5"/><path d="M3 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6M19 8v6M16 11h6"/>'],
  ['users', '<circle cx="9" cy="8" r="3.2"/><path d="M3 19c0-3.2 2.7-5.2 6-5.2s6 2 6 5.2M16 5.2a3.2 3.2 0 0 1 0 5.6M18 14c2 .6 3 2.2 3 4.5"/>'],
  ['key', '<circle cx="8" cy="15.5" r="3.5"/><path d="M10.5 13 20 3.5M16 7.5l3 3"/>'],
  ['pencil', '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4zM13.5 6.5l4 4"/>'],
  ['trash', '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'],
  ['ban', '<circle cx="12" cy="12" r="8.5"/><path d="M6 6l12 12"/>'],
  ['okcircle', '<circle cx="12" cy="12" r="8.5"/><path d="m8 12.5 3 3 5-6"/>'],
  ['logout', '<path d="M9 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4M16 8l4 4-4 4M20 12H9"/>'],
  ['login', '<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 8l4 4-4 4M14 12H3"/>'],
  ['save', '<path d="M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6"/>'],
  ['checkall', '<path d="m3 12.5 4 4L15 8M11 16.5l1.5 1.5L21 8"/>'],
  ['arrow', '<path d="M5 12h14m-5-5 5 5-5 5"/>'],
  ['eye', '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.8"/>'],
  ['eyeoff', '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12zM3 3l18 18"/><circle cx="12" cy="12" r="2.8"/>'],
  ['sheet', '<rect x="4" y="3.5" width="16" height="17" rx="2"/><path d="M4 9.5h16M4 15h16M10 9.5v11"/>'],
  ['qr', '<rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1"/><rect x="14" y="3.5" width="6.5" height="6.5" rx="1"/><rect x="3.5" y="14" width="6.5" height="6.5" rx="1"/><path d="M14 14h3v3h-3zM20.5 14v.01M17 20.5h3.5V18"/>'],
  ['filedown','<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5zM14 3v5h5M12 11v6m0 0-2.5-2.5M12 17l2.5-2.5"/>'],
].forEach(([name, body]) => {
  ICON[name] = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
});
// <button data-icon="print">Print</button>  ->  icon + label
function applyIcons(root) {
  (root || document).querySelectorAll('[data-icon]:not([data-icon-done])').forEach((el) => {
    if (ICON[el.dataset.icon]) { el.insertAdjacentHTML('afterbegin', ICON[el.dataset.icon]); el.dataset.iconDone = '1'; }
  });
}

/* ---------- layout shell (top bar) ---------- */
function renderTopbar(opts) {
  const nav = (opts.nav || []).map((n) =>
    `<a href="${n.href}" data-nav="${n.id}">${n.icon ? ICON[n.icon] : ''}${esc(n.label)}${n.badge ? `<span class="count" id="nav-${n.id}"></span>` : ''}</a>`).join('');
  $('topbar').className = 'topbar';
  $('topbar').innerHTML = `
    <a class="brand" href="/" aria-label="Home">
      <img src="/logo.png" alt="Company logo" onerror="this.parentNode.classList.add('no-logo')">
      <span class="wordmark">Supplier Portal</span>
    </a>
    <nav class="nav" aria-label="Main">${nav}</nav>
    <span class="spacer"></span>
    <div class="user"><span>${opts.who || ''}</span><button class="sm" id="logout-btn">${ICON.logout} Log out</button></div>`;
  $('logout-btn').onclick = async () => {
    try { await api('/api/logout', { method: 'POST', noRedirect: true }); } catch (e) { /* ignore */ }
    location.href = '/';
  };
}
function setNavCurrent(id) {
  document.querySelectorAll('.nav a').forEach((a) => {
    if (a.dataset.nav === id) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
}

/* ---------- toasts ---------- */
function toast(text, kind) {
  let box = $('toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; box.className = 'toasts'; box.setAttribute('aria-live', 'polite'); document.body.appendChild(box); }
  const t = document.createElement('div');
  t.className = 'toast ' + (kind || 'ok');
  t.innerHTML = (kind === 'err' ? '' : ICON.check.replace('<svg', '<svg width="16" height="16"')) + `<span>${esc(text)}</span>`;
  box.appendChild(t);
  setTimeout(() => t.remove(), kind === 'err' ? 6000 : 3200);
}

/* ---------- dialogs (replace prompt/confirm) ---------- */
function dialog({ title, html = '', ok = 'OK', cancel = 'Cancel', danger = false, collect, onOpen }) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'dlg';
    d.innerHTML = `<form method="dialog"><h2>${esc(title)}</h2><div class="dlg-body">${html}</div>
      <div class="dlg-actions">${cancel ? `<button value="cancel" formnovalidate>${esc(cancel)}</button>` : ''}
      <button value="ok" class="${danger ? 'danger-solid' : 'primary'}">${esc(ok)}</button></div></form>`;
    document.body.appendChild(d);
    d.addEventListener('close', () => {
      const accepted = d.returnValue === 'ok';
      const val = accepted ? (collect ? collect(d) : true) : (collect ? null : false);
      d.remove();
      resolve(val);
    });
    d.showModal();
    if (onOpen) onOpen(d);
    const first = d.querySelector('input, select');
    if (first) first.focus();
  });
}
const confirmBox = (title, message, ok = 'Confirm', danger = false) =>
  dialog({ title, html: `<p>${esc(message)}</p>`, ok, danger });

function randomPassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const a = crypto.getRandomValues(new Uint32Array(10));
  return [...a].map((n) => chars[n % chars.length]).join('');
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) { return false; }
}

applyIcons();
