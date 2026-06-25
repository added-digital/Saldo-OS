-- =====================================================================
-- Migration 00087: Configurable deadline offset (months after year-end)
-- =====================================================================
-- The engagement deadline (Deadline till kund/revisor) is now auto-suggested
-- when a card is created: räkenskapsårsslut (fiscal_year_end) + N months. This
-- stores N as a single, admin-editable board setting so the firm can tune it
-- without a code change. The app still lets each card's deadline be overridden
-- by hand — this only seeds the default.
--
-- Default 3 months. Purely additive: no existing engagement deadline is touched
-- (the offset is read only when proposing a NEW deadline in the UI).

ALTER TABLE engagement_config
  ADD COLUMN IF NOT EXISTS deadline_offset_months INTEGER NOT NULL DEFAULT 3;
