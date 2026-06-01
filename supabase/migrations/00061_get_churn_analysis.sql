-- Churn / retention analysis for the chat assistant.
--
-- The `get_churn_analysis` tool answers questions like "what is our churn rate
-- over the last 12 months compared to the previous 12?" without ever pulling a
-- customer list into the model's context. ALL of the set logic and the revenue
-- sums happen here, in the database; the function returns only aggregate
-- numbers (counts + totals), never the underlying customer rows.
--
-- Period model
-- ------------
-- The function compares two arbitrary date windows:
--   • period1 = the EARLIER / baseline window (e.g. the previous 12 months).
--   • period2 = the LATER / comparison window (e.g. the most recent 12 months).
-- Churn is measured as customers lost moving from period1 → period2.
--
-- A customer "had revenue" in a window when the SUM of their invoiced amount in
-- that window is > 0. We prefer ex-VAT (`total_ex_vat`) and fall back to the
-- VAT-inclusive `total` when ex-VAT is null, matching the firm-wide convention
-- of reporting turnover ex-VAT. Invoices with a null `customer_id` (orphaned by
-- ON DELETE SET NULL) can't be attributed to a customer and are excluded.
--
-- Returned JSON keys
-- ------------------
--   churned        — count of customers with revenue in period1 but NOT period2.
--   new_customers  — count of customers with revenue in period2 but NOT period1.
--   retained       — count of customers with revenue in BOTH windows.
--   churn_rate     — churned ÷ (period1 customer base) × 100, rounded to 2 dp.
--                    0 when period1 had no paying customers (avoids ÷0).
--   total_period1  — total ex-VAT revenue across period1 (rounded to 2 dp).
--   total_period2  — total ex-VAT revenue across period2 (rounded to 2 dp).
-- Plus `period1` / `period2` echo blocks (dates + active customer counts),
-- `currency` and `revenue_basis` for self-describing results.
--
-- SECURITY INVOKER (the default for SQL functions) so the existing
-- `invoices_select` RLS policy (`has_scope('customers')`) still gates which
-- rows the caller can see — the counts reflect only invoices the caller is
-- allowed to read.

CREATE OR REPLACE FUNCTION public.get_churn_analysis(
  period1_start DATE,
  period1_end   DATE,
  period2_start DATE,
  period2_end   DATE
)
RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
  WITH p1 AS (
    SELECT customer_id, SUM(COALESCE(total_ex_vat, total, 0)) AS revenue
    FROM invoices
    WHERE customer_id IS NOT NULL
      AND invoice_date >= period1_start
      AND invoice_date <= period1_end
    GROUP BY customer_id
    HAVING SUM(COALESCE(total_ex_vat, total, 0)) > 0
  ),
  p2 AS (
    SELECT customer_id, SUM(COALESCE(total_ex_vat, total, 0)) AS revenue
    FROM invoices
    WHERE customer_id IS NOT NULL
      AND invoice_date >= period2_start
      AND invoice_date <= period2_end
    GROUP BY customer_id
    HAVING SUM(COALESCE(total_ex_vat, total, 0)) > 0
  ),
  agg AS (
    SELECT
      (SELECT count(*) FROM p1
         WHERE customer_id NOT IN (SELECT customer_id FROM p2)) AS churned,
      (SELECT count(*) FROM p2
         WHERE customer_id NOT IN (SELECT customer_id FROM p1)) AS new_customers,
      (SELECT count(*) FROM p1
         WHERE customer_id IN (SELECT customer_id FROM p2))     AS retained,
      (SELECT count(*) FROM p1)                                 AS base_p1,
      (SELECT count(*) FROM p2)                                 AS base_p2,
      (SELECT COALESCE(SUM(revenue), 0) FROM p1)                AS total_period1,
      (SELECT COALESCE(SUM(revenue), 0) FROM p2)                AS total_period2
  )
  SELECT jsonb_build_object(
    'churned',       churned,
    'new_customers', new_customers,
    'retained',      retained,
    'churn_rate',    CASE WHEN base_p1 = 0 THEN 0
                          ELSE round((churned::numeric / base_p1) * 100, 2) END,
    'total_period1', round(total_period1, 2),
    'total_period2', round(total_period2, 2),
    'period1', jsonb_build_object(
      'start', period1_start, 'end', period1_end, 'active_customers', base_p1),
    'period2', jsonb_build_object(
      'start', period2_start, 'end', period2_end, 'active_customers', base_p2),
    'currency', 'SEK',
    'revenue_basis', 'ex_vat'
  )
  FROM agg;
$$;

REVOKE ALL ON FUNCTION public.get_churn_analysis(DATE, DATE, DATE, DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_churn_analysis(DATE, DATE, DATE, DATE)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.get_churn_analysis(DATE, DATE, DATE, DATE) IS
  'Churn/retention between two date windows (period1=earlier baseline, period2=later comparison). Returns aggregate JSON (churned, new_customers, retained, churn_rate, total_period1, total_period2) — never raw customer lists. Revenue is ex-VAT (total_ex_vat, fallback total). RLS-aware (SECURITY INVOKER).';
