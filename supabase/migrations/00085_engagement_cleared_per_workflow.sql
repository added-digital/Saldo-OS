-- =====================================================================
-- Migration 00085: per-workflow "cleared" state (bokslut vs INK2)
-- =====================================================================
-- Bug: an engagement is ONE row holding both the bokslut and the INK2 status,
-- but "cleared from board" was a single `cleared_at` column. The board's clear
-- toggle wrote that one column and the cleared filter read it on BOTH workflow
-- tabs — so clearing a finished bokslut also hid/cleared that customer's INK2
-- card. Bokslut is always finished before INK2 work starts, so the two must be
-- independent.
--
-- Fix: split into `bokslut_cleared_at` + `ink2_cleared_at`. Each workflow tab
-- clears and filters on its own column.
--
-- Existing clears were all made from the bokslut board (bokslut-first), so we
-- migrate the old `cleared_at` onto `bokslut_cleared_at` and leave INK2
-- un-cleared — which also un-hides any INK2 cards that the shared column had
-- wrongly cleared. The old `cleared_at` column is kept (deprecated, no longer
-- read by the view) so this is reversible.

ALTER TABLE engagements
  ADD COLUMN IF NOT EXISTS bokslut_cleared_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ink2_cleared_at    TIMESTAMPTZ;

UPDATE engagements
SET bokslut_cleared_at = cleared_at
WHERE cleared_at IS NOT NULL
  AND bokslut_cleared_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_engagements_bokslut_cleared_at
  ON engagements(bokslut_cleared_at) WHERE bokslut_cleared_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_engagements_ink2_cleared_at
  ON engagements(ink2_cleared_at) WHERE ink2_cleared_at IS NOT NULL;

-- Recreate the board view: expose both cleared flags instead of the single
-- cleared_at. Everything else matches 00083/00084 (live consultant + live team).
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
  cop.full_name AS co_consultant_name
FROM engagements e
JOIN customers c ON c.id = e.customer_id
-- Resolve the customer's manager live, capped to one row.
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
