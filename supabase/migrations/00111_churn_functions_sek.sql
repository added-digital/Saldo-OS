-- =====================================================
-- Migration 00111: Churn analysis in SEK
-- =====================================================
-- Both churn functions summed `total_ex_vat` / `total` directly, which mixes
-- currencies: a EUR customer's revenue was compared against SEK customers' at
-- face value, and `'currency', 'SEK'` in the payload was a lie. 00110 added the
-- `_sek` projections, so switch the sums over.
--
-- Only the amount columns change — the churn definition, the RLS posture
-- (SECURITY INVOKER) and the return shapes are identical to 00061/00062.

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
    SELECT customer_id, SUM(COALESCE(total_ex_vat_sek, total_sek, 0)) AS revenue
    FROM invoices
    WHERE customer_id IS NOT NULL
      AND invoice_date >= period1_start
      AND invoice_date <= period1_end
    GROUP BY customer_id
    HAVING SUM(COALESCE(total_ex_vat_sek, total_sek, 0)) > 0
  ),
  p2 AS (
    SELECT customer_id, SUM(COALESCE(total_ex_vat_sek, total_sek, 0)) AS revenue
    FROM invoices
    WHERE customer_id IS NOT NULL
      AND invoice_date >= period2_start
      AND invoice_date <= period2_end
    GROUP BY customer_id
    HAVING SUM(COALESCE(total_ex_vat_sek, total_sek, 0)) > 0
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

COMMENT ON FUNCTION public.get_churn_analysis(DATE, DATE, DATE, DATE) IS
  'Churn/retention between two date windows (period1=earlier baseline, period2=later comparison). Returns aggregate JSON (churned, new_customers, retained, churn_rate, total_period1, total_period2) — never raw customer lists. Revenue is ex-VAT converted to SEK (total_ex_vat_sek, fallback total_sek). RLS-aware (SECURITY INVOKER).';

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
           SUM(COALESCE(total_ex_vat_sek, total_sek, 0)) AS revenue,
           MAX(invoice_date)                             AS last_invoice_date
    FROM invoices
    WHERE customer_id IS NOT NULL
      AND invoice_date >= period1_start
      AND invoice_date <= period1_end
    GROUP BY customer_id
    HAVING SUM(COALESCE(total_ex_vat_sek, total_sek, 0)) > 0
  ),
  p2 AS (
    SELECT customer_id
    FROM invoices
    WHERE customer_id IS NOT NULL
      AND invoice_date >= period2_start
      AND invoice_date <= period2_end
    GROUP BY customer_id
    HAVING SUM(COALESCE(total_ex_vat_sek, total_sek, 0)) > 0
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

COMMENT ON FUNCTION public.get_churned_customers(DATE, DATE, DATE, DATE) IS
  'Companion to get_churn_analysis: returns the actual list of churned customers (had revenue in period1 but not period2) with customer_name, total_revenue_period1 (ex-VAT, SEK) and last_invoice_date (within period1). Ordered by revenue desc, capped at 200 rows. RLS-aware (SECURITY INVOKER).';
