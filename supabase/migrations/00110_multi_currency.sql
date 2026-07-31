-- =====================================================
-- Migration 00110: Multi-currency amounts
-- =====================================================
-- Some customers (international ones, e.g. PricewaterhouseCoopers Tax & Legal
-- S.L.) are invoiced in EUR. Fortnox stores those invoice totals in the invoice
-- currency, and the sync copied them into `invoices.total*` verbatim while
-- `currency_code` was written but never read by any aggregation. Every KPI
-- (Omsättning, Avtalsvärde/ARR, omsättning/timme, churn) therefore summed
-- "2 250 EUR" as if it were "2 250 SEK" — roughly a 10x understatement per row.
--
-- The fix keeps the invoiced amount exactly as invoiced and adds a SEK
-- projection next to it:
--
--   total, total_ex_vat, balance   → untouched, in `currency_code`
--   currency_rate                  → SEK per 1 unit of `currency_code`
--   *_sek                          → GENERATED columns, amount × rate
--
-- Aggregations read the `_sek` columns; detail views keep showing the original
-- amount plus its currency. Because the rate lives on the row, a historical
-- invoice keeps the rate it was booked at — changing today's EUR rate does not
-- silently rewrite last year's turnover.
--
-- Rate precedence (highest first):
--   1. `fortnox`  — CurrencyRate/CurrencyUnit off the Fortnox invoice itself.
--                   This is the rate the invoice was actually booked at, so the
--                   CRM matches the accounting to the öre.
--   2. `manual`   — a rate typed on the row by a user.
--   3. `table`    — today's rate from `currency_rates`. Used for rows Fortnox
--                   gives no rate for (contracts) and as a stopgap until an
--                   invoice's detail fetch fills in the real one.
--
-- Only `table`-sourced rows are re-stamped when `currency_rates` changes.

-- -----------------------------------------------------
-- 1. Rate table
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS currency_rates (
  code TEXT PRIMARY KEY,
  rate_to_sek NUMERIC(18, 8) NOT NULL CHECK (rate_to_sek > 0),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON COLUMN currency_rates.rate_to_sek IS
  'SEK per 1 unit of `code`. EUR 11.30 means 1 EUR = 11.30 SEK. SEK itself is 1.';

ALTER TABLE currency_rates ENABLE ROW LEVEL SECURITY;

-- Every authenticated user reads rates (they are needed to render any amount).
DROP POLICY IF EXISTS currency_rates_select ON currency_rates;
CREATE POLICY currency_rates_select
  ON currency_rates FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- Only admins change them: a rate edit moves every reported figure.
DROP POLICY IF EXISTS currency_rates_manage ON currency_rates;
CREATE POLICY currency_rates_manage
  ON currency_rates FOR ALL
  USING (get_user_role() = 'admin')
  WITH CHECK (get_user_role() = 'admin');

-- Seed values are deliberately rough starting points, not live quotes — an
-- admin corrects them in Inställningar. ON CONFLICT DO NOTHING keeps a re-run
-- of this migration from stomping edited rates.
INSERT INTO currency_rates (code, rate_to_sek) VALUES
  ('SEK', 1),
  ('EUR', 11.30),
  ('USD', 10.50),
  ('GBP', 13.30),
  ('NOK', 0.95),
  ('DKK', 1.51),
  ('CHF', 11.80)
ON CONFLICT (code) DO NOTHING;

-- SEK must stay 1: it is the reporting currency, not a convertible one.
CREATE OR REPLACE FUNCTION currency_rates_guard_sek()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.code = 'SEK' AND NEW.rate_to_sek <> 1 THEN
    RAISE EXCEPTION 'SEK is the reporting currency; its rate is always 1';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS currency_rates_guard_sek ON currency_rates;
CREATE TRIGGER currency_rates_guard_sek
  BEFORE INSERT OR UPDATE ON currency_rates
  FOR EACH ROW EXECUTE FUNCTION currency_rates_guard_sek();

-- -----------------------------------------------------
-- 2. Rate resolution
-- -----------------------------------------------------
-- Unknown/NULL currency codes resolve to 1 rather than NULL: an unmapped
-- currency then reports at face value (visibly wrong, and flagged in the UI)
-- instead of turning the row's contribution into NULL and poisoning a SUM.
CREATE OR REPLACE FUNCTION resolve_currency_rate(code TEXT)
RETURNS NUMERIC
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT rate_to_sek FROM currency_rates r WHERE r.code = UPPER(TRIM(code))),
    1
  );
$$;

REVOKE ALL ON FUNCTION public.resolve_currency_rate(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_currency_rate(TEXT) TO authenticated, service_role;

-- -----------------------------------------------------
-- 3. Invoices
-- -----------------------------------------------------
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS currency_rate NUMERIC(18, 8),
  ADD COLUMN IF NOT EXISTS currency_rate_source TEXT
    CHECK (currency_rate_source IN ('fortnox', 'manual', 'table'));

COMMENT ON COLUMN invoices.currency_rate IS
  'SEK per 1 unit of currency_code, frozen at the rate this invoice was booked at.';

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS total_sek NUMERIC(14, 2)
    GENERATED ALWAYS AS (ROUND(total * COALESCE(currency_rate, 1), 2)) STORED,
  ADD COLUMN IF NOT EXISTS total_ex_vat_sek NUMERIC(14, 2)
    GENERATED ALWAYS AS (ROUND(total_ex_vat * COALESCE(currency_rate, 1), 2)) STORED,
  ADD COLUMN IF NOT EXISTS balance_sek NUMERIC(14, 2)
    GENERATED ALWAYS AS (ROUND(balance * COALESCE(currency_rate, 1), 2)) STORED;

-- -----------------------------------------------------
-- 4. Contract accruals (Avtalsvärde / ARR)
-- -----------------------------------------------------
ALTER TABLE contract_accruals
  ADD COLUMN IF NOT EXISTS currency_rate NUMERIC(18, 8),
  ADD COLUMN IF NOT EXISTS currency_rate_source TEXT
    CHECK (currency_rate_source IN ('fortnox', 'manual', 'table'));

ALTER TABLE contract_accruals
  ADD COLUMN IF NOT EXISTS total_sek NUMERIC(14, 2)
    GENERATED ALWAYS AS (ROUND(total * COALESCE(currency_rate, 1), 2)) STORED,
  ADD COLUMN IF NOT EXISTS total_ex_vat_sek NUMERIC(14, 2)
    GENERATED ALWAYS AS (ROUND(total_ex_vat * COALESCE(currency_rate, 1), 2)) STORED;

-- -----------------------------------------------------
-- 5. Customer default currency
-- -----------------------------------------------------
-- What the customer is normally invoiced in. Fortnox is the source of truth per
-- document, so this is a display hint and the fallback for rows that arrive
-- without a currency of their own (older contracts, manual entries).
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS default_currency TEXT NOT NULL DEFAULT 'SEK';

ALTER TABLE customers
  DROP CONSTRAINT IF EXISTS customers_default_currency_format;
ALTER TABLE customers
  ADD CONSTRAINT customers_default_currency_format
    CHECK (default_currency ~ '^[A-Z]{3}$');

-- -----------------------------------------------------
-- 6. Auto-stamp the rate on write
-- -----------------------------------------------------
-- Belt and braces: even if a sync path forgets to send a rate, no row can land
-- with a NULL rate and silently report a EUR amount as SEK.
CREATE OR REPLACE FUNCTION stamp_currency_rate()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.currency_code := COALESCE(NULLIF(UPPER(TRIM(NEW.currency_code)), ''), 'SEK');

  -- A re-sync upserts the whole row from Fortnox's invoice LIST, which carries
  -- no CurrencyRate. Without this the row would lose the booked rate the detail
  -- pass had already filled in and silently fall back to today's table rate —
  -- and finalized invoices are skipped by the detail pass, so it would never
  -- come back. Keep the booked rate unless the currency itself changed.
  --
  -- OLD is only touchable under TG_OP = 'UPDATE'; on INSERT it is unassigned
  -- and any reference raises. SQL does not promise short-circuit evaluation of
  -- AND, so the TG_OP test has to be its own enclosing IF rather than another
  -- conjunct beside OLD.
  IF TG_OP = 'UPDATE' THEN
    IF NEW.currency_rate IS NULL
       AND OLD.currency_rate_source = 'fortnox'
       AND OLD.currency_code = NEW.currency_code
    THEN
      NEW.currency_rate := OLD.currency_rate;
      NEW.currency_rate_source := 'fortnox';
      RETURN NEW;
    END IF;
  END IF;

  IF NEW.currency_rate IS NULL OR NEW.currency_rate <= 0 THEN
    NEW.currency_rate := resolve_currency_rate(NEW.currency_code);
    NEW.currency_rate_source := 'table';
  ELSIF NEW.currency_rate_source IS NULL THEN
    NEW.currency_rate_source := 'table';
  END IF;

  -- SEK rows never carry a rate other than 1, whatever the caller sends.
  IF NEW.currency_code = 'SEK' THEN
    NEW.currency_rate := 1;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.stamp_currency_rate() FROM PUBLIC;

DROP TRIGGER IF EXISTS stamp_currency_rate ON invoices;
CREATE TRIGGER stamp_currency_rate
  BEFORE INSERT OR UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION stamp_currency_rate();

DROP TRIGGER IF EXISTS stamp_currency_rate ON contract_accruals;
CREATE TRIGGER stamp_currency_rate
  BEFORE INSERT OR UPDATE ON contract_accruals
  FOR EACH ROW EXECUTE FUNCTION stamp_currency_rate();

-- -----------------------------------------------------
-- 7. Re-stamp table-sourced rows when a rate is edited
-- -----------------------------------------------------
-- Rows whose rate came from Fortnox (or was typed by hand) are left alone; only
-- the ones that borrowed today's table rate follow the table.
CREATE OR REPLACE FUNCTION restamp_currency_rate_rows()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.rate_to_sek = OLD.rate_to_sek THEN
    RETURN NEW;
  END IF;

  UPDATE invoices
    SET currency_rate = NEW.rate_to_sek
    WHERE currency_code = NEW.code
      AND COALESCE(currency_rate_source, 'table') = 'table'
      AND currency_rate IS DISTINCT FROM NEW.rate_to_sek;

  UPDATE contract_accruals
    SET currency_rate = NEW.rate_to_sek
    WHERE currency_code = NEW.code
      AND COALESCE(currency_rate_source, 'table') = 'table'
      AND currency_rate IS DISTINCT FROM NEW.rate_to_sek;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.restamp_currency_rate_rows() FROM PUBLIC;

DROP TRIGGER IF EXISTS restamp_currency_rate_rows ON currency_rates;
CREATE TRIGGER restamp_currency_rate_rows
  AFTER INSERT OR UPDATE ON currency_rates
  FOR EACH ROW EXECUTE FUNCTION restamp_currency_rate_rows();

-- -----------------------------------------------------
-- 8. Backfill existing rows
-- -----------------------------------------------------
-- Existing foreign-currency rows get today's table rate as source 'table'. The
-- next invoice sync replaces them with the booked Fortnox rate (source
-- 'fortnox'), which is why the KPI rebuild below is a follow-up step, not part
-- of this migration.
UPDATE invoices
  SET currency_rate = resolve_currency_rate(currency_code),
      currency_rate_source = 'table'
  WHERE currency_rate IS NULL;

UPDATE contract_accruals
  SET currency_rate = resolve_currency_rate(currency_code),
      currency_rate_source = 'table'
  WHERE currency_rate IS NULL;

-- Mirror Fortnox's per-document currency onto the customer as its default, so
-- the customer card opens on the currency that customer is actually billed in.
UPDATE customers c
  SET default_currency = sub.currency_code
  FROM (
    SELECT DISTINCT ON (fortnox_customer_number)
      fortnox_customer_number,
      UPPER(TRIM(currency_code)) AS currency_code
    FROM invoices
    WHERE fortnox_customer_number IS NOT NULL
      AND currency_code IS NOT NULL
      AND UPPER(TRIM(currency_code)) <> 'SEK'
    ORDER BY fortnox_customer_number, invoice_date DESC NULLS LAST
  ) sub
  WHERE c.fortnox_customer_number = sub.fortnox_customer_number
    AND c.default_currency = 'SEK'
    AND sub.currency_code ~ '^[A-Z]{3}$';

CREATE INDEX IF NOT EXISTS idx_invoices_currency
  ON invoices(currency_code) WHERE currency_code <> 'SEK';
CREATE INDEX IF NOT EXISTS idx_contract_accruals_currency
  ON contract_accruals(currency_code) WHERE currency_code <> 'SEK';
