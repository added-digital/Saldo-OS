-- Per-company priority for the hit list (Träfflista), alongside the existing
-- handling status. Set manually by admins per (customer, rule) pair, just
-- like status.
--
-- A row now exists when EITHER a status or a priority is set; the app deletes
-- the row when both are cleared. status therefore becomes nullable ("no
-- status" can coexist with a set priority).

ALTER TABLE hit_list_statuses
  ALTER COLUMN status DROP NOT NULL;

ALTER TABLE hit_list_statuses
  ADD COLUMN IF NOT EXISTS priority TEXT
    CHECK (priority IN ('high', 'medium', 'low'));
