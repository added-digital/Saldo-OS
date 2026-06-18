-- =====================================================================
-- Migration 00080: Propagate a customer's räkenskapsår to its engagements
-- =====================================================================
-- Called from the customer card when räkenskapsår is saved. Pushes the
-- customer's EFFECTIVE year-end (SIE-or-manual) MONTH-DAY onto that customer's
-- engagements, keeping each engagement's own cycle YEAR. A 30-Jun räkenskapsår
-- thus turns a 2025-12-31 engagement into 2025-06-30, but never moves it to a
-- different year.
--
-- Deliberately NOT a trigger: only an explicit customer-card save propagates.
-- The nightly SIE sync updates customers.*_sie via the sie_imports trigger but
-- must never silently move an in-progress bokslut's year-end.
--
-- SECURITY INVOKER (default): RLS on engagements (has_scope('customers'))
-- applies — the caller must already be allowed to edit these rows.

CREATE OR REPLACE FUNCTION public.propagate_customer_financial_year(p_customer_id uuid)
RETURNS integer
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  ye date;
  affected integer;
BEGIN
  SELECT COALESCE(financial_year_to_sie, financial_year_to_manual)
    INTO ye
  FROM customers
  WHERE id = p_customer_id;

  IF ye IS NULL THEN
    RETURN 0;
  END IF;

  UPDATE engagements e
  SET fiscal_year_end = make_date(
        EXTRACT(YEAR  FROM e.fiscal_year_end)::int,
        EXTRACT(MONTH FROM ye)::int,
        EXTRACT(DAY   FROM ye)::int
      ),
      updated_at = now()
  WHERE e.customer_id = p_customer_id
    AND (EXTRACT(MONTH FROM e.fiscal_year_end)::int, EXTRACT(DAY FROM e.fiscal_year_end)::int)
        IS DISTINCT FROM
        (EXTRACT(MONTH FROM ye)::int, EXTRACT(DAY FROM ye)::int);

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END
$$;

REVOKE ALL ON FUNCTION public.propagate_customer_financial_year(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.propagate_customer_financial_year(uuid) TO authenticated, service_role;
