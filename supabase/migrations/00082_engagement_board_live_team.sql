-- =====================================================================
-- Migration 00082: engagement_board shows the consultant's LIVE team
-- =====================================================================
-- Previously the board's `group_name` came from the engagements.group_name
-- TEXT column — a snapshot copied once at creation from the consultant's
-- then-current team (00066 + engagement-create-dialog). When a user was later
-- removed from a team (profiles.team_id → NULL), that snapshot was never
-- refreshed, so the project/bokslut card kept showing — and stayed filterable
-- by — the old team.
--
-- This redefines `group_name` in the read model to be derived LIVE from the
-- main consultant's current team:
--     consultant_id → profiles.team_id → teams.name
-- falling back to the customer's office when the consultant has no team (mirrors
-- the original create-time default). No stored snapshot is read, so removing a
-- user from a team immediately drops the old team from their cards and from the
-- board's group filter.
--
-- Only the `group_name` expression changes + one LEFT JOIN to teams is added;
-- every other column keeps its name, type, and position. The engagements
-- .group_name column is left intact (unused by the board now) so nothing else
-- breaks and the change is fully reversible.
--
-- security_invoker = on is preserved so RLS still evaluates as the caller.

CREATE OR REPLACE VIEW engagement_board
WITH (security_invoker = on) AS
SELECT
  e.id,
  e.customer_id,
  c.name AS customer_name,
  c.org_number,
  e.fiscal_year_end,
  e.consultant_id,
  p.full_name AS consultant_name,
  -- LIVE team of the main consultant, falling back to the customer's office.
  COALESCE(t.name, c.office) AS group_name,

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
  e.cleared_at,
  e.co_consultant_id,
  cop.full_name AS co_consultant_name
FROM engagements e
JOIN customers c ON c.id = e.customer_id
LEFT JOIN profiles p ON p.id = e.consultant_id
LEFT JOIN teams t ON t.id = p.team_id
LEFT JOIN profiles cop ON cop.id = e.co_consultant_id
LEFT JOIN engagement_statuses bs ON bs.id = e.bokslut_status_id
LEFT JOIN engagement_statuses isk ON isk.id = e.ink2_status_id;
