-- Typo-tolerant customer search for the chat assistant.
--
-- The `resolve_customer` tool previously matched with substring ILIKE only,
-- which can't bridge typos — e.g. "kamecia bygg" doesn't substring-match
-- "Kamenica Bygg & Balkongteknik AB". This migration adds:
--
-- 1. The `pg_trgm` extension (trigram similarity).
-- 2. A GIN trigram index on lower(customers.name) for fast similarity lookups.
-- 3. An RPC `search_customers_fuzzy(q, lim)` that combines exact substring
--    matches (on name, org_number, fortnox_customer_number) with trigram
--    word similarity for typo-tolerant name matching.
--
-- The function is SECURITY INVOKER (default for SQL functions), so the
-- existing `customers_select` RLS policy (`has_scope('customers')`) still
-- gates which rows the caller can see.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_customers_name_trgm
  ON customers
  USING GIN (lower(name) gin_trgm_ops);

CREATE OR REPLACE FUNCTION public.search_customers_fuzzy(
  q TEXT,
  lim INTEGER DEFAULT 5
)
RETURNS TABLE (
  id UUID,
  name TEXT,
  org_number TEXT,
  fortnox_customer_number TEXT,
  status TEXT,
  score REAL
)
LANGUAGE sql
STABLE
AS $$
  WITH norm AS (
    SELECT
      trim(q) AS raw,
      lower(trim(q)) AS lq
  )
  SELECT
    c.id,
    c.name,
    c.org_number,
    c.fortnox_customer_number,
    c.status,
    GREATEST(
      -- Exact substring on any identifier wins outright (score 1.0).
      CASE
        WHEN c.name ILIKE '%' || (SELECT raw FROM norm) || '%' THEN 1.0
        WHEN c.org_number ILIKE '%' || (SELECT raw FROM norm) || '%' THEN 1.0
        WHEN c.fortnox_customer_number ILIKE '%' || (SELECT raw FROM norm) || '%' THEN 1.0
        ELSE 0
      END,
      -- Fuzzy: word_similarity finds the best matching window inside the
      -- target string, so it scores partial names highly (e.g. "kamecia"
      -- against "Kamenica Bygg & Balkongteknik AB").
      word_similarity((SELECT lq FROM norm), lower(c.name)),
      -- Fallback to plain similarity for cases where word_similarity is
      -- low (e.g. very short queries).
      similarity((SELECT lq FROM norm), lower(c.name))
    )::REAL AS score
  FROM customers c
  WHERE
    c.name ILIKE '%' || (SELECT raw FROM norm) || '%'
    OR c.org_number ILIKE '%' || (SELECT raw FROM norm) || '%'
    OR c.fortnox_customer_number ILIKE '%' || (SELECT raw FROM norm) || '%'
    OR word_similarity((SELECT lq FROM norm), lower(c.name)) > 0.3
    OR similarity((SELECT lq FROM norm), lower(c.name)) > 0.2
  ORDER BY score DESC, c.name ASC
  LIMIT GREATEST(lim, 1);
$$;

REVOKE ALL ON FUNCTION public.search_customers_fuzzy(TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_customers_fuzzy(TEXT, INTEGER) TO authenticated, service_role;

COMMENT ON FUNCTION public.search_customers_fuzzy(TEXT, INTEGER) IS
  'Typo-tolerant customer search. Combines exact substring matches on name/org_number/fortnox_customer_number with trigram word_similarity for fuzzy name matching. RLS-aware (SECURITY INVOKER).';
