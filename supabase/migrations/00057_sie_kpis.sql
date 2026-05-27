-- SIE-derived financial KPIs.
--
-- One row per (customer, financial year, period, kpi_key). Computed from
-- sie_period_balances + sie_account_balances by the KPI engine in
-- src/lib/fortnox-sie/kpi-engine.ts.
--
-- Design notes:
--   * `period` is either 'YEAR' (full-year rollup) or 'YYYYMM' (monthly).
--     Same encoding as sie_period_balances, so monthly trends are a direct
--     join from this table back to the source balances if needed.
--   * `kpi_key` is the stable identifier used by the engine + the UI
--     (e.g. 'revenue', 'gross_margin_pct', 'ebit', 'kassalikviditet',
--     'soliditet'). The user-facing names live in i18n; this column stays
--     stable across locales.
--   * `value` is numeric(18,4) — wider than the (18,2) used for raw money
--     because some KPIs are ratios/percentages that benefit from a couple
--     of extra decimal places when stored.
--   * `flagged` is the precomputed "breaches its target" boolean. The UI
--     can render warning badges without re-evaluating the threshold.
--   * `target` is JSONB so the threshold logic (operator + value + unit)
--     is queryable without parsing strings. Shape: { op, value, unit }.
--   * `inputs` is a small JSONB blob of the sub-totals that fed into the
--     calculation (e.g. { numerator: 1234.56, denominator: 678.90 }). Lets
--     the detail page show "why this number" without re-running the engine.
--   * RLS mirrors the rest of the SIE pipeline — admin-only writes; reads
--     gated by the same `customers` scope used elsewhere, so consultants
--     can see KPIs for the customers in their portfolio.

CREATE TABLE IF NOT EXISTS sie_kpis (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

  -- Year the value belongs to (matches sie_imports.financial_year_from).
  financial_year_from DATE NOT NULL,

  -- 'YEAR' for the full-year rollup, 'YYYYMM' for a single month.
  period TEXT NOT NULL CHECK (period = 'YEAR' OR period ~ '^\d{6}$'),

  -- Stable engine-side identifier. Lowercase snake_case.
  kpi_key TEXT NOT NULL,

  -- Computed value. NULL means "couldn't compute" (e.g. denominator was
  -- zero, or an account interval had no rows in this customer's chart).
  -- The detail page can surface "—" for these without misrepresenting
  -- the underlying data as zero.
  value NUMERIC(18, 4),

  -- 'kr', '%', 'ratio', etc. Mirrors the unit advertised in the KPI
  -- definition so the formatter doesn't have to look it up.
  unit TEXT,

  -- Whether the engine's target rule was breached. Always non-null —
  -- a KPI without a target rule is stored as flagged=false.
  flagged BOOLEAN NOT NULL DEFAULT false,

  -- Threshold rule snapshot at compute time, so the UI can show the
  -- target alongside the value without referencing the engine.
  -- Shape: { "op": "gte"|"gt"|"lte"|"lt", "value": number, "unit": text }
  target JSONB,

  -- Numerator / denominator / intermediate sums. Useful for the detail
  -- page's "why this number" explainer. Shape varies per KPI.
  inputs JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- When the engine last wrote this row.
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One canonical row per (customer, year, period, kpi). A re-run UPDATES
-- the existing row rather than appending duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sie_kpis_unique
  ON sie_kpis(customer_id, financial_year_from, period, kpi_key);

-- Hot path for the overview page: "current year's YEAR-period KPIs for
-- every synced customer".
CREATE INDEX IF NOT EXISTS idx_sie_kpis_overview
  ON sie_kpis(financial_year_from, period, kpi_key)
  WHERE period = 'YEAR';

-- Hot path for the detail page: monthly trend of one KPI for one customer.
CREATE INDEX IF NOT EXISTS idx_sie_kpis_detail
  ON sie_kpis(customer_id, kpi_key, financial_year_from, period);

-- Flagged-only filter on the overview ("show me everyone tripping a target").
CREATE INDEX IF NOT EXISTS idx_sie_kpis_flagged
  ON sie_kpis(financial_year_from, flagged)
  WHERE flagged = true AND period = 'YEAR';

DROP TRIGGER IF EXISTS sie_kpis_set_updated_at ON sie_kpis;
CREATE TRIGGER sie_kpis_set_updated_at
  BEFORE UPDATE ON sie_kpis
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE sie_kpis ENABLE ROW LEVEL SECURITY;

-- Reads: anyone with the `customers` scope (consultants see their portfolio).
-- The Nyckeltal page joins via customer_id, so portfolio filtering happens
-- naturally on the customers table — this policy just opens the door.
DROP POLICY IF EXISTS sie_kpis_select ON sie_kpis;
CREATE POLICY sie_kpis_select ON sie_kpis
  FOR SELECT
  TO authenticated
  USING (has_scope('customers'));

-- Writes: admin-only. The engine runs in an admin context (service-role
-- client), bypassing RLS — but we still lock down ad-hoc writes from the
-- normal authenticated path.
DROP POLICY IF EXISTS sie_kpis_admin_write ON sie_kpis;
CREATE POLICY sie_kpis_admin_write ON sie_kpis
  FOR ALL
  TO authenticated
  USING (get_user_role() = 'admin')
  WITH CHECK (get_user_role() = 'admin');
