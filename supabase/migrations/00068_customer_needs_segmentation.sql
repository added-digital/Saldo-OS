-- =====================================================
-- Migration 00068: Flag customers that need segmentation / setup
-- =====================================================
--
-- The durable Bokslut tags (permissions, systems, agreements) are now owned by
-- the customer card. When a NEW customer is imported from Fortnox it has none
-- of these filled in, so we flag it for follow-up and surface a notification in
-- the top bar.
--
-- Mechanism: a DEFAULT true column. New rows (sync-customers upserts that
-- INSERT) get true automatically without any edge-function change; on-conflict
-- UPDATEs of existing customers leave it untouched (the column isn't in the
-- sync payload). Existing customers are backfilled to false so only future
-- imports are flagged. The flag is cleared when someone saves the customer's
-- Bokslut setup panel.

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS needs_segmentation BOOLEAN NOT NULL DEFAULT true;

-- Backfill: treat the current customer base as already handled.
UPDATE customers SET needs_segmentation = false WHERE needs_segmentation;

-- Partial index for the cheap "how many still need it?" count in the top bar.
CREATE INDEX IF NOT EXISTS idx_customers_needs_segmentation
  ON customers(needs_segmentation)
  WHERE needs_segmentation;
