-- =====================================================
-- Migration 00112: Beläggning (resource planning)
-- =====================================================
-- A month-at-a-time view of what each customer will need and who will do it.
--
-- The modelling follows one finding from the historical data: a customer's
-- monthly hours are two different things stacked on top of each other, and
-- they behave nothing alike.
--
--   Löpande        84% of all logged hours. Driven by structural facts —
--                  momsperiod, antal anställda, bokföringsfrekvens. Those
--                  attributes are NOT captured anywhere today, which is why a
--                  mean-of-last-3-months estimate sits at ±38% per customer
--                  (and ±73% for customers under 2 h/mån). This migration
--                  therefore ships the capture surface, not a better model:
--                  `customer_recurring_work` is filled from what people have
--                  actually logged and then confirmed by a human.
--
--   Händelsestyrt  16% of hours: bokslut, årsredovisning, INK2, K10. Not
--                  averageable, but it does not need to be — every one of them
--                  is anchored to that customer's own räkenskapsårsslut. The
--                  effort curve measured across 2025 puts 87% of a customer's
--                  event hours in months +2 to +6 after their year-end.
--
-- The board therefore reads dates from `engagements` (real, per customer) and
-- hours from history (crude, clearly labelled), rather than pretending to one
-- blended number.
--
-- Nothing here writes to `time_reports`, `customer_kpis` or `engagements`
-- beyond the two additive INK2 columns below. The estimates are computed on
-- read; only human decisions are stored.

-- -----------------------------------------------------------------------------
-- 1. INK2 gets its own due date
-- -----------------------------------------------------------------------------
-- The INK2 pipeline has a status ladder but no date at all, so an INK2 card
-- cannot be placed in a month. Saldo works to an internal deadline
-- (fiscal_year_end + engagement_config.deadline_offset_months, default 3 →
-- 31 mars for a 31/12 customer), which is months earlier than the statutory
-- one. Planning happens against the internal date; the statutory date is only
-- useful as a backstop, to tell "past our deadline" from "legally at risk".
--
-- `ink2_due_source` records which of the three a date came from. Byråanstånd
-- is not tracked anywhere in the system today — if the firm holds one, its
-- batch date goes in here and becomes the best planning signal available. If
-- they do not, the computed internal default already stands and nothing about
-- this migration has to change.

ALTER TABLE engagements
  ADD COLUMN IF NOT EXISTS ink2_due_date DATE,
  ADD COLUMN IF NOT EXISTS ink2_due_source TEXT
    CHECK (ink2_due_source IN ('byraanstand', 'statutory', 'intern'));

COMMENT ON COLUMN engagements.ink2_due_date IS
  'When INK2 is due for this engagement. NULL = fall back to the computed internal date (fiscal_year_end + engagement_config.deadline_offset_months).';
COMMENT ON COLUMN engagements.ink2_due_source IS
  'Where ink2_due_date came from: byraanstand (byråns anståndsbatch), statutory (Skatteverkets datum), intern (Saldos egen deadline).';

-- -----------------------------------------------------------------------------
-- 2. Planning statuses
-- -----------------------------------------------------------------------------
-- A table rather than an enum, matching task_statuses / engagement_statuses, so
-- the firm can rename and reorder without a code change.

CREATE TABLE IF NOT EXISTS resource_statuses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_done BOOLEAN NOT NULL DEFAULT false,
  color TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO resource_statuses (key, label, sort_order, is_done) VALUES
  ('ej_planerad', 'Ej planerad', 10, false),
  ('planerad',    'Planerad',    20, false),
  ('pagar',       'Pågår',       30, false),
  ('klar',        'Klar',        40, true)
ON CONFLICT (key)
  DO UPDATE SET
    label = EXCLUDED.label,
    sort_order = EXCLUDED.sort_order,
    is_done = EXCLUDED.is_done;

-- -----------------------------------------------------------------------------
-- 3. Recurring work per customer (the capture surface)
-- -----------------------------------------------------------------------------
-- Deliberately NOT `customer_services`: that table is shaped for the agreement
-- side (service_type, price, billing_model) and is empty. This one is about
-- workload — how often a thing recurs and how many hours it usually takes.
--
-- Rows start as `derived`, proposed from the customer's own logged activities,
-- and become trustworthy only when a human confirms them. `confirmed_at` being
-- NULL is meaningful and is shown on the card: it is the difference between
-- "we think" and "we know".
--
-- `hardness` drives the one decision the board exists to support: when a month
-- is overloaded, the soft work moves and the lagstadgade work does not.

CREATE TABLE IF NOT EXISTS customer_recurring_work (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

  -- Display label, normalised. Fortnox prefixes some activities with the
  -- client's own name ("Omega - Löpande redovisningsarbete"); the proposal
  -- step strips that so the same work groups across customers.
  label TEXT NOT NULL,
  -- The raw Fortnox activity this was derived from, kept for traceability.
  source_activity TEXT,

  cadence TEXT NOT NULL DEFAULT 'manad'
    CHECK (cadence IN ('manad', 'kvartal', 'ar', 'vid_behov')),
  typical_hours NUMERIC(10, 2),
  hardness TEXT NOT NULL DEFAULT 'intern'
    CHECK (hardness IN ('lagstadgad', 'intern')),

  source TEXT NOT NULL DEFAULT 'derived'
    CHECK (source IN ('derived', 'manual')),
  is_active BOOLEAN NOT NULL DEFAULT true,

  confirmed_at TIMESTAMPTZ,
  confirmed_by UUID REFERENCES profiles(id) ON DELETE SET NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT customer_recurring_work_label_not_blank CHECK (length(btrim(label)) > 0),
  CONSTRAINT customer_recurring_work_unique UNIQUE (customer_id, label)
);

CREATE INDEX IF NOT EXISTS idx_recurring_work_customer
  ON customer_recurring_work(customer_id) WHERE is_active;

DROP TRIGGER IF EXISTS customer_recurring_work_set_updated_at ON customer_recurring_work;
CREATE TRIGGER customer_recurring_work_set_updated_at
  BEFORE UPDATE ON customer_recurring_work
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- -----------------------------------------------------------------------------
-- 4. The plan itself — one row per customer and month
-- -----------------------------------------------------------------------------
-- Only human decisions live here. `planned_hours` NULL means "the estimate is
-- fine, nobody has argued with it", so a re-run of the estimate never
-- overwrites a manager's number and an untouched month costs no storage.
--
-- `assignee_id` is the UTFÖRARE — who will do the work. That is a different
-- axis from the kundansvarig (which comes from customers.fortnox_cost_center),
-- and conflating them breaks the moment an assistant does löpande under a
-- senior's cost center. time_reports.employee_id → profiles.fortnox_user_id
-- already resolves 100% of recent rows, so both axes exist today.

CREATE TABLE IF NOT EXISTS resource_plan (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  period_year INTEGER NOT NULL,
  period_month INTEGER NOT NULL CHECK (period_month BETWEEN 1 AND 12),

  planned_hours NUMERIC(10, 2),
  assignee_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  status_id UUID REFERENCES resource_statuses(id) ON DELETE SET NULL,
  status_changed_at TIMESTAMPTZ,
  note TEXT,
  position DOUBLE PRECISION,

  created_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT resource_plan_period_unique UNIQUE (customer_id, period_year, period_month)
);

CREATE INDEX IF NOT EXISTS idx_resource_plan_period
  ON resource_plan(period_year, period_month);
CREATE INDEX IF NOT EXISTS idx_resource_plan_assignee
  ON resource_plan(assignee_id) WHERE assignee_id IS NOT NULL;

DROP TRIGGER IF EXISTS resource_plan_set_updated_at ON resource_plan;
CREATE TRIGGER resource_plan_set_updated_at
  BEFORE UPDATE ON resource_plan
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE FUNCTION resource_plan_stamp_status_change()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status_id IS NOT NULL AND NEW.status_changed_at IS NULL THEN
      NEW.status_changed_at = now();
    END IF;
  ELSIF NEW.status_id IS DISTINCT FROM OLD.status_id THEN
    NEW.status_changed_at = now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS resource_plan_stamp_status ON resource_plan;
CREATE TRIGGER resource_plan_stamp_status
  BEFORE INSERT OR UPDATE ON resource_plan
  FOR EACH ROW EXECUTE FUNCTION resource_plan_stamp_status_change();

-- -----------------------------------------------------------------------------
-- 5. RLS
-- -----------------------------------------------------------------------------
-- Firm-wide read and write, matching the task board: planning is only useful if
-- everyone can see where the work sits and pick it up when someone is away.

ALTER TABLE resource_statuses ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_recurring_work ENABLE ROW LEVEL SECURITY;
ALTER TABLE resource_plan ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS resource_statuses_select ON resource_statuses;
CREATE POLICY resource_statuses_select ON resource_statuses
  FOR SELECT USING (is_staff());

DROP POLICY IF EXISTS customer_recurring_work_select ON customer_recurring_work;
CREATE POLICY customer_recurring_work_select ON customer_recurring_work
  FOR SELECT USING (is_staff());

DROP POLICY IF EXISTS customer_recurring_work_write ON customer_recurring_work;
CREATE POLICY customer_recurring_work_write ON customer_recurring_work
  FOR ALL USING (is_staff()) WITH CHECK (is_staff());

DROP POLICY IF EXISTS resource_plan_select ON resource_plan;
CREATE POLICY resource_plan_select ON resource_plan
  FOR SELECT USING (is_staff());

DROP POLICY IF EXISTS resource_plan_write ON resource_plan;
CREATE POLICY resource_plan_write ON resource_plan
  FOR ALL USING (is_staff()) WITH CHECK (is_staff());

-- -----------------------------------------------------------------------------
-- 6. Board read model
-- -----------------------------------------------------------------------------
-- A function rather than a view because the board is always about one month,
-- and a view cannot take the period as a parameter. SECURITY INVOKER (the
-- default) so the caller's RLS applies — deliberately unlike the SECURITY
-- DEFINER helpers that 00109 had to lock down after the fact.
--
-- Scope: customers with hours logged in the last 3 complete months. Of 1 916
-- customers only ~317 are active by that test, and 315 of those resolve to a
-- kundansvarig — the ~400 without a cost center are almost entirely vilande
-- and holdingbolag, so scoping by activity removes the mapping gap instead of
-- waiting on a cleanup.
--
-- The löpande estimate is the mean of the last 3 COMPLETE months (the running
-- month is always partial and would drag every estimate low). It is crude on
-- purpose: per customer it is ±38%, but summed over a manager's portfolio it
-- lands at ~17%, and the portfolio total is what the board is actually for.

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
  planned_hours NUMERIC,
  effective_hours NUMERIC,

  recurring_total INTEGER,
  recurring_confirmed INTEGER,

  event_label TEXT,
  event_due_date DATE,
  event_hardness TEXT,

  fixed_monthly_price NUMERIC,
  note TEXT,
  -- Quoted: `position` is a col_name_keyword. Postgres accepts it as a table
  -- column (tasks.position, engagements' board position) but rejects it bare as
  -- a function output parameter name. Quoting keeps the returned field called
  -- `position`, so the client type is unaffected.
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
           (date_trunc('month', CURRENT_DATE) - INTERVAL '1 day')::date AS history_end
  ),
  active_customers AS (
    SELECT DISTINCT tr.customer_id
    FROM time_reports tr, period p
    WHERE tr.customer_id IS NOT NULL
      AND tr.entry_type = 'time'
      AND tr.report_date >= p.history_start
      AND tr.report_date <= p.history_end
  ),
  lopande AS (
    -- Mean monthly hours over the same 3-month window. customer_kpis is the
    -- rollup the rest of the app reads, so the board cannot disagree with the
    -- reports page about how many hours a customer had.
    SELECT k.customer_id,
           ROUND(SUM(k.total_hours) / 3.0, 1) AS est_hours
    FROM customer_kpis k, period p
    WHERE k.period_type = 'month'
      AND make_date(k.period_year, k.period_month, 1) >= date_trunc('month', p.history_start)::date
      AND make_date(k.period_year, k.period_month, 1) <= p.history_end
    GROUP BY k.customer_id
  ),
  events AS (
    -- One händelsestyrd anchor per customer per month, taken from the real
    -- engagement dates. Bokslut uses the existing deadline (Deadline till
    -- kund/revisor); INK2 uses its new column, falling back to the internal
    -- computed date. Both are lagstadgad work with a soft internal date, which
    -- is exactly why the card carries the hardness flag.
    SELECT DISTINCT ON (e.customer_id)
           e.customer_id,
           x.label,
           x.due_date,
           'lagstadgad'::TEXT AS hardness
    FROM engagements e
    CROSS JOIN LATERAL (
      VALUES
        ('Bokslut & årsredovisning'::TEXT, e.deadline),
        ('INK2'::TEXT, COALESCE(
           e.ink2_due_date,
           (e.fiscal_year_end + make_interval(months => (
             SELECT deadline_offset_months FROM engagement_config WHERE id = 1
           )))::date
         ))
    ) AS x(label, due_date), period p
    WHERE x.due_date IS NOT NULL
      AND x.due_date >= p.month_start
      AND x.due_date <= p.month_end
    ORDER BY e.customer_id, x.due_date
  ),
  recurring AS (
    SELECT w.customer_id,
           COUNT(*)::INTEGER AS total,
           COUNT(*) FILTER (WHERE w.confirmed_at IS NOT NULL)::INTEGER AS confirmed
    FROM customer_recurring_work w
    WHERE w.is_active
    GROUP BY w.customer_id
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
    COALESCE(l.est_hours, 0),
    plan.planned_hours,
    COALESCE(plan.planned_hours, l.est_hours, 0),
    COALESCE(r.total, 0),
    COALESCE(r.confirmed, 0),
    ev.label,
    ev.due_date,
    ev.hardness,
    c.fixed_monthly_price,
    plan.note,
    plan.position
  FROM active_customers ac
  JOIN customers c ON c.id = ac.customer_id
  LEFT JOIN lopande l ON l.customer_id = c.id
  LEFT JOIN events ev ON ev.customer_id = c.id
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

-- -----------------------------------------------------------------------------
-- 7. Proposing recurring work from what people actually logged
-- -----------------------------------------------------------------------------
-- Fills customer_recurring_work with `derived` rows for one customer, from the
-- last 12 months of their own time entries. Measured across the firm, activity
-- labels that recur in ≥60% of a customer's active months hold 75% of all
-- hours — so this threshold proposes few rows and still covers most of the
-- work. Cadence is inferred from the same frequency.
--
-- Never overwrites: ON CONFLICT DO NOTHING, so a confirmed row keeps whatever
-- the human decided and re-running is safe.

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
  per_activity AS (
    SELECT
      -- Strip the "Kundnamn - " prefix Fortnox puts on some activities so the
      -- same work groups across customers.
      btrim(regexp_replace(tr.activity, '^[^-]{1,30}\s+-\s+', '')) AS label,
      tr.activity AS source_activity,
      COUNT(DISTINCT date_trunc('month', tr.report_date)) AS months_seen,
      SUM(tr.hours) AS total_hours
    FROM time_reports tr
    WHERE tr.customer_id = p_customer_id
      AND tr.entry_type = 'time'
      AND tr.activity IS NOT NULL
      AND btrim(tr.activity) <> ''
      AND tr.report_date >= (CURRENT_DATE - INTERVAL '12 months')
    GROUP BY 1, 2
  )
  INSERT INTO customer_recurring_work (
    customer_id, label, source_activity, cadence, typical_hours, hardness, source
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
    ROUND(pa.total_hours / GREATEST(pa.months_seen, 1), 1),
    -- Statutory work is recognisable from the label; everything else defaults
    -- to intern, which is the safe direction: soft work is what gets moved.
    CASE
      WHEN pa.label ~* 'bokslut|årsredov|arsredov|ink2|k10|deklarat|moms|agi|arbetsgivardeklaration'
        THEN 'lagstadgad'
      ELSE 'intern'
    END,
    'derived'
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
