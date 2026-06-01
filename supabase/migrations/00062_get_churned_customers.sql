-- Drill-down companion to `get_churn_analysis`.
--
-- `get_churn_analysis` returns only the aggregate churn COUNT. When the user
-- actually wants to SEE which customers churned, this function returns the
-- list: customers that had revenue in period1 (the earlier baseline) but NOT
-- in period2 (the later comparison window).
--
-- Same churn definition and revenue basis as get_churn_analysis:
--   • "had revenue" in a window = SUM of invoiced amount in it is > 0.
--   • revenue is ex-VAT (`total_ex_vat`, fallback to VAT-inclusive `total`).
--   • invoices with a null customer_id are unattributable and excluded.
--
-- Per churned customer it returns:
--   customer_name          — from customers.name (joined on customer_id).
--   total_revenue_period1  — their summed ex-VAT revenue in period1 (2 dp).
--   last_invoice_date      — their most recent invoice date WITHIN period1
--                            (by definition they have no revenue in period2).
--
-- Ordered by period1 revenue descending and capped at 200 rows, so when the
-- list is truncated it's the largest lost customers that survive the cap.
--
-- SECURITY INVOKER (default) so the `invoices_select` / `customers_select` RLS
-- policies (both `has_scope('customers')`) still gate which rows the caller can
-- see — the list reflects only customers the caller is allowed to read.

CREATE OR REPLACE FUNCTION public.get_churned_customers(
  period1_start DATE,
  period1_end   DATE,
  period2_start DATE,
  period2_end   DATE
)
RETURNS TABLE (
  customer_name         TEXT,
  total_revenue_period1 NUMERIC,
  last_invoice_date     DATE
)
LANGUAGE sql
STABLE
AS $$
  WITH p1 AS (
    SELECT customer_id,
           SUM(COALESCE(total_ex_vat, total, 0)) AS revenue,
           MAX(invoice_date)                     AS last_invoice_date
    FROM invoices
    WHERE customer_id IS NOT NULL
      AND invoice_date >= period1_start
      AND invoice_date <= period1_end
    GROUP BY customer_id
    HAVING SUM(COALESCE(total_ex_vat, total, 0)) > 0
  ),
  p2 AS (
    SELECT customer_id
    FROM invoices
    WHERE customer_id IS NOT NULL
      AND invoice_date >= period2_start
      AND invoice_date <= period2_end
    GROUP BY customer_id
    HAVING SUM(COALESCE(total_ex_vat, total, 0)) > 0
  )
  SELECT
    COALESCE(c.name, '(unknown customer)') AS customer_name,
    round(p1.revenue, 2)                   AS total_revenue_period1,
    p1.last_invoice_date                   AS last_invoice_date
  FROM p1
  LEFT JOIN customers c ON c.id = p1.customer_id
  WHERE p1.customer_id NOT IN (SELECT customer_id FROM p2)
  ORDER BY p1.revenue DESC, customer_name ASC
  LIMIT 200;
$$;

REVOKE ALL ON FUNCTION public.get_churned_customers(DATE, DATE, DATE, DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_churned_customers(DATE, DATE, DATE, DATE)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.get_churned_customers(DATE, DATE, DATE, DATE) IS
  'Companion to get_churn_analysis: returns the actual list of churned customers (had revenue in period1 but not period2) with customer_name, total_revenue_period1 (ex-VAT) and last_invoice_date (within period1). Ordered by revenue desc, capped at 200 rows. RLS-aware (SECURITY INVOKER).';
