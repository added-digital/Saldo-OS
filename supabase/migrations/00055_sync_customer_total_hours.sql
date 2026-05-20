-- Server-side aggregation+update of customers.total_hours from time_reports.
--
-- Replaces an edge-function loop that was doing ~700 individual UPDATEs
-- after each Time Reports sync. That loop blew Supabase's per-invocation
-- CPU budget (WORKER_RESOURCE_LIMIT) once the table grew large.
--
-- This function does the entire job in two set-based UPDATEs, fully inside
-- Postgres — the edge function just makes a single RPC call.

CREATE OR REPLACE FUNCTION public.sync_customer_total_hours()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
  -- resolve to a customer_id during sync — typically because the customer
  -- record exists but the foreign key didn't get filled in).
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
