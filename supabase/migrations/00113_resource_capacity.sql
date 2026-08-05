-- =====================================================
-- Migration 00113: Capacity — the denominator the board was missing
-- =====================================================
-- 00112 shipped "Planerat: 80,4 h" with nothing to divide it by. Half a month
-- or double? Nobody could tell, which meant the board could not answer the one
-- question it exists for: hinner vi?
--
-- Capacity is three inputs, and all three were missing:
--
--   arbetsdagar     Calendar workdays minus svenska helgdagar. Easter moves,
--                   so the dates are seeded (2025–2028) rather than computed —
--                   a Gauss/Butcher implementation in TS or plpgsql is a lot of
--                   surface for four years of constants.
--   FTE             profiles.weekly_hours. NULL = the firm default, so nothing
--                   breaks before HR fills it in.
--   debiteringsgrad profiles.billable_target. Same NULL-means-default rule.
--
-- And then subtract planerad frånvaro. Without it, August capacity is fiction:
-- semester is the single biggest swing in a Swedish byrå's year, and a July
-- column looks overloaded because the denominator is wrong, not because the
-- work is.
--
-- Historical absence already exists as time_reports.entry_type = 'absence'.
-- That is a record of what happened, not a plan — it is useful for sanity
-- checking these numbers and is deliberately NOT read as future leave.

-- -----------------------------------------------------------------------------
-- 1. Firm defaults
-- -----------------------------------------------------------------------------
-- Singleton, same shape as engagement_config: one row, id = 1, edited in
-- settings rather than redeployed.

CREATE TABLE IF NOT EXISTS resource_config (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- Heltid enligt kollektivavtal.
  default_weekly_hours NUMERIC(6, 2) NOT NULL DEFAULT 40,
  -- The share of paid time that is expected to reach a customer. The remaining
  -- quarter is internal work, utbildning, sjukdom and the urgent things nobody
  -- forecasts — planning against 100% guarantees a red month every month.
  default_billable_target NUMERIC(4, 3) NOT NULL DEFAULT 0.75,
  updated_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT resource_config_target_range
    CHECK (default_billable_target > 0 AND default_billable_target <= 1)
);

INSERT INTO resource_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

DROP TRIGGER IF EXISTS resource_config_set_updated_at ON resource_config;
CREATE TRIGGER resource_config_set_updated_at
  BEFORE UPDATE ON resource_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- -----------------------------------------------------------------------------
-- 2. Per-person capacity inputs
-- -----------------------------------------------------------------------------
-- Nullable on purpose: NULL means "the firm default applies", which is both the
-- honest state today and the state most people will stay in. Only deviations
-- (80%, föräldraledig på deltid, a senior with a lower billable target) need a
-- value.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS weekly_hours NUMERIC(6, 2),
  ADD COLUMN IF NOT EXISTS billable_target NUMERIC(4, 3);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_weekly_hours_range'
  ) THEN
    ALTER TABLE profiles
      ADD CONSTRAINT profiles_weekly_hours_range
      CHECK (weekly_hours IS NULL OR (weekly_hours > 0 AND weekly_hours <= 80));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_billable_target_range'
  ) THEN
    ALTER TABLE profiles
      ADD CONSTRAINT profiles_billable_target_range
      CHECK (billable_target IS NULL OR (billable_target > 0 AND billable_target <= 1));
  END IF;
END
$$;

COMMENT ON COLUMN profiles.weekly_hours IS
  'Contracted hours per week. NULL = resource_config.default_weekly_hours.';
COMMENT ON COLUMN profiles.billable_target IS
  'Share of paid time planned as customer work, 0–1. NULL = resource_config.default_billable_target.';

-- -----------------------------------------------------------------------------
-- 3. Svenska helgdagar
-- -----------------------------------------------------------------------------
-- Seeded, not computed. Påsk anchors six of the year's free days and moves by
-- the ecclesiastical lunar calendar; four years of constants is smaller and far
-- easier to verify than an Easter algorithm nobody will read again.
--
-- De facto arbetsfria dagar (midsommarafton, julafton, nyårsafton) are included
-- alongside the röda dagar, because for capacity purposes what matters is
-- whether anyone is at their desk, not what the almanacka calls the day.
--
-- Rows that fall on a weekend cost nothing: the capacity function only counts
-- Monday–Friday, so a Saturday midsommardagen is stored and ignored.

CREATE TABLE IF NOT EXISTS swedish_holidays (
  date DATE PRIMARY KEY,
  name TEXT NOT NULL,
  -- false for de facto free days (aftnar), true for the statutory röda dagar.
  is_public_holiday BOOLEAN NOT NULL DEFAULT true
);

INSERT INTO swedish_holidays (date, name, is_public_holiday) VALUES
  -- 2025 (påskdagen 20 april)
  ('2025-01-01', 'Nyårsdagen', true),
  ('2025-01-06', 'Trettondedag jul', true),
  ('2025-04-18', 'Långfredagen', true),
  ('2025-04-20', 'Påskdagen', true),
  ('2025-04-21', 'Annandag påsk', true),
  ('2025-05-01', 'Första maj', true),
  ('2025-05-29', 'Kristi himmelsfärdsdag', true),
  ('2025-06-06', 'Sveriges nationaldag', true),
  ('2025-06-08', 'Pingstdagen', true),
  ('2025-06-20', 'Midsommarafton', false),
  ('2025-06-21', 'Midsommardagen', true),
  ('2025-11-01', 'Alla helgons dag', true),
  ('2025-12-24', 'Julafton', false),
  ('2025-12-25', 'Juldagen', true),
  ('2025-12-26', 'Annandag jul', true),
  ('2025-12-31', 'Nyårsafton', false),

  -- 2026 (påskdagen 5 april)
  ('2026-01-01', 'Nyårsdagen', true),
  ('2026-01-06', 'Trettondedag jul', true),
  ('2026-04-03', 'Långfredagen', true),
  ('2026-04-05', 'Påskdagen', true),
  ('2026-04-06', 'Annandag påsk', true),
  ('2026-05-01', 'Första maj', true),
  ('2026-05-14', 'Kristi himmelsfärdsdag', true),
  ('2026-05-24', 'Pingstdagen', true),
  ('2026-06-06', 'Sveriges nationaldag', true),
  ('2026-06-19', 'Midsommarafton', false),
  ('2026-06-20', 'Midsommardagen', true),
  ('2026-10-31', 'Alla helgons dag', true),
  ('2026-12-24', 'Julafton', false),
  ('2026-12-25', 'Juldagen', true),
  ('2026-12-26', 'Annandag jul', true),
  ('2026-12-31', 'Nyårsafton', false),

  -- 2027 (påskdagen 28 mars)
  ('2027-01-01', 'Nyårsdagen', true),
  ('2027-01-06', 'Trettondedag jul', true),
  ('2027-03-26', 'Långfredagen', true),
  ('2027-03-28', 'Påskdagen', true),
  ('2027-03-29', 'Annandag påsk', true),
  ('2027-05-01', 'Första maj', true),
  ('2027-05-06', 'Kristi himmelsfärdsdag', true),
  ('2027-05-16', 'Pingstdagen', true),
  ('2027-06-06', 'Sveriges nationaldag', true),
  ('2027-06-25', 'Midsommarafton', false),
  ('2027-06-26', 'Midsommardagen', true),
  ('2027-11-06', 'Alla helgons dag', true),
  ('2027-12-24', 'Julafton', false),
  ('2027-12-25', 'Juldagen', true),
  ('2027-12-26', 'Annandag jul', true),
  ('2027-12-31', 'Nyårsafton', false),

  -- 2028 (påskdagen 16 april)
  ('2028-01-01', 'Nyårsdagen', true),
  ('2028-01-06', 'Trettondedag jul', true),
  ('2028-04-14', 'Långfredagen', true),
  ('2028-04-16', 'Påskdagen', true),
  ('2028-04-17', 'Annandag påsk', true),
  ('2028-05-01', 'Första maj', true),
  ('2028-05-25', 'Kristi himmelsfärdsdag', true),
  ('2028-06-04', 'Pingstdagen', true),
  ('2028-06-06', 'Sveriges nationaldag', true),
  ('2028-06-23', 'Midsommarafton', false),
  ('2028-06-24', 'Midsommardagen', true),
  ('2028-11-04', 'Alla helgons dag', true),
  ('2028-12-24', 'Julafton', false),
  ('2028-12-25', 'Juldagen', true),
  ('2028-12-26', 'Annandag jul', true),
  ('2028-12-31', 'Nyårsafton', false)
ON CONFLICT (date) DO UPDATE
  SET name = EXCLUDED.name,
      is_public_holiday = EXCLUDED.is_public_holiday;

-- -----------------------------------------------------------------------------
-- 4. Planerad frånvaro
-- -----------------------------------------------------------------------------
-- A human decision, so it gets its own table and a nightly re-sync of the
-- estimates can never touch it — the same split 00112 made between
-- resource_plan and the computed board.

CREATE TABLE IF NOT EXISTS absences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  type TEXT NOT NULL DEFAULT 'semester'
    CHECK (type IN ('semester', 'sjuk', 'foraldraledig', 'ovrigt')),
  note TEXT,
  created_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT absences_range CHECK (end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS idx_absences_profile_period
  ON absences(profile_id, start_date, end_date);

DROP TRIGGER IF EXISTS absences_set_updated_at ON absences;
CREATE TRIGGER absences_set_updated_at
  BEFORE UPDATE ON absences
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS: everyone on staff sees everyone's frånvaro — that is the whole point,
-- you cannot reallocate around leave you cannot see. Writing is your own row,
-- or anyone's if you are admin.

ALTER TABLE resource_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE swedish_holidays ENABLE ROW LEVEL SECURITY;
ALTER TABLE absences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS resource_config_select ON resource_config;
CREATE POLICY resource_config_select ON resource_config
  FOR SELECT USING (is_staff());

DROP POLICY IF EXISTS resource_config_write ON resource_config;
CREATE POLICY resource_config_write ON resource_config
  FOR ALL USING (get_user_role() = 'admin') WITH CHECK (get_user_role() = 'admin');

DROP POLICY IF EXISTS swedish_holidays_select ON swedish_holidays;
CREATE POLICY swedish_holidays_select ON swedish_holidays
  FOR SELECT USING (is_staff());

DROP POLICY IF EXISTS swedish_holidays_write ON swedish_holidays;
CREATE POLICY swedish_holidays_write ON swedish_holidays
  FOR ALL USING (get_user_role() = 'admin') WITH CHECK (get_user_role() = 'admin');

DROP POLICY IF EXISTS absences_select ON absences;
CREATE POLICY absences_select ON absences
  FOR SELECT USING (is_staff());

DROP POLICY IF EXISTS absences_write_own ON absences;
CREATE POLICY absences_write_own ON absences
  FOR ALL
  USING (
    get_user_role() = 'admin'
    OR (has_scope('customers') AND profile_id = auth.uid())
  )
  WITH CHECK (
    get_user_role() = 'admin'
    OR (has_scope('customers') AND profile_id = auth.uid())
  );

-- -----------------------------------------------------------------------------
-- 5. The capacity function
-- -----------------------------------------------------------------------------
--   available_h = (arbetsdagar − helgdagar − planerad frånvaro)
--                 × (weekly_hours / 5)
--                 × billable_target
--
-- Returned per person rather than as a firm total, because the board needs it
-- per column: the answer to "hinner vi" is nearly always "someone does and
-- someone doesn't", and a firm average hides exactly that.

CREATE OR REPLACE FUNCTION resource_capacity(p_year INTEGER, p_month INTEGER)
RETURNS TABLE (
  profile_id UUID,
  profile_name TEXT,
  workdays INTEGER,
  holiday_days INTEGER,
  absence_days INTEGER,
  weekly_hours NUMERIC,
  billable_target NUMERIC,
  available_hours NUMERIC
)
LANGUAGE sql
STABLE
AS $$
  WITH cfg AS (
    SELECT default_weekly_hours, default_billable_target
    FROM resource_config WHERE id = 1
  ),
  period AS (
    SELECT make_date(p_year, p_month, 1) AS month_start,
           (make_date(p_year, p_month, 1) + INTERVAL '1 month - 1 day')::date AS month_end
  ),
  weekdays AS (
    SELECT d::date AS day
    FROM period p, generate_series(p.month_start, p.month_end, INTERVAL '1 day') d
    WHERE EXTRACT(ISODOW FROM d) < 6
  ),
  counted AS (
    SELECT
      COUNT(*) FILTER (WHERE h.date IS NULL)::INTEGER AS workdays,
      COUNT(*) FILTER (WHERE h.date IS NOT NULL)::INTEGER AS holiday_days
    FROM weekdays w
    LEFT JOIN swedish_holidays h ON h.date = w.day
  )
  SELECT
    pr.id,
    pr.full_name,
    c.workdays,
    c.holiday_days,
    absent.days,
    COALESCE(pr.weekly_hours, cfg.default_weekly_hours),
    COALESCE(pr.billable_target, cfg.default_billable_target),
    ROUND(
      GREATEST(c.workdays - absent.days, 0)
        * (COALESCE(pr.weekly_hours, cfg.default_weekly_hours) / 5.0)
        * COALESCE(pr.billable_target, cfg.default_billable_target),
      1
    )
  FROM profiles pr
  CROSS JOIN cfg
  CROSS JOIN counted c
  CROSS JOIN LATERAL (
    -- DISTINCT so two overlapping absences (sjuk inside a semester) do not
    -- subtract the same day twice and push capacity negative.
    SELECT COUNT(DISTINCT w.day)::INTEGER AS days
    FROM weekdays w
    JOIN absences a
      ON a.profile_id = pr.id
     AND w.day BETWEEN a.start_date AND a.end_date
    WHERE NOT EXISTS (SELECT 1 FROM swedish_holidays h WHERE h.date = w.day)
  ) AS absent
  WHERE pr.is_active;
$$;

REVOKE ALL ON FUNCTION resource_capacity(INTEGER, INTEGER) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION resource_capacity(INTEGER, INTEGER) FROM anon;
GRANT EXECUTE ON FUNCTION resource_capacity(INTEGER, INTEGER) TO authenticated, service_role;
