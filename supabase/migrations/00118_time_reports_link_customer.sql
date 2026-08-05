-- 00118: always give a time report its customer_id.
--
-- A card on the beläggning board could read "Ingen historik" while showing
-- estimated hours. Both numbers were computed from the same time reports, but
-- resolved to a customer by two different rules:
--
--   • customer_kpis (the estimate) uses resolveCustomerRef in
--     sync-generate-kpis: customer_id first, then fortnox_customer_number.
--   • resource_board's history / scope / split / activity_source CTEs use
--     `WHERE tr.customer_id IS NOT NULL` with no fallback.
--
-- time_reports.customer_id is set at sync time as `matchedCustomer?.id ?? null`
-- (sync-time-reports/index.ts), so it is NULL whenever the match missed.
-- Migration 00018 backfilled once with a plain UPDATE — no trigger — so only
-- the rows that existed that day were ever linked. Every unmatched row since
-- has counted toward the estimate and not toward the history.
--
-- MATCHING RULE: customers.fortnox_customer_number, and nothing else. This
-- mirrors sync-time-reports exactly, which carries an explicit warning against
-- the cost-centre fallback: on v2 time rows `costCenter` is the EMPLOYEE's cost
-- centre, not the customer's, so archived customers sharing a cost centre with
-- an employee collected every unmatched entry that employee logged. Note that
-- 00018's backfill used precisely that rule
-- (tr.fortnox_customer_number = c.fortnox_cost_center); it is not repeated here.
--
-- Effect: labels and activity lists start agreeing with the hours. Estimates
-- themselves do not move — they already came from customer_kpis, which already
-- matched by number.

CREATE OR REPLACE FUNCTION time_reports_link_customer()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Only ever fills a blank. An existing customer_id is a decision made
  -- upstream by the sync and is not second-guessed here.
  IF NEW.customer_id IS NULL
     AND NULLIF(btrim(COALESCE(NEW.fortnox_customer_number, '')), '') IS NOT NULL
  THEN
    SELECT c.id
      INTO NEW.customer_id
      FROM customers c
     WHERE btrim(c.fortnox_customer_number) = btrim(NEW.fortnox_customer_number)
     LIMIT 1;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS link_customer ON time_reports;
CREATE TRIGGER link_customer
  BEFORE INSERT OR UPDATE ON time_reports
  FOR EACH ROW EXECUTE FUNCTION time_reports_link_customer();

-- Backfill everything the one-off UPDATE in 00018 never reached, under the
-- correct rule.
UPDATE time_reports tr
   SET customer_id = c.id
  FROM customers c
 WHERE tr.customer_id IS NULL
   AND NULLIF(btrim(COALESCE(tr.fortnox_customer_number, '')), '') IS NOT NULL
   AND btrim(c.fortnox_customer_number) = btrim(tr.fortnox_customer_number);
