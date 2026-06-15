-- =====================================================================
-- Migration 00074: Harden sync_customer_total_hours() against timeouts
-- =====================================================================
-- The nightly Time Reports step calls sync_customer_total_hours() after
-- ingesting time entries. As time_reports grew, the two set-based GROUP BY
-- aggregates started exceeding the session statement_timeout, e.g.:
--
--   "Failed to update customer total_hours: canceling statement due to
--    statement timeout"  (nightly-sync 2026-06-13)
--
-- Because the nightly chain is sequential, that failure cancels every
-- downstream step (Contracts, Articles, Generate KPIs, SIE, SIE Nyckeltal),
-- so a slow rollup takes out the whole night's sync.
--
-- Fix:
--   1. Give the function its own generous statement_timeout (function-local
--      SET overrides the short API/session default during execution).
--   2. Add partial indexes that directly serve the two aggregates so the
--      rollup stays fast as the table grows (treats the cause, not just the
--      symptom).
-- Body is unchanged from 00055.

-- ---------- Supporting partial indexes ----------
CREATE INDEX IF NOT EXISTS idx_time_reports_th_customer_id
  ON time_reports (customer_id)
  WHERE entry_type = 'time' AND customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_time_reports_th_fortnox_number
  ON time_reports (fortnox_customer_number)
  WHERE entry_type = 'time' AND customer_id IS NULL AND fortnox_customer_number IS NOT NULL;

-- ---------- Function with its own timeout ----------
CREATE OR REPLACE FUNCTION public.sync_customer_total_hours()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '180s'
AS $$
BEGIN
  -- Customers that have direct customer_id matches on their time entries.
  UPDATE customers c
  SET total_hours = sub.total_hours
  FROM (
    SELECT customer_id, SUM(hours) AS total_hours
    FROM time_reports
    WHERE entry_type = 'time'
      AND customer_id IS NOT NULL
    GROUP BY customer_id
  ) sub
  WHERE c.id = sub.customer_id;

  -- Customers reached only via fortnox_customer_number (rows that didn't
  -- resolve to a customer_id during sync).
  UPDATE customers c
  SET total_hours = sub.total_hours
  FROM (
    SELECT fortnox_customer_number, SUM(hours) AS total_hours
    FROM time_reports
    WHERE entry_type = 'time'
      AND customer_id IS NULL
      AND fortnox_customer_number IS NOT NULL
    GROUP BY fortnox_customer_number
  ) sub
  WHERE c.fortnox_customer_number = sub.fortnox_customer_number;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_customer_total_hours() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sync_customer_total_hours() TO service_role;
