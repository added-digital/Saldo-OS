-- =====================================================================
-- Migration 00083: engagement_board resolves consultant + group LIVE
-- =====================================================================
-- Extends 00082 (which made `group_name` live from the consultant's team).
-- Problem it fixes: the card's consultant (kundansvarig) was the STORED
-- engagements.consultant_id, frozen at creation. If a customer had no manager
-- when the card was made — or the manager later changed in Fortnox — the card
-- never caught up (e.g. customer "Johansson & Alm" had cost center 90 / Romil
-- Poli, but the card stayed empty because consultant_id was null).
--
-- This view now derives, on every read:
--   • consultant  — the active profile whose fortnox_cost_center matches the
--                   customer's fortnox_cost_center (the kundansvarig link).
--   • group_name  — that live consultant's current team (teams.name), falling
--                   back to the customer's office.
-- so any backend change — manager reassigned, consultant moved to another team,
-- a customer's cost center updated by a Fortnox sync — shows on the bokslut
-- board immediately, with nothing to backfill.
--
-- The stored engagements.consultant_id column is left intact but is no longer
-- read here (kept for history / easy revert). The manually-assigned
-- co_consultant_id stays a stored value — it is a deliberate second helper,
-- not something derived from the customer.
--
-- Single-manager guarantee: the lookup is a LEFT JOIN LATERAL ... LIMIT 1, so
-- even if two active profiles ever share one cost center, each engagement still
-- yields exactly ONE board row (no duplicate cards). security_invoker = on is
-- preserved so RLS still evaluates as the calling user.

CREATE OR REPLACE VIEW engagement_board
WITH (security_invoker = on) AS
SELECT
  e.id,
  e.customer_id,
  c.name AS customer_name,
  c.org_number,
  e.fiscal_year_end,
  -- LIVE kundansvarig: the active profile owning the customer's cost center.
  mgr.id        AS consultant_id,
  mgr.full_name AS consultant_name,
  -- LIVE group: that consultant's current team, falling back to customer office.
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
  e.cleared_at,
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
