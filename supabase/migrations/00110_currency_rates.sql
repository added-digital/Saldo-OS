-- =====================================================
-- Migration 00110: Exchange rates for foreign-currency invoicing
-- =====================================================
-- A handful of customers (PricewaterhouseCoopers Tax & Legal S.L., IBAGAR
-- Consulting S.L.) are invoiced in EUR. Fortnox stores those totals in the
-- invoice currency and stamps `invoices.currency_code` correctly — but the KPI
-- rollup summed `total_ex_vat` regardless of currency, so "2 250 EUR" counted
-- as "2 250 SEK" and those customers reported roughly tenfold low.
--
-- This migration adds ONE table and changes nothing else. No column is added to
-- `invoices`, `contract_accruals` or `customers`, and no existing row is
-- rewritten. The conversion happens in the KPI rollup (sync-generate-kpis and
-- the sync-invoices/sync-contracts finalize phases), which reads the invoice
-- currency that is already there and multiplies by the rate below.
--
-- `customer_kpis` and `customers.total_turnover` are derived: every sync
-- deletes and rebuilds them from `invoices`. So a wrong rate is never a data
-- loss — fix the rate, rerun the KPI regeneration, and the numbers are right
-- again. The invoices themselves are only ever read.

CREATE TABLE IF NOT EXISTS currency_rates (
  code TEXT PRIMARY KEY CHECK (code ~ '^[A-Z]{3}$'),
  rate_to_sek NUMERIC(18, 8) NOT NULL CHECK (rate_to_sek > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE currency_rates IS
  'SEK per 1 unit of each invoicing currency, used by the KPI rollup to express foreign-currency invoices in kronor. Editable by admins; unknown currencies fall back to 1.';

ALTER TABLE currency_rates ENABLE ROW LEVEL SECURITY;

-- Everyone signed in may read: any amount shown in kronor depends on these.
DROP POLICY IF EXISTS currency_rates_select ON currency_rates;
CREATE POLICY currency_rates_select
  ON currency_rates FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- Admin-only writes: a rate edit moves every reported figure for that currency.
DROP POLICY IF EXISTS currency_rates_manage ON currency_rates;
CREATE POLICY currency_rates_manage
  ON currency_rates FOR ALL
  USING (get_user_role() = 'admin')
  WITH CHECK (get_user_role() = 'admin');

DROP TRIGGER IF EXISTS set_updated_at ON currency_rates;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON currency_rates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- EUR is the only foreign currency in the invoice data today. SEK is listed for
-- completeness so the table reads as the full picture rather than a special
-- case. ON CONFLICT DO NOTHING keeps a re-run from stomping an edited rate.
INSERT INTO currency_rates (code, rate_to_sek) VALUES
  ('SEK', 1),
  ('EUR', 11.30)
ON CONFLICT (code) DO NOTHING;
