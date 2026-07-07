-- =====================================================================
-- Migration 00094: Bolagsverket-confirmed annual-report registration
-- =====================================================================
-- Records, per bokslut card, WHEN Bolagsverket confirmed that the fiscal year's
-- annual report is registered. This is the trust signal behind the card badge:
-- a card can reach "Registrerad hos Bolagsverket" by a manual move OR by the
-- Bolagsverket sync, but only a BV-confirmed card gets the verified badge, so a
-- consultant knows the registration is real and not just someone's guess.
--
-- Written by src/lib/bolagsverket/enrich.ts (syncRegisteredAnnualReports) on a
-- confirmed name match. Null = Bolagsverket has not confirmed (yet).

ALTER TABLE engagements
  ADD COLUMN IF NOT EXISTS annual_report_registered_bv_at TIMESTAMPTZ;

-- ---------------------------------------------------------------------
-- Re-expose it on the board read model. Same definition as migration 00086
-- with the new column appended (CREATE OR REPLACE only allows additions at the
-- end).
-- ---------------------------------------------------------------------
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
  e.ink2_position,
  e.annual_report_registered_bv_at
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
