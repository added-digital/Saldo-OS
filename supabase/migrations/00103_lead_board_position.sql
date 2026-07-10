-- =====================================================================
-- Migration 00103: Manual card ordering on the leads board
-- =====================================================================
-- The leads board renders each status column newest-first. This adds an
-- explicit per-card ordering so the team can drag cards up/down WITHIN a
-- column to arrange them (mirrors the engagement board — migration 00086).
--
-- Design (deliberately additive — never touches existing rows):
--   • One nullable position column. A lead lives in exactly one column (its
--     status), so a single position is enough (unlike engagements, which carry
--     two statuses at once and need one position per pipeline).
--   • NULL = "never manually ordered". The board sorts positioned cards first
--     (ascending), then falls back to a recency tiebreak, so existing data keeps
--     a deterministic order until first dragged.
--   • A single SECURITY INVOKER function renumbers a column atomically from an
--     ordered id array. RLS still applies (the caller needs the website_leads
--     UPDATE grant the board already uses), and it only writes rows whose
--     position actually changes — so untouched cards don't bump updated_at.
--
-- double precision (not int) leaves head-room for future fractional inserts
-- without a migration, though the app renumbers to clean integers.

ALTER TABLE website_leads
  ADD COLUMN IF NOT EXISTS board_position DOUBLE PRECISION;

-- Partial index: only positioned cards are interesting to order by.
CREATE INDEX IF NOT EXISTS idx_website_leads_board_position
  ON website_leads(board_position) WHERE board_position IS NOT NULL;

-- ---------------------------------------------------------------------
-- Atomic column renumber from an ordered id list.
-- ---------------------------------------------------------------------
-- p_ids is the FULL ordered set of lead ids for one column (top → bottom).
-- Position is set to the 1-based ordinal. SECURITY INVOKER (default) keeps RLS
-- in force: the row-level UPDATE policy on website_leads gates the write exactly
-- as a direct update would. The IS DISTINCT FROM guard makes a no-op reorder
-- write nothing.
CREATE OR REPLACE FUNCTION reorder_leads(p_ids UUID[])
RETURNS VOID
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  UPDATE website_leads w
     SET board_position = ord.idx
    FROM unnest(p_ids) WITH ORDINALITY AS ord(id, idx)
   WHERE w.id = ord.id
     AND w.board_position IS DISTINCT FROM ord.idx::double precision;
END;
$$;

REVOKE ALL ON FUNCTION reorder_leads(UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reorder_leads(UUID[]) TO authenticated, service_role;
