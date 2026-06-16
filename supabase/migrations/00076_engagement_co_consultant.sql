-- =====================================================================
-- Migration 00076: Engagement co-consultant (second assignee)
-- =====================================================================
-- Adds an optional second person to an engagement so a project can be shared
-- by two consultants and appear in both their scoped board views.

ALTER TABLE engagements
  ADD COLUMN IF NOT EXISTS co_consultant_id UUID REFERENCES profiles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_engagements_co_consultant
  ON engagements(co_consultant_id)
  WHERE co_consultant_id IS NOT NULL;

-- Expose the co-consultant (+ name) on the board read model. CREATE OR REPLACE
-- appends trailing columns and adds one more LEFT JOIN; existing columns are
-- unchanged and in the same order.
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
  e.group_name,

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
LEFT JOIN profiles cop ON cop.id = e.co_consultant_id
LEFT JOIN engagement_statuses bs ON bs.id = e.bokslut_status_id
LEFT JOIN engagement_statuses isk ON isk.id = e.ink2_status_id;
