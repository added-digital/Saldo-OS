-- 00117: an owned customer belongs on its owner's board even when silent.
--
-- resource_board scoped itself by activity: hours in the last 6 months, a dated
-- event, a row in resource_plan, or confirmed recurring work. Ownership was not
-- a way in. So Rapporter (scoped by kostnadsställe) and Beläggning (scoped by
-- activity) disagreed about who a consultant's customers were — Derya Kuzey had
-- 7 in one view and 4 in the other, and the 3 that vanished were the ones with
-- no logged time since ~February.
--
-- Those three are the interesting ones. A customer with no hours for six months
-- is either vilande, which the manager should see, or forgotten, which the
-- manager should REALLY see. Dropping them silently meant the board could not
-- answer "have I missed someone".
--
-- Expect the board to get bigger, and the 'Osäkert underlag' group to grow
-- before it shrinks — but now with `vilande` and `ingen_historik` telling the
-- rows apart instead of every one of them reading 'tunn historik'.

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
  history AS (
    SELECT
      tr.customer_id,
      MAX(tr.report_date) AS last_date,
      COUNT(DISTINCT date_trunc('month', tr.report_date))::INTEGER AS months_12,
      MIN(tr.report_date) AS first_date
    FROM time_reports tr, period p
    WHERE tr.customer_id IS NOT NULL
      AND tr.entry_type = 'time'
      AND tr.report_date >= p.long_start
    GROUP BY tr.customer_id
  ),
  -- Which share of the recent hours was händelsestyrt. Taken from
  -- time_reports.activity and applied as a ratio to the customer_kpis total, so
  -- the split never makes the board's own sum disagree with the reports page.
  split AS (
    SELECT
      tr.customer_id,
      SUM(tr.hours) FILTER (
        WHERE tr.activity ~* 'bokslut|årsredov|arsredov|ink2|inkomstdeklar|k10|k4|periodiserad'
      ) / NULLIF(SUM(tr.hours), 0) AS event_share
    FROM time_reports tr, period p
    WHERE tr.customer_id IS NOT NULL
      AND tr.entry_type = 'time'
      AND tr.report_date >= p.history_start
      AND tr.report_date <= p.history_end
    GROUP BY tr.customer_id
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
  -- What this customer needs done. Captured work wins where it exists, because
  -- a human wrote it; everywhere else the customer's own logged activities
  -- stand in, so the card answers "vilka uppgifter" from day one rather than
  -- waiting for the whole portfolio to be confirmed.
  activity_source AS (
    SELECT
      w.customer_id,
      w.label,
      0 AS tier,
      COALESCE(w.typical_hours, 0) AS weight
    FROM customer_recurring_work w
    WHERE w.is_active
    UNION ALL
    SELECT
      tr.customer_id,
      btrim(regexp_replace(tr.activity, '^[^-]{1,30}\s+-\s+', '')) AS label,
      1 AS tier,
      SUM(tr.hours) AS weight
    FROM time_reports tr, period p
    WHERE tr.customer_id IS NOT NULL
      AND tr.entry_type = 'time'
      AND tr.activity IS NOT NULL
      AND btrim(tr.activity) <> ''
      AND tr.report_date >= p.long_start
      AND NOT EXISTS (
        SELECT 1 FROM customer_recurring_work w
        WHERE w.customer_id = tr.customer_id AND w.is_active
      )
    GROUP BY tr.customer_id, 2
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
  recurring AS (
    SELECT w.customer_id,
           COUNT(*)::INTEGER AS total,
           COUNT(*) FILTER (WHERE w.confirmed_at IS NOT NULL)::INTEGER AS confirmed
    FROM customer_recurring_work w
    WHERE w.is_active
    GROUP BY w.customer_id
  ),
  -- In scope: anyone with hours in the last 6 complete months, plus anyone a
  -- human or a deadline has already put on this month's board.
  scope AS (
    SELECT DISTINCT tr.customer_id
    FROM time_reports tr, period p
    WHERE tr.customer_id IS NOT NULL
      AND tr.entry_type = 'time'
      AND tr.customer_id NOT IN (SELECT id FROM customers WHERE is_internal)
      AND tr.report_date >= p.scope_start
      AND tr.report_date <= p.history_end
    UNION
    SELECT pe.customer_id FROM primary_event pe
    UNION
    SELECT rp.customer_id FROM resource_plan rp
    WHERE rp.period_year = p_year AND rp.period_month = p_month
    UNION
    SELECT DISTINCT w.customer_id FROM customer_recurring_work w WHERE w.is_active
    UNION
    -- Ownership, not just activity. Scoping the board by logged time alone meant
    -- the customer nobody has touched — the single most worth seeing — was the
    -- one it could never show: 3 of Derya Kuzey's 7 customers were missing
    -- because nothing had been booked on them in 6 months.
    --
    -- It also made two branches of assessment_reason unreachable by
    -- construction: `vilande` fires when last_date < scope_start, but scope
    -- required hours >= scope_start, so the two were mutually exclusive and
    -- everything collapsed into 'for_lite_historik'. Same for 'ingen_historik'.
    --
    -- customers.status is the gate rather than any hours window: it is a human
    -- maintained field, so 'active' means someone still considers this a
    -- customer. Silence on an active customer is a signal, not a reason to hide
    -- it.
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
    ROUND(COALESCE(tot.est_hours, 0) * (1 - COALESCE(sp.event_share, 0)), 1),
    ROUND(COALESCE(tot.est_hours, 0) * COALESCE(sp.event_share, 0), 1),
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
  LEFT JOIN split sp ON sp.customer_id = c.id
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
