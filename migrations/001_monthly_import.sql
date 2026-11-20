-- Run ONCE on a database created from the first version of schema.sql:
--   npx wrangler d1 execute supplier-portal-db --remote --file=migrations/001_monthly_import.sql
-- Fresh installs do not need this (schema.sql already includes it).

ALTER TABLE schedule_lines ADD COLUMN qty_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE schedule_lines ADD COLUMN row_no INTEGER NOT NULL DEFAULT 0;
UPDATE schedule_lines SET qty_total = qty_per_box * boxes WHERE qty_total = 0;

-- Remove accidental duplicates so the unique index can be created
DELETE FROM schedule_lines
 WHERE id NOT IN (SELECT MIN(id) FROM schedule_lines GROUP BY supplier_id, delivery_date, po_no, part_no);

CREATE UNIQUE INDEX IF NOT EXISTS idx_lines_key ON schedule_lines(supplier_id, delivery_date, po_no, part_no);
CREATE INDEX IF NOT EXISTS idx_lines_date ON schedule_lines(delivery_date);
CREATE INDEX IF NOT EXISTS idx_log_supplier_date ON download_log(supplier_id, delivery_date);
