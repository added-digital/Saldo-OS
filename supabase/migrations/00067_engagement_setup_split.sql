-- =====================================================
-- Migration 00067: Split engagement setup (durable vs per-year)
-- =====================================================
--
-- The Excel "Effektivitet" checklist mixed two lifetimes of facts:
--   • Durable client setup (permissions, system access, agreements) that is
--     true of the relationship and should carry across years.
--   • Per-year progress ("did we receive / book X for THIS close").
--
-- This migration:
--   1. Adds customers.bokslut_setup for the durable items (entered once).
--   2. Re-tags engagement_config.checklist_fields with a `scope`
--      (customer | engagement) so the UI knows where each item is stored.

-- -----------------------------------------------------------------------------
-- 1. Durable client setup lives on the customer
-- -----------------------------------------------------------------------------
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS bokslut_setup JSONB NOT NULL DEFAULT '{}'::jsonb;

-- -----------------------------------------------------------------------------
-- 2. Re-tag the checklist definition with scope
-- -----------------------------------------------------------------------------
-- scope: 'engagement' = answered per fiscal year (engagements.setup)
--        'customer'   = durable relationship fact (customers.bokslut_setup)
UPDATE engagement_config
SET checklist_fields = '[
  {"key": "kundfakt",        "label": "Kundfakt",              "group": "Underlag",     "scope": "engagement"},
  {"key": "levfakt",         "label": "Levfakt",               "group": "Underlag",     "scope": "engagement"},
  {"key": "kvitton",         "label": "Kvitton",               "group": "Underlag",     "scope": "engagement"},
  {"key": "lon",             "label": "Lön",                   "group": "Underlag",     "scope": "engagement"},
  {"key": "transaktioner",   "label": "Transaktioner",         "group": "Underlag",     "scope": "engagement"},
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
