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
    throw new Error('Not logged in');
  }
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function todayLocal() {
  return new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function fmtDate(iso) {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

function fmtDateTime(sqlUtc) {
  return new Date(sqlUtc.replace(' ', 'T') + 'Z').toLocaleString('en-GB');
}

function showMsg(el, text, kind) {
  el.className = 'msg ' + (kind || 'ok');
  el.textContent = text;
  el.hidden = !text;
}

async function logout() {
  try { await api('/api/logout', { method: 'POST', noRedirect: true }); } catch (e) { /* ignore */ }
  location.href = '/';
}
