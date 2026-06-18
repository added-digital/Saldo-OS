-- =====================================================================
-- Migration 00079: Räkenskapsår (financial year) on the customer card
-- =====================================================================
-- Adds a customer-level financial year, split by source so the precedence
-- rules are STRUCTURAL, not just disciplined:
--
--   *_sie     — written ONLY by the SIE sync (trigger below). Authoritative.
--   *_manual  — written ONLY by the UI / seed. Hand-entered fallback.
--   effective (financial_year_from / _to) — generated COALESCE(_sie, _manual),
--               so SIE always wins and the sync can never touch _manual.
--
-- Precedence:
--   • SIE wins for connected customers, refreshed on every successful sync.
--   • Manual applies only where there's no SIE value, and is physically
--     unreachable by the sync (separate columns).
--   • A failed/org-mismatch import can never reach the field — the trigger
--     fires only on import_status = 'success' (equality, never negation, so
--     the org_mismatch + error placeholders are excluded).
--
-- "Latest räkenskapsår" = MAX(financial_year_from) among the customer's
-- successful imports (sie_imports keeps only #RAR 0 per sie_type, accumulating
-- across years).

-- ---------------------------------------------------------------------
-- 1. Schema: source columns + generated effective columns
-- ---------------------------------------------------------------------
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS financial_year_from_sie    DATE,
  ADD COLUMN IF NOT EXISTS financial_year_to_sie      DATE,
  ADD COLUMN IF NOT EXISTS financial_year_from_manual DATE,
  ADD COLUMN IF NOT EXISTS financial_year_to_manual   DATE;

-- Effective value = SIE if present, else manual. Generated/STORED so it's
-- always consistent and read-only; reads (card, engagement default) use these.
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS financial_year_from DATE
    GENERATED ALWAYS AS (COALESCE(financial_year_from_sie, financial_year_from_manual)) STORED,
  ADD COLUMN IF NOT EXISTS financial_year_to DATE
    GENERATED ALWAYS AS (COALESCE(financial_year_to_sie, financial_year_to_manual)) STORED;

-- ---------------------------------------------------------------------
-- 2. Populate-on-sync: trigger on sie_imports (success only)
-- ---------------------------------------------------------------------
-- Recomputes the customer's _sie columns to the LATEST successful import.
-- WHEN (import_status = 'success') is the safety gate: error/org_mismatch
-- placeholders never invoke this, so a bad import can't blank a good value.
CREATE OR REPLACE FUNCTION sync_customer_financial_year_from_sie()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE customers c
  SET financial_year_from_sie = latest.financial_year_from,
      financial_year_to_sie   = latest.financial_year_to,
      updated_at = now()
  FROM (
    SELECT financial_year_from, financial_year_to
    FROM sie_imports
    WHERE customer_id = NEW.customer_id
      AND import_status = 'success'
    ORDER BY financial_year_from DESC
    LIMIT 1
  ) latest
  WHERE c.id = NEW.customer_id;
  RETURN NULL; -- AFTER trigger
END
$$;

DROP TRIGGER IF EXISTS trg_customer_financial_year ON sie_imports;
CREATE TRIGGER trg_customer_financial_year
  AFTER INSERT OR UPDATE ON sie_imports
  FOR EACH ROW
  WHEN (NEW.import_status = 'success')
  EXECUTE FUNCTION sync_customer_financial_year_from_sie();

-- ---------------------------------------------------------------------
-- 5a. BACKFILL — SIE  (→ _sie columns, source: sie_imports)
-- ---------------------------------------------------------------------
-- One-time populate for already-connected customers (the 6) so they don't
-- wait for the next nightly sync. Same latest-wins rule as the trigger.
-- Idempotent: re-running recomputes to the same latest value.
UPDATE customers c
SET financial_year_from_sie = latest.financial_year_from,
    financial_year_to_sie   = latest.financial_year_to,
    updated_at = now()
FROM (
  SELECT DISTINCT ON (customer_id)
         customer_id, financial_year_from, financial_year_to
  FROM sie_imports
  WHERE import_status = 'success'
  ORDER BY customer_id, financial_year_from DESC
) latest
WHERE c.id = latest.customer_id;

-- ---------------------------------------------------------------------
-- 5b. BACKFILL — manual seed  (→ _manual columns, source: engagements)
-- ---------------------------------------------------------------------
-- Seed the hand-entered fallback from each customer's latest engagement
-- fiscal_year_end (the Excel-imported räkenskapsår). Engagements carry only
-- the year-END date, and per the client the end date alone is enough for the
-- bokslut cards — some companies have shortened/extended years, so we do NOT
-- guess a start date. financial_year_from_manual stays NULL; it fills in
-- automatically (start + end) the day a company connects SIE, and COALESCE
-- lets SIE win. Writes _manual ONLY (never _sie); guarded so it never
-- overwrites an existing manual end value (re-run safe).
UPDATE customers c
SET financial_year_to_manual = latest.fye,
    updated_at = now()
FROM (
  SELECT DISTINCT ON (customer_id) customer_id, fiscal_year_end AS fye
  FROM engagements
  WHERE fiscal_year_end IS NOT NULL
  ORDER BY customer_id, fiscal_year_end DESC
) latest
WHERE c.id = latest.customer_id
  AND c.financial_year_to_manual IS NULL;
