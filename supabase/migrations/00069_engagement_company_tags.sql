-- =====================================================
-- Migration 00069: Holdingbolag + Revisor as durable customer tags
-- =====================================================
--
-- These two Excel columns (Holdingbolag Ja/Nej, Revisor Ja/Nej) are durable
-- facts about the company, not per-year close progress. They were modelled as
-- engagement columns (is_holding / has_auditor) that nothing in the UI ever
-- set. Move them into the customer-scope checklist so they live on the customer
-- card alongside the other segmentation tags, and drop the dead columns.
--
-- The board view also starts exposing the customer's setup map so cards can
-- show e.g. a "Holding" badge from the real source.

-- 1. Add the two tags to the customer-scope checklist (new "Bolag" group).
UPDATE engagement_config
SET checklist_fields = '[
  {"key": "kundfakt",        "label": "Kundfakt",              "group": "Underlag",     "scope": "engagement"},
  {"key": "levfakt",         "label": "Levfakt",               "group": "Underlag",     "scope": "engagement"},
  {"key": "kvitton",         "label": "Kvitton",               "group": "Underlag",     "scope": "engagement"},
  {"key": "lon",             "label": "Lön",                   "group": "Underlag",     "scope": "engagement"},
  {"key": "transaktioner",   "label": "Transaktioner",         "group": "Underlag",     "scope": "engagement"},
  {"key": "holdingbolag",    "label": "Holdingbolag",          "group": "Bolag",        "scope": "customer"},
  {"key": "revisor",         "label": "Revisor",               "group": "Bolag",        "scope": "customer"},
  {"key": "reda",            "label": "Reda",                  "group": "System",       "scope": "customer"},
  {"key": "mynt",            "label": "Mynt",                  "group": "System",       "scope": "customer"},
  {"key": "bankkoppling",    "label": "Bankkoppling",          "group": "System",       "scope": "customer"},
  {"key": "a_bank",          "label": "A Bank",                "group": "Behörighet",   "scope": "customer"},
  {"key": "a_skv",           "label": "A SKV",                 "group": "Behörighet",   "scope": "customer"},
  {"key": "k_bank",          "label": "K Bank",                "group": "Behörighet",   "scope": "customer"},
  {"key": "k_skv",           "label": "K SKV",                 "group": "Behörighet",   "scope": "customer"},
  {"key": "capego_fokus_gl", "label": "Capego Fokus + GL",     "group": "Behörighet",   "scope": "customer"},
  {"key": "fortnox_behoriga","label": "Fortnox alla behöriga", "group": "Behörighet",   "scope": "customer"},
  {"key": "saldoavtal",      "label": "Saldoavtal",            "group": "Avtal",        "scope": "customer"},
  {"key": "aktiebok",        "label": "Aktiebok",              "group": "Avtal",        "scope": "customer"}
]'::jsonb
WHERE id = 1;

-- 2. Recreate the board view without the dead columns and with the customer
--    setup map (the view must be dropped before the columns it references).
DROP VIEW IF EXISTS engagement_board;

ALTER TABLE engagements DROP COLUMN IF EXISTS is_holding;
ALTER TABLE engagements DROP COLUMN IF EXISTS has_auditor;

CREATE VIEW engagement_board
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
  -- Durable customer tags (Holdingbolag, Revisor, …) for at-a-glance badges.
  c.bokslut_setup AS customer_setup,
  e.created_at,
  e.updated_at
FROM engagements e
JOIN customers c ON c.id = e.customer_id
LEFT JOIN profiles p ON p.id = e.consultant_id
LEFT JOIN engagement_statuses bs ON bs.id = e.bokslut_status_id
LEFT JOIN engagement_statuses isk ON isk.id = e.ink2_status_id;
