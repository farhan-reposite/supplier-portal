import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';

const app = new Hono();

const SESSION_DAYS = 7;
const PBKDF2_ITERATIONS = 100000; // Workers cap PBKDF2 at 100k; keep in sync with scripts/make-admin.mjs
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

app.get('/api/schedule', requireUser, async (c) => {
  const u = requireSupplier(c);
  if (!u) return c.json({ error: 'Not a supplier account' }, 403);
  const { results } = await c.env.DB.prepare(
    `SELECT id, delivery_date, po_no, part_no, part_name, qty_per_box, boxes, qty_received, status
       FROM schedule_lines
      WHERE supplier_id = ? AND delivery_date >= date('now', '-60 days')
      ORDER BY delivery_date, po_no, part_no`
  ).bind(u.supplier_id).all();
  return c.json({ supplier: { code: u.supplier_code, name: u.supplier_name }, lines: results });
});

// Returns label data for one delivery date and records the download.
app.post('/api/labels', requireUser, async (c) => {
  const u = requireSupplier(c);
  if (!u) return c.json({ error: 'Not a supplier account' }, 403);
  const body = await c.req.json().catch(() => ({}));
  const date = String(body.date || '');
  if (!DATE_RE.test(date)) return c.json({ error: 'Invalid date' }, 400);
  const sj = String(body.sj || '').replace(/;/g, ' ').trim().slice(0, 40); // ';' is the QR delimiter

  const { results } = await c.env.DB.prepare(
    `SELECT id, po_no, part_no, part_name, qty_per_box, boxes
       FROM schedule_lines
      WHERE supplier_id = ? AND delivery_date = ?
      ORDER BY po_no, part_no`
  ).bind(u.supplier_id, date).all();
  if (!results.length) return c.json({ error: 'No schedule for this date' }, 404);

  const labelsCount = results.reduce((n, r) => n + r.boxes, 0);
  await c.env.DB.prepare(
    'INSERT INTO download_log (user_id, supplier_id, delivery_date, sj_no, labels_count) VALUES (?, ?, ?, ?, ?)'
  ).bind(u.id, u.supplier_id, date, sj, labelsCount).run();

  return c.json({ supplier: { code: u.supplier_code, name: u.supplier_name }, date, sj, lines: results });
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

app.post('/api/admin/schedule/upload', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) return c.json({ error: 'No rows to upload' }, 400);
  if (rows.length > 2000) return c.json({ error: 'Maximum 2000 rows per upload' }, 400);

  const { results: suppliers } = await c.env.DB.prepare('SELECT id, code FROM suppliers').all();
  const byCode = new Map(suppliers.map((s) => [s.code, s.id]));

  const clean = [];
  const unknown = new Set();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {};
    const row = {
      supplier_code: String(r.supplier_code || '').trim().toUpperCase(),
      delivery_date: String(r.delivery_date || ''),
      po_no: String(r.po_no || '').trim(),
      part_no: String(r.part_no || '').trim(),
      part_name: String(r.part_name || '').trim(),
      qty_per_box: Number(r.qty_per_box),
      boxes: Number(r.boxes),
    };
    const bad =
      !DATE_RE.test(row.delivery_date) || !row.po_no || !row.part_no ||
      row.po_no.includes(';') || row.part_no.includes(';') ||
      !Number.isInteger(row.qty_per_box) || row.qty_per_box < 1 ||
      !Number.isInteger(row.boxes) || row.boxes < 1 || row.boxes > 999;
    if (bad) return c.json({ error: `Row ${i + 2} has invalid data` }, 400);
    if (!byCode.has(row.supplier_code)) unknown.add(row.supplier_code);
    clean.push(row);
  }
  if (unknown.size) {
    return c.json({ error: `Unknown supplier code: ${[...unknown].join(', ')}. Create the supplier first.` }, 400);
  }

  // Re-uploading a date replaces its not-yet-received lines.
  const db = c.env.DB;
  const statements = [];
  const combos = new Set(clean.map((r) => `${byCode.get(r.supplier_code)}|${r.delivery_date}`));
  for (const combo of combos) {
    const [sid, date] = combo.split('|');
    statements.push(
      db.prepare("DELETE FROM schedule_lines WHERE supplier_id = ? AND delivery_date = ? AND status = 'scheduled'")
        .bind(Number(sid), date)
    );
  }
  for (const r of clean) {
    statements.push(
      db.prepare(
        `INSERT INTO schedule_lines (supplier_id, delivery_date, po_no, part_no, part_name, qty_per_box, boxes)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(byCode.get(r.supplier_code), r.delivery_date, r.po_no, r.part_no, r.part_name, r.qty_per_box, r.boxes)
    );
  }
  for (let i = 0; i < statements.length; i += 80) {
    await db.batch(statements.slice(i, i + 80));
  }
  return c.json({ inserted: clean.length, dates: combos.size });
});

app.get('/api/admin/schedule', async (c) => {
  const from = DATE_RE.test(c.req.query('from') || '') ? c.req.query('from') : null;
  const supplierId = Number(c.req.query('supplier_id')) || null;
  const { results } = await c.env.DB.prepare(
    `SELECT l.id, l.delivery_date, s.code AS supplier_code, l.po_no, l.part_no, l.part_name,
            l.qty_per_box, l.boxes, l.qty_received, l.status
       FROM schedule_lines l JOIN suppliers s ON s.id = l.supplier_id
      WHERE l.delivery_date >= COALESCE(?, date('now', '-7 days'))
        AND (? IS NULL OR l.supplier_id = ?)
      ORDER BY l.delivery_date, s.code, l.po_no, l.part_no
      LIMIT 1000`
  ).bind(from, supplierId, supplierId).all();
  return c.json({ lines: results });
});

// Record what was actually received. qty_received = null resets the line.
app.post('/api/admin/lines/:id/receive', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const line = await c.env.DB.prepare('SELECT qty_per_box, boxes FROM schedule_lines WHERE id = ?')
    .bind(c.req.param('id')).first();
  if (!line) return c.json({ error: 'Line not found' }, 404);

  let qty = 0;
  let status = 'scheduled';
  if (body.qty_received !== null && body.qty_received !== undefined && body.qty_received !== '') {
    qty = Number(body.qty_received);
    if (!Number.isInteger(qty) || qty < 0) return c.json({ error: 'Quantity must be a whole number' }, 400);
    status = qty >= line.qty_per_box * line.boxes ? 'received' : 'shortage';
  }
  await c.env.DB.prepare('UPDATE schedule_lines SET qty_received = ?, status = ? WHERE id = ?')
    .bind(qty, status, c.req.param('id')).run();
  return c.json({ ok: true, status });
});

app.delete('/api/admin/lines/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM schedule_lines WHERE id = ?').bind(c.req.param('id')).run();
  return c.json({ ok: true });
});

app.get('/api/admin/downloads', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT d.id, d.downloaded_at, d.delivery_date, d.sj_no, d.labels_count,
            u.username, s.code AS supplier_code
       FROM download_log d
       JOIN users u ON u.id = d.user_id
       JOIN suppliers s ON s.id = d.supplier_id
      ORDER BY d.id DESC LIMIT 200`
  ).all();
  return c.json({ downloads: results });
});

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'Something went wrong. Try again.' }, 500);
});

export default app;
