-- 00120: stop recomputing a year of time reports on every page load.
--
-- resource_board aggregated 12 months of time_reports, every call, for every
-- user. As `service_role` that took 1,5–3,1 s and looked survivable; as
-- `authenticated` it hit the statement timeout and the page showed an empty
-- board — 57014 dressed up as "no customers".
--
-- 00119 tried to make the aggregation cheaper by folding four scans into one
-- materialized pass. It made it worse: 6,5–9,3 s, timing out even for
-- service_role, because materialising the whole 12-month window eagerly costs
-- more than the narrower scans it replaced. That was the second attempt at
-- tuning a query that should not be running at request time at all.
--
-- The fix is the one customer_kpis already made for the reports page: compute
-- once, read many. Nothing in the aggregate changes between page loads — it is
-- derived from time reports that arrive nightly — so it belongs in a table with
-- a primary key, not in a function under a timeout.
--
-- After this, resource_board touches no large table. It reads ~2 000 stat rows,
-- joins customers, the plan, statuses and profiles, and returns. The estimate
-- is at most one night old, which is exactly as fresh as the time reports it is
-- computed from.

-- -----------------------------------------------------------------------------
-- 1. The precomputed aggregate
-- -----------------------------------------------------------------------------
-- One row per customer that has any recent history. Purely derived: dropping
-- and rebuilding it loses nothing, which is why the refresh below is free to
-- rewrite every row. Human decisions stay where they were — resource_plan,
-- customer_recurring_work, absences — and are never touched by the refresh.

CREATE TABLE IF NOT EXISTS customer_workload_stats (
  customer_id UUID PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,

  -- From time_reports, last 12 months, entry_type = 'time'.
  first_reported_date DATE,
  last_reported_date DATE,
  months_12 INTEGER NOT NULL DEFAULT 0,
  /** Share of the last 3 complete months' hours that was händelsestyrt. */
  event_share NUMERIC(5, 4),
  /** Hours in the last 6 complete months — the activity half of board scope. */
  active_recently BOOLEAN NOT NULL DEFAULT false,

  -- From customer_kpis: mean monthly customer_hours over the last 3 complete
  -- months. Same source the reports page uses, so the two cannot disagree.
  est_hours NUMERIC(10, 1),

  /** Top 3 logged activities, most hours first. The board prefers captured
      work where a human has confirmed any; this is the fallback. */
  top_activities TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

  computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workload_stats_active
  ON customer_workload_stats(customer_id) WHERE active_recently;

COMMENT ON TABLE customer_workload_stats IS
  'Derived nightly from time_reports and customer_kpis. Safe to rebuild at any time; holds no human decisions.';

ALTER TABLE customer_workload_stats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS customer_workload_stats_select ON customer_workload_stats;
CREATE POLICY customer_workload_stats_select ON customer_workload_stats
  FOR SELECT USING (is_staff());

-- -----------------------------------------------------------------------------
-- 2. The refresh
-- -----------------------------------------------------------------------------
-- Runs the aggregation that used to sit in the request path. It may take
-- seconds; nobody is waiting for it. The windows are relative to CURRENT_DATE,
-- which is why this runs nightly rather than once.

CREATE OR REPLACE FUNCTION refresh_customer_workload_stats()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  touched INTEGER;
BEGIN
  WITH period AS (
    SELECT (date_trunc('month', CURRENT_DATE) - INTERVAL '3 months')::date AS history_start,
           (date_trunc('month', CURRENT_DATE) - INTERVAL '1 day')::date AS history_end,
           (date_trunc('month', CURRENT_DATE) - INTERVAL '6 months')::date AS scope_start,
           (date_trunc('month', CURRENT_DATE) - INTERVAL '12 months')::date AS long_start
  ),
  window_rows AS (
    SELECT
      tr.customer_id,
      tr.report_date,
      tr.hours,
      -- Fortnox prefixes some activities with the client's own name; strip it
      -- so the same work groups across customers.
      btrim(regexp_replace(COALESCE(tr.activity, ''), '^[^-]{1,30}\s+-\s+', '')) AS label,
      tr.activity ~* 'bokslut|årsredov|arsredov|ink2|inkomstdeklar|k10|k4|periodiserad' AS is_event
    FROM time_reports tr, period p
    WHERE tr.customer_id IS NOT NULL
      AND tr.entry_type = 'time'
      AND tr.report_date >= p.long_start
  ),
  aggregated AS (
    SELECT
      w.customer_id,
      MIN(w.report_date) AS first_reported_date,
      MAX(w.report_date) AS last_reported_date,
      COUNT(DISTINCT date_trunc('month', w.report_date))::INTEGER AS months_12,
      SUM(w.hours) FILTER (
        WHERE w.report_date BETWEEN p.history_start AND p.history_end AND w.is_event
      ) / NULLIF(
        SUM(w.hours) FILTER (WHERE w.report_date BETWEEN p.history_start AND p.history_end),
        0
      ) AS event_share,
      bool_or(w.report_date BETWEEN p.scope_start AND p.history_end) AS active_recently
    FROM window_rows w, period p
    GROUP BY w.customer_id
  ),
  labelled AS (
    SELECT customer_id, array_agg(label ORDER BY weight DESC, label) AS labels
    FROM (
      SELECT
        w.customer_id,
        w.label,
        SUM(w.hours) AS weight,
        ROW_NUMBER() OVER (PARTITION BY w.customer_id ORDER BY SUM(w.hours) DESC, w.label) AS ord
      FROM window_rows w
      WHERE w.label <> ''
      GROUP BY w.customer_id, w.label
    ) ranked
    WHERE ord <= 3
    GROUP BY customer_id
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
  merged AS (
    SELECT
      COALESCE(a.customer_id, t.customer_id) AS customer_id,
      a.first_reported_date,
      a.last_reported_date,
      COALESCE(a.months_12, 0) AS months_12,
      a.event_share,
      COALESCE(a.active_recently, false) AS active_recently,
      t.est_hours,
      COALESCE(l.labels, ARRAY[]::TEXT[]) AS top_activities
    FROM aggregated a
    FULL JOIN totals t ON t.customer_id = a.customer_id
    LEFT JOIN labelled l ON l.customer_id = COALESCE(a.customer_id, t.customer_id)
  )
  INSERT INTO customer_workload_stats AS s (
    customer_id, first_reported_date, last_reported_date, months_12,
    event_share, active_recently, est_hours, top_activities, computed_at
  )
  SELECT
    m.customer_id, m.first_reported_date, m.last_reported_date, m.months_12,
    m.event_share, m.active_recently, m.est_hours, m.top_activities, now()
  FROM merged m
  -- A customer row may have been deleted since the time reports were written.
  WHERE EXISTS (SELECT 1 FROM customers c WHERE c.id = m.customer_id)
  ON CONFLICT (customer_id) DO UPDATE SET
    first_reported_date = EXCLUDED.first_reported_date,
    last_reported_date = EXCLUDED.last_reported_date,
    months_12 = EXCLUDED.months_12,
    event_share = EXCLUDED.event_share,
    active_recently = EXCLUDED.active_recently,
    est_hours = EXCLUDED.est_hours,
    top_activities = EXCLUDED.top_activities,
    computed_at = now();

  GET DIAGNOSTICS touched = ROW_COUNT;

  -- Customers that fell out of the window entirely stop being stale data and
  -- start being absent, which is what the board's `ingen_historik` expects.
  -- now() is the transaction timestamp, so every row this run touched carries
  -- exactly it, and anything older was not touched.
  DELETE FROM customer_workload_stats
  WHERE computed_at < now();

  RETURN touched;
END;
$$;

REVOKE ALL ON FUNCTION refresh_customer_workload_stats() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION refresh_customer_workload_stats() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION refresh_customer_workload_stats() TO service_role;

-- -----------------------------------------------------------------------------
-- 3. The board, now a read
-- -----------------------------------------------------------------------------
-- Identical columns and identical semantics to 00117 and 00119. The only change
-- is where the aggregate comes from: a table with 2 000 rows instead of a scan
-- of 91 000 time reports.

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
    SELECT (date_trunc('month', CURRENT_DATE) - INTERVAL '3 months')::date AS history_start,
           (date_trunc('month', CURRENT_DATE) - INTERVAL '6 months')::date AS scope_start
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
  recurring AS (
    SELECT w.customer_id,
           COUNT(*)::INTEGER AS total,
           COUNT(*) FILTER (WHERE w.confirmed_at IS NOT NULL)::INTEGER AS confirmed,
           (array_agg(w.label ORDER BY (w.confirmed_at IS NULL), COALESCE(w.typical_hours, 0) DESC, w.label))[1:3] AS labels
    FROM customer_recurring_work w
    WHERE w.is_active
    GROUP BY w.customer_id
  ),
  -- In scope: hours in the last 6 complete months, a dated event this month, a
  -- row a human already put on this month's board, captured recurring work, or
  -- an active kundansvarig who owns the customer. Silence on an owned customer
  -- is a signal, not a reason to hide it.
  scope AS (
    SELECT s.customer_id FROM customer_workload_stats s WHERE s.active_recently
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
    ROUND(COALESCE(ws.est_hours, 0) * (1 - COALESCE(ws.event_share, 0)), 1),
    ROUND(COALESCE(ws.est_hours, 0) * COALESCE(ws.event_share, 0), 1),
    plan.planned_hours,
    COALESCE(plan.planned_hours, ws.est_hours, 0),
    COALESCE(r.total, 0),
    COALESCE(r.confirmed, 0),
    -- Captured work wins where a human has written any; the logged activities
    -- stand in everywhere else, so the card answers "vilka uppgifter" from day
    -- one rather than after the whole portfolio has been confirmed.
    COALESCE(r.labels, ws.top_activities, ARRAY[]::TEXT[]),
    ev.label,
    ev.due_date,
    ev.hardness,
    ev.kind,
    -- Why no estimate can be trusted for this customer. NULL means one can, and
    -- NULL is the only thing that keeps a card out of "Behöver bedömning".
    --
    -- A statement about the data, never about the workflow: whether anybody has
    -- confirmed the recurring work belongs in the Bekräfta counter, and must
    -- never group cards. Every customer is unconfirmed on day one.
    CASE
      WHEN ws.customer_id IS NULL OR COALESCE(ws.months_12, 0) = 0 THEN 'ingen_historik'
      -- New, and thin because of it. The history test matters: customers were
      -- bulk-imported from Fortnox, so created_at alone would call a whole
      -- import batch "ny kund".
      WHEN COALESCE(ws.months_12, 0) < 3
        AND COALESCE(c.start_date, c.created_at::date) >= (SELECT history_start FROM period)
        THEN 'ny_kund'
      WHEN ws.last_reported_date < (SELECT scope_start FROM period) THEN 'vilande'
      -- 2 h is the same threshold the card uses to fall back to a dash, kept in
      -- step on purpose: a card shows a number, or it shows why it cannot.
      WHEN COALESCE(plan.planned_hours, ws.est_hours, 0) < 2
        OR COALESCE(ws.months_12, 0) < 3
        THEN 'for_lite_historik'
      ELSE NULL
    END,
    ws.last_reported_date,
    COALESCE(ws.months_12, 0),
    c.fixed_monthly_price,
    plan.note,
    plan.position
  FROM scope s
  JOIN customers c ON c.id = s.customer_id
  LEFT JOIN customer_workload_stats ws ON ws.customer_id = c.id
  LEFT JOIN primary_event ev ON ev.customer_id = c.id
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

-- The index 00119 added was for a scan the board no longer does. The refresh
-- still walks the same window nightly, so it earns its keep there.

-- -----------------------------------------------------------------------------
-- 4. Fill it now, and keep it filled
-- -----------------------------------------------------------------------------
-- Without this the board renders every customer as 'ingen_historik' until the
-- first nightly run — technically correct about an empty table, useless to a
-- human.

SELECT refresh_customer_workload_stats();

-- 04:30, after the nightly Fortnox sync has landed and before anyone is at
-- their desk. Same pattern as enqueue-bolagsverket-nightly-pending in 00096.
SELECT cron.unschedule('refresh-customer-workload-stats')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'refresh-customer-workload-stats'
);

SELECT cron.schedule(
  'refresh-customer-workload-stats',
  '30 4 * * *',
  $$SELECT refresh_customer_workload_stats()$$
);

NOTIFY pgrst, 'reload schema';
