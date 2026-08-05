-- 00119: the board timed out for everyone except service_role.
--
-- Symptom: 57014, canceling statement due to statement timeout, on every load.
-- The page rendered its consultant list (resource_capacity, ~0,3 s) and nothing
-- else, which read as "no customers" rather than "the query never finished".
--
-- Cause is structural, not volume. The tables are small — 91 234 time reports,
-- 12 386 kpi rows, 1 916 customers — but resource_board walked time_reports
-- four separate times:
--
--   history         12 months, per customer: first, last, months seen
--   split           3 months, per customer: händelsestyrd share
--   scope           6 months, distinct customers
--   activity_source 12 months, regexp_replace per row, plus a correlated
--                   NOT EXISTS against customer_recurring_work per row
--
-- Postgres 12+ inlines a CTE referenced once, so those four stayed four scans
-- rather than being folded together. service_role runs under a two-minute
-- timeout and never noticed; authenticated runs under seconds and did.
--
-- This rewrite reads time_reports once into a MATERIALIZED CTE — the keyword
-- matters, without it each reference is inlined and the scans come back — and
-- derives all four from it with FILTER clauses. The regexp normalisation runs
-- once per row instead of once per row per scan, and the correlated NOT EXISTS
-- becomes a join against the already-aggregated recurring counts.
--
-- Output is column-for-column identical to 00117. The only behavioural change
-- is speed. If this still times out, the next step is not more tuning: it is
-- moving the estimate into a table the nightly sync fills.

CREATE INDEX IF NOT EXISTS idx_time_reports_time_window
  ON time_reports (report_date, customer_id)
  WHERE entry_type = 'time' AND customer_id IS NOT NULL;

COMMENT ON INDEX idx_time_reports_time_window IS
  'Serves resource_board''s 12-month window scan. Partial on the same predicate the board uses, so the index stays small.';

DROP FUNCTION IF EXISTS resource_board(INTEGER, INTEGER);

CREATE OR REPLACE FUNCTION resource_board(p_year INTEGER, p_month INTEGER)
RETURNS TABLE (
  customer_id UUID,
  customer_name TEXT,
  fortnox_customer_number TEXT,

  kundansvarig_id UUID,
  kundansvarig_name TEXT,

  assignee_id UUID,
  assignee_name TEXT,

  status_id UUID,
  status_key TEXT,
  status_label TEXT,
  status_sort INTEGER,
  status_is_done BOOLEAN,

  lopande_estimate_hours NUMERIC,
  handelsestyrt_estimate_hours NUMERIC,
  planned_hours NUMERIC,
  effective_hours NUMERIC,

  recurring_total INTEGER,
  recurring_confirmed INTEGER,
  top_activities TEXT[],

  event_label TEXT,
  event_due_date DATE,
  event_hardness TEXT,
  event_kind TEXT,

  assessment_reason TEXT,
  last_reported_date DATE,
  history_months INTEGER,

  fixed_monthly_price NUMERIC,
  note TEXT,
  "position" DOUBLE PRECISION
)
LANGUAGE sql
STABLE
AS $$
  WITH period AS (
    SELECT make_date(p_year, p_month, 1) AS month_start,
           (make_date(p_year, p_month, 1) + INTERVAL '1 month - 1 day')::date AS month_end,
           -- Last 3 complete months, counted back from the current real month
           -- rather than from the requested one, so planning a future month
           -- still estimates from the most recent actuals available.
           (date_trunc('month', CURRENT_DATE) - INTERVAL '3 months')::date AS history_start,
           (date_trunc('month', CURRENT_DATE) - INTERVAL '1 day')::date AS history_end,
           (date_trunc('month', CURRENT_DATE) - INTERVAL '6 months')::date AS scope_start,
           (date_trunc('month', CURRENT_DATE) - INTERVAL '12 months')::date AS long_start
  ),
  -- The one pass. MATERIALIZED is load-bearing: without it every reference
  -- below is inlined back into its own scan of time_reports, which is the bug
  -- this migration exists to fix. The activity label is normalised here, once —
  -- Fortnox prefixes some activities with the client's own name, and stripping
  -- it per scan was most of the CPU.
  tr_window AS MATERIALIZED (
    SELECT
      tr.customer_id,
      tr.report_date,
      tr.hours,
      btrim(regexp_replace(COALESCE(tr.activity, ''), '^[^-]{1,30}\s+-\s+', '')) AS label,
      tr.activity ~* 'bokslut|årsredov|arsredov|ink2|inkomstdeklar|k10|k4|periodiserad' AS is_event
    FROM time_reports tr, period p
    WHERE tr.customer_id IS NOT NULL
      AND tr.entry_type = 'time'
      AND tr.report_date >= p.long_start
  ),
  -- history, split and the activity half of scope, from that single pass.
  history AS (
    SELECT
      w.customer_id,
      MAX(w.report_date) AS last_date,
      MIN(w.report_date) AS first_date,
      COUNT(DISTINCT date_trunc('month', w.report_date))::INTEGER AS months_12,
      -- Which share of the recent hours was händelsestyrt, applied later as a
      -- ratio to the customer_kpis total so the board's own sum never disagrees
      -- with the reports page.
      SUM(w.hours) FILTER (
        WHERE w.report_date BETWEEN p.history_start AND p.history_end AND w.is_event
      ) / NULLIF(
        SUM(w.hours) FILTER (WHERE w.report_date BETWEEN p.history_start AND p.history_end),
        0
      ) AS event_share,
      bool_or(w.report_date BETWEEN p.scope_start AND p.history_end) AS active_recently
    FROM tr_window w, period p
    GROUP BY w.customer_id
  ),
  totals AS (
    SELECT k.customer_id,
           ROUND(SUM(k.customer_hours) / 3.0, 1) AS est_hours
    FROM customer_kpis k, period p
    WHERE k.period_type = 'month'
      AND make_date(k.period_year, k.period_month, 1) >= date_trunc('month', p.history_start)::date
      AND make_date(k.period_year, k.period_month, 1) <= p.history_end
    GROUP BY k.customer_id
  ),
  recurring AS (
    SELECT w.customer_id,
           COUNT(*)::INTEGER AS total,
           COUNT(*) FILTER (WHERE w.confirmed_at IS NOT NULL)::INTEGER AS confirmed
    FROM customer_recurring_work w
    WHERE w.is_active
    GROUP BY w.customer_id
  ),
  -- What this customer needs done. Captured work wins where it exists, because
  -- a human wrote it; everywhere else the customer's own logged activities
  -- stand in, so the card answers "vilka uppgifter" from day one rather than
  -- waiting for the whole portfolio to be confirmed. The old correlated
  -- NOT EXISTS per time report is now an anti-join against `recurring`, which
  -- has one row per customer.
  logged_activities AS (
    SELECT w.customer_id, w.label, SUM(w.hours) AS weight
    FROM tr_window w
    LEFT JOIN recurring r ON r.customer_id = w.customer_id
    WHERE w.label <> ''
      AND r.customer_id IS NULL
    GROUP BY w.customer_id, w.label
  ),
  activity_source AS (
    SELECT w.customer_id, w.label, 0 AS tier, COALESCE(w.typical_hours, 0) AS weight
    FROM customer_recurring_work w
    WHERE w.is_active
    UNION ALL
    SELECT la.customer_id, la.label, 1 AS tier, la.weight
    FROM logged_activities la
  ),
  activities AS (
    SELECT ranked.customer_id, array_agg(ranked.label ORDER BY ranked.ord) AS labels
    FROM (
      SELECT
        a.customer_id,
        a.label,
        ROW_NUMBER() OVER (
          PARTITION BY a.customer_id
          ORDER BY a.tier, a.weight DESC, a.label
        ) AS ord
      FROM activity_source a
    ) ranked
    WHERE ranked.ord <= 3
    GROUP BY ranked.customer_id
  ),
  events AS (
    SELECT * FROM resource_month_events(p_year, p_month)
  ),
  -- The card carries one chip, so the hardest-to-move, most distinctive event
  -- wins: bokslut before INK2 before löner before moms before AGI.
  primary_event AS (
    SELECT DISTINCT ON (e.customer_id)
      e.customer_id, e.kind, e.label, e.due_date, e.hardness
    FROM events e
    ORDER BY e.customer_id, e.rank, e.due_date
  ),
  -- In scope: anyone with hours in the last 6 complete months, anyone a human
  -- or a deadline has already put on this month's board, and — since 00117 —
  -- anyone an active kundansvarig owns. Silence on an owned customer is a
  -- signal, not a reason to hide it.
  scope AS (
    SELECT h.customer_id FROM history h WHERE h.active_recently
    UNION
    SELECT pe.customer_id FROM primary_event pe
    UNION
    SELECT rp.customer_id FROM resource_plan rp
    WHERE rp.period_year = p_year AND rp.period_month = p_month
    UNION
    SELECT r.customer_id FROM recurring r
    UNION
    SELECT c2.id
    FROM customers c2
    JOIN profiles pr2
      ON NULLIF(btrim(c2.fortnox_cost_center), '') = NULLIF(btrim(pr2.fortnox_cost_center), '')
    WHERE c2.status = 'active'
    EXCEPT
    SELECT id FROM customers WHERE is_internal
  )
  SELECT
    c.id,
    c.name,
    c.fortnox_customer_number,
    mgr.id,
    mgr.full_name,
    plan.assignee_id,
    doer.full_name,
    plan.status_id,
    st.key,
    st.label,
    st.sort_order,
    st.is_done,
    ROUND(COALESCE(tot.est_hours, 0) * (1 - COALESCE(h.event_share, 0)), 1),
    ROUND(COALESCE(tot.est_hours, 0) * COALESCE(h.event_share, 0), 1),
    plan.planned_hours,
    COALESCE(plan.planned_hours, tot.est_hours, 0),
    COALESCE(r.total, 0),
    COALESCE(r.confirmed, 0),
    COALESCE(act.labels, ARRAY[]::TEXT[]),
    ev.label,
    ev.due_date,
    ev.hardness,
    ev.kind,
    -- Why no estimate can be trusted for this customer. NULL means one can, and
    -- NULL is the only thing that keeps a card out of "Behöver bedömning".
    --
    -- This is deliberately a statement about the data, not about the workflow:
    -- whether anybody has confirmed the recurring work is a different question,
    -- it lives in the Bekräfta counter, and it must never group cards. Every
    -- customer is unconfirmed on day one, so grouping on it groups everyone.
    CASE
      WHEN h.customer_id IS NULL OR COALESCE(h.months_12, 0) = 0 THEN 'ingen_historik'
      -- New, and thin because of it. The history test matters: customers were
      -- bulk-imported from Fortnox, so created_at alone would call a whole
      -- import batch "ny kund".
      WHEN COALESCE(h.months_12, 0) < 3
        AND COALESCE(c.start_date, c.created_at::date) >= (SELECT history_start FROM period)
        THEN 'ny_kund'
      WHEN h.last_date < (SELECT scope_start FROM period) THEN 'vilande'
      -- 2 h is the same threshold the card uses to fall back to a dash, kept in
      -- step on purpose: a card shows a number, or it shows why it cannot.
      WHEN COALESCE(plan.planned_hours, tot.est_hours, 0) < 2
        OR COALESCE(h.months_12, 0) < 3
        THEN 'for_lite_historik'
      ELSE NULL
    END,
    h.last_date,
    COALESCE(h.months_12, 0),
    c.fixed_monthly_price,
    plan.note,
    plan.position
  FROM scope s
  JOIN customers c ON c.id = s.customer_id
  LEFT JOIN totals tot ON tot.customer_id = c.id
  LEFT JOIN history h ON h.customer_id = c.id
  LEFT JOIN primary_event ev ON ev.customer_id = c.id
  LEFT JOIN activities act ON act.customer_id = c.id
  LEFT JOIN recurring r ON r.customer_id = c.id
  LEFT JOIN resource_plan plan
    ON plan.customer_id = c.id
   AND plan.period_year = p_year
   AND plan.period_month = p_month
  LEFT JOIN resource_statuses st ON st.id = plan.status_id
  LEFT JOIN profiles mgr
    ON NULLIF(btrim(c.fortnox_cost_center), '') = NULLIF(btrim(mgr.fortnox_cost_center), '')
  LEFT JOIN profiles doer ON doer.id = plan.assignee_id;
$$;

REVOKE ALL ON FUNCTION resource_board(INTEGER, INTEGER) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION resource_board(INTEGER, INTEGER) FROM anon;
GRANT EXECUTE ON FUNCTION resource_board(INTEGER, INTEGER) TO authenticated, service_role;

-- PostgREST caches the schema; a dropped and recreated function is invisible to
-- it until told. Cheap, idempotent, and the reason 00116 and 00117 needed a
-- manual reload.
NOTIFY pgrst, 'reload schema';
