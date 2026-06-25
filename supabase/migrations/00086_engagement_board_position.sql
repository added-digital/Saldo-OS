-- =====================================================================
-- Migration 00086: Manual card ordering on the engagement board
-- =====================================================================
-- The board previously had no per-card ordering: each column rendered its
-- cards in whatever order Postgres happened to return them (no ORDER BY), so
-- the sequence was effectively arbitrary and could shuffle between loads.
--
-- This adds an explicit, per-workflow ordering so the team can:
--   • have a card jump to the TOP of a column when it's moved there, and
--   • drag cards up/down WITHIN a column to arrange them as they like.
--
-- Design (deliberately additive — never touches existing live values):
--   • Two nullable position columns, one per pipeline (bokslut / INK2), because
--     a single engagement row carries both statuses and lives in two columns at
--     once (one per board tab). Ordering must be independent per tab.
--   • NULL = "never manually ordered". The board sorts positioned cards first
--     (ascending), then falls back to a stable recency tiebreak for the rest,
--     so existing data simply keeps a deterministic order until first dragged.
--   • A single SECURITY INVOKER function renumbers a column atomically from an
--     ordered id array. RLS still applies (the caller needs the same
--     'customers' update grant the board already uses), and it only writes rows
--     whose position actually changes — so it never bumps updated_at or fires
--     the status/activity triggers for untouched cards.
--
-- double precision (not int) leaves head-room for future fractional inserts
-- without a migration, though the app currently renumbers to clean integers.

ALTER TABLE engagements
  ADD COLUMN IF NOT EXISTS bokslut_position DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS ink2_position    DOUBLE PRECISION;

-- Partial indexes: only positioned cards are interesting to order by.
CREATE INDEX IF NOT EXISTS idx_engagements_bokslut_position
  ON engagements(bokslut_position) WHERE bokslut_position IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_engagements_ink2_position
  ON engagements(ink2_position) WHERE ink2_position IS NOT NULL;

-- ---------------------------------------------------------------------
-- Atomic column renumber from an ordered id list.
-- ---------------------------------------------------------------------
-- p_ids is the FULL ordered set of engagement ids for one column (top → bottom)
-- for the given workflow. Position is set to the 1-based ordinal. SECURITY
-- INVOKER (the default) keeps RLS in force: the row-level UPDATE policy on
-- engagements (has_scope('customers')) gates the write exactly as a direct
-- update would. The IS DISTINCT FROM guard means a no-op reorder writes nothing.
CREATE OR REPLACE FUNCTION reorder_engagements(p_workflow TEXT, p_ids UUID[])
RETURNS VOID
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF p_workflow = 'bokslut' THEN
    UPDATE engagements e
       SET bokslut_position = ord.idx
      FROM unnest(p_ids) WITH ORDINALITY AS ord(id, idx)
     WHERE e.id = ord.id
       AND e.bokslut_position IS DISTINCT FROM ord.idx::double precision;
  ELSIF p_workflow = 'ink2' THEN
    UPDATE engagements e
       SET ink2_position = ord.idx
      FROM unnest(p_ids) WITH ORDINALITY AS ord(id, idx)
     WHERE e.id = ord.id
       AND e.ink2_position IS DISTINCT FROM ord.idx::double precision;
  ELSE
    RAISE EXCEPTION 'reorder_engagements: unknown workflow %', p_workflow;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION reorder_engagements(TEXT, UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reorder_engagements(TEXT, UUID[]) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- Expose the two positions on the board read model.
-- ---------------------------------------------------------------------
-- CREATE OR REPLACE is valid here: we only APPEND two trailing columns to the
-- existing 00085 definition — column order/names/types above are unchanged.
CREATE OR REPLACE VIEW engagement_board
WITH (security_invoker = on) AS
SELECT
  e.id,
  e.customer_id,
  c.name AS customer_name,
  c.org_number,
  e.fiscal_year_end,
  mgr.id        AS consultant_id,
  mgr.full_name AS consultant_name,
  COALESCE(mgrt.name, c.office) AS group_name,

  e.bokslut_status_id,
  bs.key   AS bokslut_status_key,
  bs.label AS bokslut_status_label,
  bs.sort_order AS bokslut_status_sort,
  bs.is_done AS bokslut_status_is_done,
  e.bokslut_status_changed_at,

  e.ink2_status_id,
  isk.key   AS ink2_status_key,
  isk.label AS ink2_status_label,
  isk.sort_order AS ink2_status_sort,
  isk.is_done AS ink2_status_is_done,
  e.ink2_status_changed_at,

  e.deadline,
  (e.deadline IS NOT NULL
     AND e.deadline < CURRENT_DATE
     AND COALESCE(bs.is_done, false) = false) AS is_overdue,

  e.bokslut_comment,
  e.prior_year_comment,
  e.next_year_note,
  e.general_comment,
  e.setup,
  c.bokslut_setup AS customer_setup,
  e.created_at,
  e.updated_at,
  e.bokslut_cleared_at,
  e.ink2_cleared_at,
  e.co_consultant_id,
  cop.full_name AS co_consultant_name,
  e.bokslut_position,
  e.ink2_position
FROM engagements e
JOIN customers c ON c.id = e.customer_id
LEFT JOIN LATERAL (
  SELECT p.id, p.full_name, p.team_id
  FROM profiles p
  WHERE c.fortnox_cost_center IS NOT NULL
    AND p.fortnox_cost_center = c.fortnox_cost_center
    AND p.is_active
  ORDER BY p.full_name
  LIMIT 1
) mgr ON true
LEFT JOIN teams mgrt ON mgrt.id = mgr.team_id
LEFT JOIN profiles cop ON cop.id = e.co_consultant_id
LEFT JOIN engagement_statuses bs ON bs.id = e.bokslut_status_id
LEFT JOIN engagement_statuses isk ON isk.id = e.ink2_status_id;
