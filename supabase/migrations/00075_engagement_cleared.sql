-- =====================================================================
-- Migration 00075: Engagement "cleared from board" flag
-- =====================================================================
-- Lets a consultant tick a finished engagement (typically one that's
-- "Registrerad hos Bolagsverket") as cleared, hiding it from the board for
-- visual focus. It's not a delete — cleared_at is a timestamp that the board
-- filters on, and the card can be restored (cleared_at = NULL).

ALTER TABLE engagements
  ADD COLUMN IF NOT EXISTS cleared_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_engagements_cleared_at
  ON engagements(cleared_at)
  WHERE cleared_at IS NOT NULL;

-- Expose cleared_at on the board read model. CREATE OR REPLACE is allowed here
-- because we only APPEND a trailing column to the existing view definition
-- (00069); column order/names above are unchanged.
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
  e.cleared_at
FROM engagements e
JOIN customers c ON c.id = e.customer_id
LEFT JOIN profiles p ON p.id = e.consultant_id
LEFT JOIN engagement_statuses bs ON bs.id = e.bokslut_status_id
LEFT JOIN engagement_statuses isk ON isk.id = e.ink2_status_id;
