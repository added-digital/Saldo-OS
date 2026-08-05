-- =====================================================
-- Migration 00114: Structural attributes, split estimate, real anchors
-- =====================================================
-- 00112 estimated a customer's month as one blended mean of the last three
-- months, and measured itself at ±38% per customer. Most of that error is not
-- noise — it is two different populations averaged together:
--
--   Löpande        driven by structural facts (momsperiod, löner,
--                  bokföringsfrekvens). Near-deterministic once the facts are
--                  known, and until now they were stored nowhere.
--   Händelsestyrt  bokslut, INK2, årsredovisning. Anchored to the customer's
--                  own räkenskapsårsslut, lumpy, and not averageable at all.
--
-- This migration captures the structural facts, splits the estimate in two, and
-- turns the facts into dated anchors so the calendar can show when work lands
-- instead of spreading a monthly total flat across the weeks.

-- -----------------------------------------------------------------------------
-- 1. Structural attributes
-- -----------------------------------------------------------------------------
-- All nullable: nothing blocks on them, and a NULL simply means the anchor is
-- not derivable yet so it is not drawn. Filled from Fortnox where possible,
-- otherwise through the bekräfta-flow.

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS moms_period TEXT
    CHECK (moms_period IN ('manad', 'kvartal', 'helar')),
  ADD COLUMN IF NOT EXISTS has_payroll BOOLEAN,
  ADD COLUMN IF NOT EXISTS payroll_run_day INTEGER DEFAULT 25
    CHECK (payroll_run_day BETWEEN 1 AND 31),
  ADD COLUMN IF NOT EXISTS bookkeeping_frequency TEXT
    CHECK (bookkeeping_frequency IN ('manad', 'kvartal'));

COMMENT ON COLUMN customers.moms_period IS
  'Redovisningsperiod för moms. Drives the 12th-of-the-month anchor; NULL = unknown, no anchor drawn.';
COMMENT ON COLUMN customers.has_payroll IS
  'Whether Saldo runs payroll for this customer. Drives both the löne-anchor and the AGI anchor.';
COMMENT ON COLUMN customers.payroll_run_day IS
  'Day of month the salaries are paid. Default 25, the Swedish norm.';

-- -----------------------------------------------------------------------------
-- 2. Frequency on the captured recurring work
-- -----------------------------------------------------------------------------
-- The bekräfta-sheet has to show its own evidence — "8 av 12 mån" is what makes
-- a proposed row confirmable in a couple of seconds instead of requiring the
-- manager to go and check Fortnox.

ALTER TABLE customer_recurring_work
  ADD COLUMN IF NOT EXISTS months_seen INTEGER,
  ADD COLUMN IF NOT EXISTS months_total INTEGER;

COMMENT ON COLUMN customer_recurring_work.months_seen IS
  'How many of the last 12 months this activity was logged in, at proposal time.';
COMMENT ON COLUMN customer_recurring_work.months_total IS
  'How many months of history the proposal was measured over (≤12).';

-- -----------------------------------------------------------------------------
-- 3. Proposal, now with median hours and its own evidence
-- -----------------------------------------------------------------------------
-- Median rather than mean per month: a single bokslutsmånad inside a löpande
-- activity would otherwise drag the typical month up by half. Existing rows are
-- still never overwritten — a confirmed number is a human decision.

CREATE OR REPLACE FUNCTION propose_recurring_work(p_customer_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  inserted INTEGER;
BEGIN
  WITH months AS (
    SELECT COUNT(DISTINCT date_trunc('month', report_date)) AS active_months
    FROM time_reports
    WHERE customer_id = p_customer_id
      AND entry_type = 'time'
      AND report_date >= (CURRENT_DATE - INTERVAL '12 months')
  ),
  per_month AS (
    SELECT
      -- Strip the "Kundnamn - " prefix Fortnox puts on some activities so the
      -- same work groups across customers.
      btrim(regexp_replace(tr.activity, '^[^-]{1,30}\s+-\s+', '')) AS label,
      MIN(tr.activity) AS source_activity,
      date_trunc('month', tr.report_date) AS month,
      SUM(tr.hours) AS hours
    FROM time_reports tr
    WHERE tr.customer_id = p_customer_id
      AND tr.entry_type = 'time'
      AND tr.activity IS NOT NULL
      AND btrim(tr.activity) <> ''
      AND tr.report_date >= (CURRENT_DATE - INTERVAL '12 months')
    GROUP BY 1, 3
  ),
  per_activity AS (
    SELECT
      label,
      MIN(source_activity) AS source_activity,
      COUNT(*) AS months_seen,
      ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY hours)::numeric, 1) AS median_hours
    FROM per_month
    GROUP BY label
  )
  INSERT INTO customer_recurring_work (
    customer_id, label, source_activity, cadence, typical_hours, hardness, source,
    months_seen, months_total
  )
  SELECT
    p_customer_id,
    pa.label,
    pa.source_activity,
    CASE
      WHEN pa.months_seen >= m.active_months * 0.8 THEN 'manad'
      WHEN pa.months_seen >= m.active_months * 0.25 THEN 'kvartal'
      WHEN pa.months_seen >= 1 THEN 'ar'
      ELSE 'vid_behov'
    END,
    pa.median_hours,
    -- Statutory work is recognisable from the label; everything else defaults
    -- to intern, which is the safe direction: soft work is what gets moved.
    CASE
      WHEN pa.label ~* 'bokslut|årsredov|arsredov|ink2|k10|deklarat|moms|agi|arbetsgivardeklaration'
        THEN 'lagstadgad'
      ELSE 'intern'
    END,
    'derived',
    pa.months_seen,
    m.active_months
  FROM per_activity pa, months m
  WHERE m.active_months >= 3
    AND pa.months_seen >= GREATEST(m.active_months * 0.6, 2)
  ON CONFLICT (customer_id, label) DO NOTHING;

  GET DIAGNOSTICS inserted = ROW_COUNT;
  RETURN inserted;
END;
$$;

REVOKE ALL ON FUNCTION propose_recurring_work(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION propose_recurring_work(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION propose_recurring_work(UUID) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 4. Dated anchors for one month
-- -----------------------------------------------------------------------------
-- Löpande work is not evenly spread — it has a real intra-month shape, and the
-- shape is knowable once the structural attributes exist:
--
--   moms/AGI   den 12:e. Stora företag (omsättning > 40 Mkr) redovisar moms den
--              26:e; AGI stays on the 12th for everyone.
--   kvartalsmoms  12 feb / 12 maj / 17 aug / 12 nov.
--   helårsmoms    deliberately not anchored — the date depends on EU-handel and
--                 on whether it is filed with inkomstdeklarationen, and neither
--                 is stored. An invented date is worse than an empty day.
--   löner      customers.payroll_run_day, default den 25:e.
--   bokslut    engagements.deadline (deadline till kund/revisor).
--   INK2       engagements.ink2_due_date, else fiscal_year_end +
--              engagement_config.deadline_offset_months.
--
-- Hardness is about whether the date can move, not about which law wrote it:
-- lönekörningen is not lagstadgad but the payday is not ours to reschedule.

CREATE OR REPLACE FUNCTION resource_month_events(p_year INTEGER, p_month INTEGER)
RETURNS TABLE (
  customer_id UUID,
  kind TEXT,
  label TEXT,
  due_date DATE,
  hardness TEXT,
  rank INTEGER
)
LANGUAGE sql
STABLE
AS $$
  WITH period AS (
    SELECT make_date(p_year, p_month, 1) AS month_start,
           (make_date(p_year, p_month, 1) + INTERVAL '1 month - 1 day')::date AS month_end,
           date_part('day', (make_date(p_year, p_month, 1) + INTERVAL '1 month - 1 day'))::int AS days_in_month
  ),
  engagement_events AS (
    SELECT DISTINCT
      e.customer_id,
      x.kind,
      x.label,
      x.due_date,
      'lagstadgad'::TEXT AS hardness,
      x.rank
    FROM engagements e
    CROSS JOIN LATERAL (
      VALUES
        ('bokslut'::TEXT, 'Bokslut & årsredovisning'::TEXT, e.deadline, 1),
        ('ink2'::TEXT, 'INK2'::TEXT, COALESCE(
           e.ink2_due_date,
           (e.fiscal_year_end + make_interval(months => (
             SELECT deadline_offset_months FROM engagement_config WHERE id = 1
           )))::date
         ), 2)
    ) AS x(kind, label, due_date, rank), period p
    WHERE x.due_date IS NOT NULL
      AND x.due_date >= p.month_start
      AND x.due_date <= p.month_end
  ),
  payroll_events AS (
    SELECT
      c.id,
      'loner'::TEXT,
      'Löner'::TEXT,
      make_date(p_year, p_month, LEAST(COALESCE(c.payroll_run_day, 25), p.days_in_month)),
      'lagstadgad'::TEXT,
      3
    FROM customers c, period p
    WHERE c.has_payroll IS TRUE
  ),
  agi_events AS (
    SELECT
      c.id,
      'agi'::TEXT,
      'AGI'::TEXT,
      make_date(p_year, p_month, LEAST(12, p.days_in_month)),
      'lagstadgad'::TEXT,
      5
    FROM customers c, period p
    WHERE c.has_payroll IS TRUE
  ),
  moms_events AS (
    SELECT
      c.id,
      'moms'::TEXT,
      'Moms'::TEXT,
      CASE
        WHEN c.moms_period = 'manad'
          -- Stora företag (> 40 Mkr) har den 26:e som deklarationsdag.
          THEN make_date(p_year, p_month, CASE WHEN COALESCE(c.revenue, 0) > 40000000 THEN 26 ELSE 12 END)
        -- Kvartalsmoms: 12 feb, 12 maj, 17 aug, 12 nov.
        WHEN c.moms_period = 'kvartal' AND p_month = 8 THEN make_date(p_year, 8, 17)
        WHEN c.moms_period = 'kvartal' AND p_month IN (2, 5, 11) THEN make_date(p_year, p_month, 12)
        ELSE NULL
      END,
      'lagstadgad'::TEXT,
      4
    FROM customers c
    WHERE c.moms_period IN ('manad', 'kvartal')
  )
  SELECT * FROM engagement_events
  UNION ALL
  SELECT * FROM payroll_events
  UNION ALL
  SELECT * FROM agi_events
  UNION ALL
  -- Qualified: `due_date` is also an output parameter name, and an unqualified
  -- reference would be ambiguous between the two.
  SELECT * FROM moms_events WHERE moms_events.due_date IS NOT NULL;
$$;

REVOKE ALL ON FUNCTION resource_month_events(INTEGER, INTEGER) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION resource_month_events(INTEGER, INTEGER) FROM anon;
GRANT EXECUTE ON FUNCTION resource_month_events(INTEGER, INTEGER) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 5. Board read model, second cut
-- -----------------------------------------------------------------------------
-- Changes from 00112:
--
--   * The estimate is split. The total still comes from customer_kpis, so the
--     board cannot disagree with the reports page, but the split ratio comes
--     from time_reports.activity — the only place that knows which hours were
--     bokslut and which were löpande.
--   * Every customer that needs a decision is in scope, not only the ones with
--     recent hours. A vilande customer with a bokslut this month was invisible
--     before, which is precisely backwards.
--   * assessment_reason says why a card has no number, so the six bare dashes
--     become six decisions.
--   * top_activities answers "vad ska göras", which was half the brief and was
--     missing entirely.
--
-- The return type changes, so the old function has to go first.

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
           ROUND(SUM(k.total_hours) / 3.0, 1) AS est_hours
    FROM customer_kpis k, period p
    WHERE k.period_type = 'month'
      AND make_date(k.period_year, k.period_month, 1) >= date_trunc('month', p.history_start)::date
      AND make_date(k.period_year, k.period_month, 1) <= p.history_end
    GROUP BY k.customer_id
  ),
  -- What this customer needs done, in the manager's own words once confirmed
  -- and in Fortnox's words until then.
  activities AS (
    SELECT ranked.customer_id, array_agg(ranked.label ORDER BY ranked.ord, ranked.label) AS labels
    FROM (
      SELECT
        w.customer_id,
        w.label,
        ROW_NUMBER() OVER (
          PARTITION BY w.customer_id
          ORDER BY (w.confirmed_at IS NULL), COALESCE(w.typical_hours, 0) DESC, w.label
        ) AS ord
      FROM customer_recurring_work w
      WHERE w.is_active
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
      AND tr.report_date >= p.scope_start
      AND tr.report_date <= p.history_end
    UNION
    SELECT pe.customer_id FROM primary_event pe
    UNION
    SELECT rp.customer_id FROM resource_plan rp
    WHERE rp.period_year = p_year AND rp.period_month = p_month
    UNION
    SELECT DISTINCT w.customer_id FROM customer_recurring_work w WHERE w.is_active
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
    -- Why this card has no usable number. NULL means it does.
    CASE
      WHEN h.customer_id IS NULL THEN 'ingen_historik'
      WHEN h.first_date >= (SELECT history_start FROM period)
        OR (c.start_date IS NOT NULL AND c.start_date >= (SELECT scope_start FROM period))
        THEN 'ny_kund'
      WHEN COALESCE(tot.est_hours, 0) = 0 THEN 'vilande'
      WHEN COALESCE(plan.planned_hours, tot.est_hours, 0) < 2 THEN 'for_lite_historik'
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
