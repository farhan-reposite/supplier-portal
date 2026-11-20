-- Supplier portal schema (Cloudflare D1 / SQLite)

CREATE TABLE IF NOT EXISTS suppliers (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  code   TEXT NOT NULL UNIQUE,            -- printed on the label, e.g. XXI
  name   TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'   -- active | disabled
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id   INTEGER REFERENCES suppliers(id),  -- NULL for admin
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'supplier',  -- admin | supplier
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS schedule_lines (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id   INTEGER NOT NULL REFERENCES suppliers(id),
  delivery_date TEXT NOT NULL,            -- YYYY-MM-DD
  po_no         TEXT NOT NULL,
  part_no       TEXT NOT NULL,
  part_name     TEXT NOT NULL DEFAULT '',
  qty_per_box   INTEGER NOT NULL,         -- lot size (column H in the PO file)
  boxes         INTEGER NOT NULL,         -- ceil(qty_total / qty_per_box)
  qty_total     INTEGER NOT NULL DEFAULT 0, -- scheduled pieces for this date
  row_no        INTEGER NOT NULL DEFAULT 0, -- row order in the Excel file
  qty_received  INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'scheduled',  -- scheduled | received | shortage
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_lines_supplier_date ON schedule_lines(supplier_id, delivery_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lines_key ON schedule_lines(supplier_id, delivery_date, po_no, part_no);
CREATE INDEX IF NOT EXISTS idx_lines_date ON schedule_lines(delivery_date);

CREATE TABLE IF NOT EXISTS download_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,
  supplier_id   INTEGER NOT NULL,
  delivery_date TEXT NOT NULL,
  sj_no         TEXT NOT NULL DEFAULT '',
  labels_count  INTEGER NOT NULL DEFAULT 0,
  downloaded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_log_supplier_date ON download_log(supplier_id, delivery_date);
