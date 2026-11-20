import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';

const app = new Hono();

const SESSION_DAYS = 7;
const PBKDF2_ITERATIONS = 100000; // Workers cap PBKDF2 at 100k; keep in sync with scripts/make-admin.mjs
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const TZ_HOURS = 7; // WIB (East Java). Used for "today" on the server.

const todayLocal = () => new Date(Date.now() + TZ_HOURS * 3600000).toISOString().slice(0, 10);
function monthRange(m) {
  const [y, mo] = m.split('-').map(Number);
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return [`${m}-01`, `${m}-${String(last).padStart(2, '0')}`];
}
const LINE_COLS = 'id, delivery_date, po_no, part_no, part_name, qty_per_box, boxes, qty_total, qty_received, status, row_no';

/* ---------- crypto helpers ---------- */

const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => Uint8Array.from(hex.match(/.{2}/g).map((h) => parseInt(h, 16)));

async function pbkdf2(password, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' }, key, 256);
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `${toHex(salt)}:${toHex(await pbkdf2(password, salt))}`;
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored).split(':');
  if (!saltHex || !hashHex) return false;
  return safeEqual(toHex(await pbkdf2(password, fromHex(saltHex))), hashHex);
}

async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

/* ---------- middleware ---------- */

// Every state-changing request must be JSON (blocks cross-site form posts).
app.use('/api/*', async (c, next) => {
  if (c.req.method !== 'GET' && !(c.req.header('content-type') || '').includes('application/json')) {
    return c.json({ error: 'Bad request' }, 400);
  }
  await next();
});

async function loadUser(c) {
  const token = getCookie(c, 'sid');
  if (!token) return null;
  return c.env.DB.prepare(
    `SELECT u.id, u.username, u.role, u.supplier_id,
            s.code AS supplier_code, s.name AS supplier_name
       FROM sessions se
       JOIN users u ON u.id = se.user_id
       LEFT JOIN suppliers s ON s.id = u.supplier_id
      WHERE se.token_hash = ? AND se.expires_at > ?`
  ).bind(await sha256Hex(token), Date.now()).first();
}

const requireUser = async (c, next) => {
  const user = await loadUser(c);
  if (!user) return c.json({ error: 'Not logged in' }, 401);
  c.set('user', user);
  await next();
};

const requireAdmin = async (c, next) => {
  if (c.get('user').role !== 'admin') return c.json({ error: 'Forbidden' }, 403);
  await next();
};

app.use('/api/admin/*', requireUser, requireAdmin);

/* ---------- auth ---------- */

app.post('/api/login', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const username = String(body.username || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!username || !password) return c.json({ error: 'Enter your username and password' }, 400);

  const user = await c.env.DB.prepare(
    `SELECT u.id, u.role, u.password_hash, s.status AS supplier_status
       FROM users u LEFT JOIN suppliers s ON s.id = u.supplier_id
      WHERE u.username = ?`
  ).bind(username).first();

  let ok = false;
  if (user) ok = await verifyPassword(password, user.password_hash);
  else await pbkdf2(password, new Uint8Array(16)); // keep timing similar for unknown users

  if (!ok) return c.json({ error: 'Wrong username or password' }, 401);
  if (user.role === 'supplier' && user.supplier_status !== 'active') {
    return c.json({ error: 'This supplier account is disabled. Contact the warehouse.' }, 403);
  }

  const token = toHex(crypto.getRandomValues(new Uint8Array(32)));
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(Date.now()),
    c.env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .bind(await sha256Hex(token), user.id, Date.now() + SESSION_DAYS * 86400000),
  ]);
  setCookie(c, 'sid', token, {
    httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: SESSION_DAYS * 86400,
  });
  return c.json({ role: user.role });
});

app.post('/api/logout', async (c) => {
  const token = getCookie(c, 'sid');
  if (token) {
    await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
  }
  deleteCookie(c, 'sid', { path: '/' });
  return c.json({ ok: true });
});

app.get('/api/me', requireUser, (c) => c.json(c.get('user')));

/* ---------- supplier ---------- */

function requireSupplier(c) {
  const u = c.get('user');
  return u.supplier_id ? u : null;
}

// One month of this supplier's schedule, plus the list of months that have data.
app.get('/api/schedule', requireUser, async (c) => {
  const u = requireSupplier(c);
  if (!u) return c.json({ error: 'Not a supplier account' }, 403);
  const today = todayLocal();
  const { results: mrows } = await c.env.DB.prepare(
    'SELECT DISTINCT substr(delivery_date, 1, 7) AS m FROM schedule_lines WHERE supplier_id = ? ORDER BY m'
  ).bind(u.supplier_id).all();
  const months = mrows.map((r) => r.m);

  let month = c.req.query('month') || '';
  if (!MONTH_RE.test(month)) {
    const cur = today.slice(0, 7);
    month = months.includes(cur) ? cur : (months.find((m) => m > cur) || months[months.length - 1] || cur);
  }
  const [from, to] = monthRange(month);
  const { results } = await c.env.DB.prepare(
    `SELECT ${LINE_COLS} FROM schedule_lines
      WHERE supplier_id = ? AND delivery_date BETWEEN ? AND ?
      ORDER BY delivery_date, po_no, part_no`
  ).bind(u.supplier_id, from, to).all();
  const { results: printed } = await c.env.DB.prepare(
    'SELECT DISTINCT delivery_date FROM download_log WHERE supplier_id = ? AND delivery_date BETWEEN ? AND ?'
  ).bind(u.supplier_id, from, to).all();
  return c.json({
    supplier: { code: u.supplier_code, name: u.supplier_name }, today, months, month, lines: results,
    printed: printed.map((r) => r.delivery_date),
  });
});

// Label data for the chosen lines (and box ranges). Records one download-log row per delivery date.
app.post('/api/labels', requireUser, async (c) => {
  const u = requireSupplier(c);
  if (!u) return c.json({ error: 'Not a supplier account' }, 403);
  const body = await c.req.json().catch(() => ({}));
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return c.json({ error: 'Choose at least one delivery to print' }, 400);
  if (items.length > 600) return c.json({ error: 'Too many lines. Print fewer dates at a time.' }, 400);

  const ids = [...new Set(items.map((i) => Number(i.line_id)))];
  if (ids.some((id) => !Number.isInteger(id) || id < 1)) return c.json({ error: 'Invalid selection' }, 400);
  const { results: lines } = await c.env.DB.prepare(
    `SELECT ${LINE_COLS} FROM schedule_lines
      WHERE supplier_id = ? AND id IN (SELECT value FROM json_each(?))`
  ).bind(u.supplier_id, JSON.stringify(ids)).all();
  const byId = new Map(lines.map((l) => [l.id, l]));

  const labels = [];
  const perDate = new Map();
  let total = 0;
  for (const it of items) {
    const line = byId.get(Number(it.line_id));
    if (!line) return c.json({ error: 'A selected line was not found. Refresh the page.' }, 400);
    const from = Number(it.from);
    const to = Number(it.to);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to > line.boxes || from > to) {
      return c.json({ error: `Box range for ${line.part_no} must be between 1 and ${line.boxes}` }, 400);
    }
    const sj = String(it.sj || '').replace(/;/g, ' ').trim().slice(0, 40); // ';' is the QR delimiter
    labels.push({
      date: line.delivery_date, sj, po_no: line.po_no, part_no: line.part_no, part_name: line.part_name,
      qty_per_box: line.qty_per_box, qty_total: line.qty_total, boxes: line.boxes, from, to,
    });
    total += to - from + 1;
    const key = `${line.delivery_date}|${sj}`;
    perDate.set(key, (perDate.get(key) || 0) + (to - from + 1));
  }
  if (total > 2500) return c.json({ error: 'That is more than 2500 labels. Print fewer dates at a time.' }, 400);

  await c.env.DB.batch([...perDate].map(([key, count]) => {
    const [date, sj] = key.split('|');
    return c.env.DB.prepare(
      'INSERT INTO download_log (user_id, supplier_id, delivery_date, sj_no, labels_count) VALUES (?, ?, ?, ?, ?)'
    ).bind(u.id, u.supplier_id, date, sj, count);
  }));

  labels.sort((x, y) => x.date.localeCompare(y.date) || x.po_no.localeCompare(y.po_no) || x.part_no.localeCompare(y.part_no));
  return c.json({ supplier: { code: u.supplier_code, name: u.supplier_name }, labels, total });
});

/* ---------- QZ Tray: sign print requests so the printing helper does not ask "Allow?" ---------- */
// Needs the secret QZ_PRIVATE_KEY (made by `npm run qz:cert`). Without it direct printing still works, QZ just asks to Allow.
let qzKey = null;
async function qzPrivateKey(pem) {
  if (!qzKey) {
    const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----|\s/g, '')), (ch) => ch.charCodeAt(0));
    qzKey = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' }, false, ['sign']);
  }
  return qzKey;
}

app.post('/api/qz/sign', requireUser, async (c) => {
  if (!c.env.QZ_PRIVATE_KEY) return c.json({ error: 'Print signing is not set up' }, 501);
  const body = await c.req.json().catch(() => ({}));
  const request = String(body.request || '');
  if (!request || request.length > 20000) return c.json({ error: 'Bad request' }, 400);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await qzPrivateKey(c.env.QZ_PRIVATE_KEY), new TextEncoder().encode(request));
  return c.text(btoa(String.fromCharCode(...new Uint8Array(sig))));
});

/* ---------- admin: suppliers & users ---------- */

app.get('/api/admin/suppliers', async (c) => {
  const suppliers = await c.env.DB.prepare('SELECT id, code, name, status FROM suppliers ORDER BY code').all();
  const users = await c.env.DB.prepare(
    "SELECT id, supplier_id, username FROM users WHERE role = 'supplier' ORDER BY username"
  ).all();
  return c.json({ suppliers: suppliers.results, users: users.results });
});

app.post('/api/admin/suppliers', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const code = String(body.code || '').trim().toUpperCase();
  const name = String(body.name || '').trim();
  if (!/^[A-Z0-9_-]{1,20}$/.test(code)) return c.json({ error: 'Code: 1-20 letters, digits, - or _' }, 400);
  if (!name) return c.json({ error: 'Enter the supplier name' }, 400);
  try {
    await c.env.DB.prepare('INSERT INTO suppliers (code, name) VALUES (?, ?)').bind(code, name).run();
  } catch {
    return c.json({ error: 'That supplier code already exists' }, 409);
  }
  return c.json({ ok: true });
});

app.post('/api/admin/suppliers/:id/status', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const status = body.status === 'disabled' ? 'disabled' : 'active';
  await c.env.DB.prepare('UPDATE suppliers SET status = ? WHERE id = ?').bind(status, c.req.param('id')).run();
  return c.json({ ok: true });
});

// Update a supplier's code and name. Schedules and logins follow the supplier id, so nothing else changes.
app.post('/api/admin/suppliers/:id/update', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const id = Number(c.req.param('id'));
  const code = String(body.code || '').trim().toUpperCase();
  const name = String(body.name || '').trim().slice(0, 120);
  if (!/^[A-Z0-9_-]{1,20}$/.test(code)) return c.json({ error: 'Code: 1-20 letters, digits, - or _' }, 400);
  if (!name) return c.json({ error: 'Enter the supplier name' }, 400);
  const exists = await c.env.DB.prepare('SELECT id FROM suppliers WHERE id = ?').bind(id).first();
  if (!exists) return c.json({ error: 'Supplier not found. Refresh the page.' }, 404);
  try {
    await c.env.DB.prepare('UPDATE suppliers SET code = ?, name = ? WHERE id = ?').bind(code, name, id).run();
  } catch {
    return c.json({ error: 'That supplier code already exists' }, 409);
  }
  return c.json({ ok: true });
});

// Delete a supplier together with its logins, schedule and download history.
app.delete('/api/admin/suppliers/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const db = c.env.DB;
  const supplier = await db.prepare('SELECT id FROM suppliers WHERE id = ?').bind(id).first();
  if (!supplier) return c.json({ error: 'Supplier not found. Refresh the page.' }, 404);
  await db.batch([
    db.prepare('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE supplier_id = ?)').bind(id),
    db.prepare('DELETE FROM download_log WHERE supplier_id = ?').bind(id),
    db.prepare('DELETE FROM schedule_lines WHERE supplier_id = ?').bind(id),
    db.prepare("DELETE FROM users WHERE supplier_id = ? AND role = 'supplier'").bind(id),
    db.prepare('DELETE FROM suppliers WHERE id = ?').bind(id),
  ]);
  return c.json({ ok: true });
});

app.post('/api/admin/users', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const username = String(body.username || '').trim().toLowerCase();
  const password = String(body.password || '');
  const supplierId = Number(body.supplier_id);
  if (!/^[a-z0-9._@-]{3,60}$/.test(username)) return c.json({ error: 'Username: 3-60 lowercase letters, digits or . _ @ -' }, 400);
  if (password.length < 8) return c.json({ error: 'Password must be at least 8 characters' }, 400);
  const supplier = await c.env.DB.prepare('SELECT id FROM suppliers WHERE id = ?').bind(supplierId).first();
  if (!supplier) return c.json({ error: 'Choose a supplier' }, 400);
  try {
    await c.env.DB.prepare(
      "INSERT INTO users (supplier_id, username, password_hash, role) VALUES (?, ?, ?, 'supplier')"
    ).bind(supplierId, username, await hashPassword(password)).run();
  } catch {
    return c.json({ error: 'That username is taken' }, 409);
  }
  return c.json({ ok: true });
});

app.post('/api/admin/users/:id/password', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const password = String(body.password || '');
  if (password.length < 8) return c.json({ error: 'Password must be at least 8 characters' }, 400);
  const id = c.req.param('id');
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ? AND role = 'supplier'")
      .bind(await hashPassword(password), id),
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id),
  ]);
  return c.json({ ok: true });
});

/* ---------- admin: schedule ---------- */

// Import one PO file: one supplier, one month, one PO.
// body: { supplier_code, month: 'YYYY-MM', po_no, rows: [{ d, p, n, l, q, o }] }
//   d = date, p = part no, n = part name, l = qty per box (lot), q = scheduled pieces that day
app.post('/api/admin/schedule/import', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const code = String(body.supplier_code || '').trim().toUpperCase();
  const month = String(body.month || '');
  const po = String(body.po_no || '').trim().replace(/;/g, ' ');
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!/^[A-Z0-9_-]{1,20}$/.test(code)) return c.json({ error: 'Supplier code (first word of the file name) is invalid' }, 400);
  if (!MONTH_RE.test(month)) return c.json({ error: 'Invalid month' }, 400);
  if (!po || po.length > 80) return c.json({ error: 'PO number is missing' }, 400);
  if (!rows.length) return c.json({ error: 'No deliveries found in this file' }, 400);
  if (rows.length > 6000) return c.json({ error: 'Too many rows in one file' }, 400);

  // Validate and merge duplicates (same date + part).
  const merged = new Map();
  for (const r of rows) {
    const d = String(r.d || '');
    const p = String(r.p || '').trim();
    const l = Number(r.l);
    const q = Number(r.q);
    if (!DATE_RE.test(d) || d.slice(0, 7) !== month) return c.json({ error: `Date ${d} is outside ${month}` }, 400);
    if (!p || p.includes(';')) return c.json({ error: `Invalid part number "${p}"` }, 400);
    if (!Number.isInteger(l) || l < 1 || !Number.isInteger(q) || q < 1) return c.json({ error: `Invalid quantity for ${p} on ${d}` }, 400);
    const key = `${d}|${p}`;
    const prev = merged.get(key);
    if (prev) prev.q += q;
    else merged.set(key, { d, p, n: String(r.n || '').trim().slice(0, 120), l, q, o: Number.isInteger(Number(r.o)) ? Number(r.o) : 0 });
  }
  const list = [...merged.values()].map((r) => ({ ...r, b: Math.ceil(r.q / r.l) }));

  const db = c.env.DB;
  // Only suppliers that already exist can be imported. Nothing is created from a file.
  const supplier = await db.prepare('SELECT id FROM suppliers WHERE code = ?').bind(code).first();
  if (!supplier) {
    return c.json({ error: `Supplier "${code}" is not registered. Add it under Suppliers first, or fix the file name.` }, 400);
  }

  const [from, to] = monthRange(month);
  const statements = [
    // Re-importing a month replaces lines that are not received yet; received lines are kept and updated.
    db.prepare(
      "DELETE FROM schedule_lines WHERE supplier_id = ? AND po_no = ? AND delivery_date BETWEEN ? AND ? AND status = 'scheduled'"
    ).bind(supplier.id, po, from, to),
  ];
  for (let i = 0; i < list.length; i += 250) {
    statements.push(db.prepare(
      `INSERT INTO schedule_lines (supplier_id, delivery_date, po_no, part_no, part_name, qty_per_box, boxes, qty_total, row_no)
       SELECT ?, json_extract(value, '$.d'), ?, json_extract(value, '$.p'), json_extract(value, '$.n'),
              json_extract(value, '$.l'), json_extract(value, '$.b'), json_extract(value, '$.q'), json_extract(value, '$.o')
         FROM json_each(?) WHERE true
       ON CONFLICT(supplier_id, delivery_date, po_no, part_no) DO UPDATE SET
         part_name = excluded.part_name, qty_per_box = excluded.qty_per_box,
         boxes = excluded.boxes, qty_total = excluded.qty_total, row_no = excluded.row_no,
         status = CASE WHEN schedule_lines.status = 'scheduled' THEN 'scheduled'
                       WHEN schedule_lines.qty_received >= excluded.qty_total THEN 'received'
                       ELSE 'shortage' END`
    ).bind(supplier.id, po, JSON.stringify(list.slice(i, i + 250))));
  }
  await db.batch(statements);
  return c.json({
    supplier_id: supplier.id, code, month,
    lines: list.length, boxes: list.reduce((n, r) => n + r.b, 0),
  });
});

// Suppliers that have data in a month (for the badges), plus all months that have data.
app.get('/api/admin/month-suppliers', async (c) => {
  const month = MONTH_RE.test(c.req.query('month') || '') ? c.req.query('month') : todayLocal().slice(0, 7);
  const [from, to] = monthRange(month);
  const today = todayLocal();
  const { results } = await c.env.DB.prepare(
    `SELECT s.id, s.code, s.name,
            COUNT(*) AS lines, SUM(l.boxes) AS boxes,
            SUM(CASE WHEN l.status != 'scheduled' THEN 1 ELSE 0 END) AS done_lines,
            SUM(CASE WHEN l.status = 'shortage' THEN l.qty_total - l.qty_received ELSE 0 END) AS short_qty,
            SUM(CASE WHEN l.status = 'scheduled' AND l.delivery_date < ? THEN 1 ELSE 0 END) AS overdue_lines
       FROM schedule_lines l JOIN suppliers s ON s.id = l.supplier_id
      WHERE l.delivery_date BETWEEN ? AND ?
      GROUP BY s.id ORDER BY s.code`
  ).bind(today, from, to).all();
  const { results: mrows } = await c.env.DB.prepare(
    'SELECT DISTINCT substr(delivery_date, 1, 7) AS m FROM schedule_lines ORDER BY m'
  ).all();
  return c.json({ month, today, suppliers: results, months: mrows.map((r) => r.m) });
});

app.get('/api/admin/matrix', async (c) => {
  const month = c.req.query('month') || '';
  const supplierId = Number(c.req.query('supplier_id'));
  if (!MONTH_RE.test(month) || !supplierId) return c.json({ error: 'Choose a month and a supplier' }, 400);
  const [from, to] = monthRange(month);
  const { results } = await c.env.DB.prepare(
    `SELECT ${LINE_COLS} FROM schedule_lines
      WHERE supplier_id = ? AND delivery_date BETWEEN ? AND ?
      ORDER BY po_no, row_no, part_no, delivery_date`
  ).bind(supplierId, from, to).all();
  return c.json({ lines: results });
});

// Record what was received. items: [{ id, qty_received }]  (qty_received null = reset to "scheduled")
app.post('/api/admin/lines/receive', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length || items.length > 500) return c.json({ error: 'Nothing to save' }, 400);
  const ids = items.map((i) => Number(i.id));
  if (ids.some((id) => !Number.isInteger(id) || id < 1)) return c.json({ error: 'Invalid line' }, 400);

  const { results } = await c.env.DB.prepare(
    'SELECT id, qty_total FROM schedule_lines WHERE id IN (SELECT value FROM json_each(?))'
  ).bind(JSON.stringify(ids)).all();
  const totals = new Map(results.map((r) => [r.id, r.qty_total]));

  const statements = [];
  const out = [];
  for (const it of items) {
    const id = Number(it.id);
    if (!totals.has(id)) return c.json({ error: 'A line was not found. Refresh the page.' }, 404);
    let qty = 0;
    let status = 'scheduled';
    if (it.qty_received !== null && it.qty_received !== undefined && it.qty_received !== '') {
      qty = Number(it.qty_received);
      if (!Number.isInteger(qty) || qty < 0) return c.json({ error: 'Quantities must be whole numbers' }, 400);
      status = qty >= totals.get(id) ? 'received' : 'shortage';
    }
    statements.push(c.env.DB.prepare('UPDATE schedule_lines SET qty_received = ?, status = ? WHERE id = ?').bind(qty, status, id));
    out.push({ id, qty_received: qty, status });
  }
  await c.env.DB.batch(statements);
  return c.json({ ok: true, lines: out });
});

// Remove lines that have not been received yet (undo a wrong import).
app.post('/api/admin/schedule/remove', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const month = String(body.month || '');
  const supplierId = Number(body.supplier_id);
  if (!MONTH_RE.test(month) || !supplierId) return c.json({ error: 'Choose a month and a supplier' }, 400);
  const [from, to] = monthRange(month);
  const res = await c.env.DB.prepare(
    "DELETE FROM schedule_lines WHERE supplier_id = ? AND delivery_date BETWEEN ? AND ? AND status = 'scheduled'"
  ).bind(supplierId, from, to).run();
  return c.json({ removed: res.meta.changes });
});

app.get('/api/admin/downloads', async (c) => {
  const supplierId = Number(c.req.query('supplier_id')) || null;
  const { results } = await c.env.DB.prepare(
    `SELECT d.id, d.downloaded_at, d.delivery_date, d.sj_no, d.labels_count,
            u.username, s.code AS supplier_code
       FROM download_log d
       JOIN users u ON u.id = d.user_id
       JOIN suppliers s ON s.id = d.supplier_id
      WHERE (? IS NULL OR d.supplier_id = ?)
      ORDER BY d.id DESC LIMIT 200`
  ).bind(supplierId, supplierId).all();

  // Deliveries from the start of this month up to 7 days ahead whose labels nobody has downloaded yet.
  const today = todayLocal();
  const monthStart = today.slice(0, 7) + '-01';
  const end = new Date(Date.now() + (TZ_HOURS + 24 * 7) * 3600000).toISOString().slice(0, 10);
  const { results: pending } = await c.env.DB.prepare(
    `SELECT s.code AS supplier_code, l.delivery_date, SUM(l.boxes) AS boxes
       FROM schedule_lines l JOIN suppliers s ON s.id = l.supplier_id
      WHERE l.delivery_date BETWEEN ? AND ? AND s.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM download_log d
                         WHERE d.supplier_id = l.supplier_id AND d.delivery_date = l.delivery_date)
      GROUP BY l.supplier_id, l.delivery_date
      ORDER BY l.delivery_date, s.code LIMIT 400`
  ).bind(monthStart, end).all();
  return c.json({ downloads: results, pending, today });
});

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'Something went wrong. Try again.' }, 500);
});

export default app;
