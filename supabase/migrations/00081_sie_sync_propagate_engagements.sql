-- =====================================================================
-- Migration 00081: SIE sync also propagates räkenskapsår to project cards
-- =====================================================================
-- Extends the sie_imports trigger (00079) so a successful sync, after writing
-- the customer's *_sie räkenskapsår, also pushes that year-end's MONTH-DAY onto
-- the customer's engagements (reusing the 00080 RPC) — keeping each
-- engagement's cycle YEAR. Calendar customers: no-op; non-calendar customers:
-- their project cards auto-correct.
--
-- Still gated by WHEN (import_status = 'success') on the trigger, so error /
-- org_mismatch imports never touch anything. Only the month-day changes —
-- never the year, status, or other engagement fields.

CREATE OR REPLACE FUNCTION sync_customer_financial_year_from_sie()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Latest successful räkenskapsår → customer's _sie columns.
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

  -- Propagate the (now-updated) effective year-end's month-day to this
  -- customer's engagements, keeping each engagement's cycle year.
  PERFORM public.propagate_customer_financial_year(NEW.customer_id);

  RETURN NULL; -- AFTER trigger
END
$$;
