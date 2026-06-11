-- =====================================================
-- Migration 00066: Engagements (Bokslut + INK2 workflow board)
-- =====================================================
--
-- Replaces the manual "Effektivitet 2026" Excel tracker with a structured,
-- per-client year-end workflow that the app renders as a Trello/Notion-style
-- board. Each engagement is one customer for one fiscal year and carries TWO
-- parallel pipelines:
--   • Bokslut (year-end close)        — the primary, longer pipeline.
--   • INK2   (income-tax declaration) — the secondary pipeline.
--
-- Statuses live in a lookup table (engagement_statuses) so the firm can rename
-- or reorder stages without a code change — mirroring the editable dropdown
-- list on the Excel "Information" sheet.
--
-- Conventions follow the rest of the schema: UUID PKs, update_updated_at()
-- trigger, get_user_role()/has_scope('customers') for RLS.

-- -----------------------------------------------------------------------------
-- 1. Status lookup
-- -----------------------------------------------------------------------------
-- One row per (workflow, key). The board reads label + sort_order from here.
-- `is_done` marks a terminal "finished" stage (drives overdue logic and column
-- styling); `is_parked` marks the "Ej aktuell" escape hatch.

CREATE TABLE IF NOT EXISTS engagement_statuses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow TEXT NOT NULL CHECK (workflow IN ('bokslut', 'ink2')),
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_done BOOLEAN NOT NULL DEFAULT false,
  is_parked BOOLEAN NOT NULL DEFAULT false,
  -- Optional UI accent; semantic token name or hex, resolved by the client.
  color TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_engagement_statuses_workflow_key
  ON engagement_statuses(workflow, key);

-- Seed from the Excel "Information" sheet. Idempotent: re-running updates the
-- label / ordering / flags so the canonical list always matches this file.
INSERT INTO engagement_statuses (workflow, key, label, sort_order, is_done, is_parked) VALUES
  ('bokslut', 'paborjad',                 'Påbörjad',                          10, false, false),
  ('bokslut', 'invantar_material',        'Inväntar material',                 20, false, false),
  ('bokslut', 'klar_for_granskning',      'Klar för granskning',               30, false, false),
  ('bokslut', 'granskad',                 'Granskad',                          40, false, false),
  ('bokslut', 'bokslutsmote_revisor',     'Bokslutsmöte/Skickad till revisor', 50, false, false),
  ('bokslut', 'skickad_bolagsverket',     'Skickad till Bolagsverket',         60, false, false),
  ('bokslut', 'registrerad_bolagsverket', 'Registrerad hos Bolagsverket',      70, true,  false),
  ('bokslut', 'ej_aktuell',               'Ej aktuell',                        99, false, true),
  ('ink2',    'klar_for_granskning',      'Klar för granskning',               10, false, false),
  ('ink2',    'granskad',                 'Granskad',                          20, false, false),
  ('ink2',    'klar_for_inlamning',       'Klar för inlämning',                30, false, false),
  ('ink2',    'inlamnad',                 'Inlämnad',                          40, true,  false)
ON CONFLICT (workflow, key)
  DO UPDATE SET
    label = EXCLUDED.label,
    sort_order = EXCLUDED.sort_order,
    is_done = EXCLUDED.is_done,
    is_parked = EXCLUDED.is_parked;

-- -----------------------------------------------------------------------------
-- 2. Board-level config (singleton)
-- -----------------------------------------------------------------------------
-- Holds settings that apply to the whole board — chiefly the active fiscal year
-- the board defaults to, and the definition of the onboarding/setup checklist
-- (the long Ja/Nej column block in the Excel). Storing the checklist *shape*
-- here (rather than as dozens of columns) lets the firm add/rename items
-- without a migration; the per-engagement answers live in engagements.setup.

CREATE TABLE IF NOT EXISTS engagement_config (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  active_fiscal_year_end DATE NOT NULL DEFAULT '2025-12-31',
  checklist_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS engagement_config_set_updated_at ON engagement_config;
CREATE TRIGGER engagement_config_set_updated_at
  BEFORE UPDATE ON engagement_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Seed the singleton row with the checklist taken from the Excel header block.
INSERT INTO engagement_config (id, active_fiscal_year_end, checklist_fields) VALUES (
  1,
  '2025-12-31',
  '[
    {"key": "kundfakt",        "label": "Kundfakt",              "group": "Underlag"},
    {"key": "levfakt",         "label": "Levfakt",               "group": "Underlag"},
    {"key": "kvitton",         "label": "Kvitton",               "group": "Underlag"},
    {"key": "lon",             "label": "Lön",                   "group": "Underlag"},
    {"key": "reda",            "label": "Reda",                  "group": "System"},
    {"key": "mynt",            "label": "Mynt",                  "group": "System"},
    {"key": "bankkoppling",    "label": "Bankkoppling",          "group": "System"},
    {"key": "transaktioner",   "label": "Transaktioner",         "group": "System"},
    {"key": "a_bank",          "label": "A Bank",                "group": "Behörighet"},
    {"key": "a_skv",           "label": "A SKV",                 "group": "Behörighet"},
    {"key": "k_bank",          "label": "K Bank",                "group": "Behörighet"},
    {"key": "k_skv",           "label": "K SKV",                 "group": "Behörighet"},
    {"key": "capego_fokus_gl", "label": "Capego Fokus + GL",     "group": "Behörighet"},
    {"key": "fortnox_behoriga","label": "Fortnox alla behöriga", "group": "Behörighet"},
    {"key": "saldoavtal",      "label": "Saldoavtal",            "group": "Avtal"},
    {"key": "aktiebok",        "label": "Aktiebok",              "group": "Avtal"}
  ]'::jsonb
)
ON CONFLICT (id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 3. Engagements
-- -----------------------------------------------------------------------------
-- One row per (customer, fiscal_year_end). bokslut/ink2 status point at the
-- lookup; *_status_changed_at are stamped automatically by trigger (the Excel
-- "Datum senaste statusuppdatering"). The setup checklist answers are a JSONB
-- map keyed by engagement_config.checklist_fields[].key → 'yes' | 'no' | 'na'.

CREATE TABLE IF NOT EXISTS engagements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  fiscal_year_end DATE NOT NULL,

  consultant_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  -- Office / group (Milano, Sydney, Tokyo, …). Free text; defaults from the
  -- customer's office when the app creates the engagement.
  group_name TEXT,
  has_auditor BOOLEAN NOT NULL DEFAULT false,   -- Revisor Ja/Nej
  is_holding BOOLEAN NOT NULL DEFAULT false,     -- Holdingbolag Ja/Nej

  bokslut_status_id UUID REFERENCES engagement_statuses(id) ON DELETE SET NULL,
  bokslut_status_changed_at TIMESTAMPTZ,
  ink2_status_id UUID REFERENCES engagement_statuses(id) ON DELETE SET NULL,
  ink2_status_changed_at TIMESTAMPTZ,

  deadline DATE,                                 -- Deadline till kund/revisor

  bokslut_comment TEXT,                          -- Kommentar bokslut
  prior_year_comment TEXT,                       -- Kommentar från förra årets bokslut
  next_year_note TEXT,                           -- Till nästa år
  general_comment TEXT,                          -- Kommentar2

  setup JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One engagement per customer per fiscal year.
  CONSTRAINT engagements_customer_year_unique UNIQUE (customer_id, fiscal_year_end)
);

CREATE INDEX IF NOT EXISTS idx_engagements_customer ON engagements(customer_id);
CREATE INDEX IF NOT EXISTS idx_engagements_consultant ON engagements(consultant_id);
CREATE INDEX IF NOT EXISTS idx_engagements_fiscal_year ON engagements(fiscal_year_end);
CREATE INDEX IF NOT EXISTS idx_engagements_group ON engagements(group_name);
CREATE INDEX IF NOT EXISTS idx_engagements_bokslut_status ON engagements(bokslut_status_id);
CREATE INDEX IF NOT EXISTS idx_engagements_ink2_status ON engagements(ink2_status_id);

DROP TRIGGER IF EXISTS engagements_set_updated_at ON engagements;
CREATE TRIGGER engagements_set_updated_at
  BEFORE UPDATE ON engagements
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- -----------------------------------------------------------------------------
-- 4. Activity feed
-- -----------------------------------------------------------------------------
-- Append-only history per engagement: creation, status moves, comments, and
-- generic field changes. Populated automatically by the trigger below for
-- status moves; the app inserts 'comment'/'field_changed' rows directly.

CREATE TABLE IF NOT EXISTS engagement_activity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id UUID NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  -- Null = system/automated (e.g. a server-side status change with no JWT).
  actor_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  type TEXT NOT NULL
    CHECK (type IN ('created', 'status_changed', 'comment', 'field_changed')),
  workflow TEXT CHECK (workflow IN ('bokslut', 'ink2')),
  from_status_id UUID REFERENCES engagement_statuses(id) ON DELETE SET NULL,
  to_status_id UUID REFERENCES engagement_statuses(id) ON DELETE SET NULL,
  message TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_engagement_activity_engagement
  ON engagement_activity(engagement_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- 5. Triggers: auto-timestamp status changes + log activity
-- -----------------------------------------------------------------------------
-- BEFORE: stamp *_status_changed_at whenever the matching status actually
-- changes (or is set for the first time on INSERT). IS DISTINCT FROM handles
-- NULLs correctly so clearing/setting a status both register.

CREATE OR REPLACE FUNCTION engagement_stamp_status_change()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.bokslut_status_id IS NOT NULL AND NEW.bokslut_status_changed_at IS NULL THEN
      NEW.bokslut_status_changed_at = now();
    END IF;
    IF NEW.ink2_status_id IS NOT NULL AND NEW.ink2_status_changed_at IS NULL THEN
      NEW.ink2_status_changed_at = now();
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.bokslut_status_id IS DISTINCT FROM OLD.bokslut_status_id THEN
      NEW.bokslut_status_changed_at = now();
    END IF;
    IF NEW.ink2_status_id IS DISTINCT FROM OLD.ink2_status_id THEN
      NEW.ink2_status_changed_at = now();
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS engagements_stamp_status ON engagements;
CREATE TRIGGER engagements_stamp_status
  BEFORE INSERT OR UPDATE ON engagements
  FOR EACH ROW EXECUTE FUNCTION engagement_stamp_status_change();

-- AFTER: write the activity feed. SECURITY DEFINER so the insert always lands
-- regardless of the actor's RLS (the feed is system-owned history). auth.uid()
-- reads the request JWT claim, so it still attributes the acting user when one
-- is present and falls back to NULL for service-role/automated writes.

CREATE OR REPLACE FUNCTION engagement_log_activity()
RETURNS TRIGGER AS $$
DECLARE
  actor UUID := auth.uid();
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO engagement_activity (engagement_id, actor_id, type, metadata)
      VALUES (NEW.id, actor, 'created', NULL);

    IF NEW.bokslut_status_id IS NOT NULL THEN
      INSERT INTO engagement_activity
        (engagement_id, actor_id, type, workflow, to_status_id)
        VALUES (NEW.id, actor, 'status_changed', 'bokslut', NEW.bokslut_status_id);
    END IF;
    IF NEW.ink2_status_id IS NOT NULL THEN
      INSERT INTO engagement_activity
        (engagement_id, actor_id, type, workflow, to_status_id)
        VALUES (NEW.id, actor, 'status_changed', 'ink2', NEW.ink2_status_id);
    END IF;

  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.bokslut_status_id IS DISTINCT FROM OLD.bokslut_status_id THEN
      INSERT INTO engagement_activity
        (engagement_id, actor_id, type, workflow, from_status_id, to_status_id)
        VALUES (NEW.id, actor, 'status_changed', 'bokslut',
                OLD.bokslut_status_id, NEW.bokslut_status_id);
    END IF;
    IF NEW.ink2_status_id IS DISTINCT FROM OLD.ink2_status_id THEN
      INSERT INTO engagement_activity
        (engagement_id, actor_id, type, workflow, from_status_id, to_status_id)
        VALUES (NEW.id, actor, 'status_changed', 'ink2',
                OLD.ink2_status_id, NEW.ink2_status_id);
    END IF;
  END IF;

  RETURN NULL; -- AFTER trigger: return value ignored.
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS engagements_log_activity ON engagements;
CREATE TRIGGER engagements_log_activity
  AFTER INSERT OR UPDATE ON engagements
  FOR EACH ROW EXECUTE FUNCTION engagement_log_activity();

-- -----------------------------------------------------------------------------
-- 6. Row Level Security
-- -----------------------------------------------------------------------------
-- Mirrors the editable customer-scoped tables (customer_services etc.):
-- anyone with the 'customers' scope can read and write engagements; the status
-- lookup and config are readable by the same audience but admin-managed.

ALTER TABLE engagement_statuses ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagement_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagements ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagement_activity ENABLE ROW LEVEL SECURITY;

-- Status lookup: read for scope holders, manage for admins.
DROP POLICY IF EXISTS engagement_statuses_select ON engagement_statuses;
CREATE POLICY engagement_statuses_select ON engagement_statuses
  FOR SELECT USING (has_scope('customers'));

DROP POLICY IF EXISTS engagement_statuses_manage ON engagement_statuses;
CREATE POLICY engagement_statuses_manage ON engagement_statuses
  FOR ALL USING (get_user_role() = 'admin') WITH CHECK (get_user_role() = 'admin');

-- Config: read for scope holders, update for admins.
DROP POLICY IF EXISTS engagement_config_select ON engagement_config;
CREATE POLICY engagement_config_select ON engagement_config
  FOR SELECT USING (has_scope('customers'));

DROP POLICY IF EXISTS engagement_config_manage ON engagement_config;
CREATE POLICY engagement_config_manage ON engagement_config
  FOR ALL USING (get_user_role() = 'admin') WITH CHECK (get_user_role() = 'admin');

-- Engagements: full CRUD for scope holders.
DROP POLICY IF EXISTS engagements_select ON engagements;
CREATE POLICY engagements_select ON engagements
  FOR SELECT USING (has_scope('customers'));

DROP POLICY IF EXISTS engagements_insert ON engagements;
CREATE POLICY engagements_insert ON engagements
  FOR INSERT WITH CHECK (has_scope('customers'));

DROP POLICY IF EXISTS engagements_update ON engagements;
CREATE POLICY engagements_update ON engagements
  FOR UPDATE USING (has_scope('customers')) WITH CHECK (has_scope('customers'));

DROP POLICY IF EXISTS engagements_delete ON engagements;
CREATE POLICY engagements_delete ON engagements
  FOR DELETE USING (has_scope('customers'));

-- Activity feed: read + append for scope holders; immutable thereafter
-- (no UPDATE policy). Admins may prune.
DROP POLICY IF EXISTS engagement_activity_select ON engagement_activity;
CREATE POLICY engagement_activity_select ON engagement_activity
  FOR SELECT USING (has_scope('customers'));

DROP POLICY IF EXISTS engagement_activity_insert ON engagement_activity;
CREATE POLICY engagement_activity_insert ON engagement_activity
  FOR INSERT WITH CHECK (has_scope('customers'));

DROP POLICY IF EXISTS engagement_activity_delete ON engagement_activity;
CREATE POLICY engagement_activity_delete ON engagement_activity
  FOR DELETE USING (get_user_role() = 'admin');

-- -----------------------------------------------------------------------------
-- 7. Board read model
-- -----------------------------------------------------------------------------
-- Denormalized view the board UI selects from. security_invoker = on so the
-- querying user's RLS on engagements applies (without it the view would run as
-- owner and leak every row to anyone who can read the view).

CREATE OR REPLACE VIEW engagement_board
WITH (security_invoker = on) AS
SELECT
  e.id,
  e.customer_id,
  c.name AS customer_name,
  c.org_number,
  e.fiscal_year_end,
  e.consultant_id,
  p.full_name AS consultant_name,
  e.group_name,
  e.has_auditor,
  e.is_holding,

  e.bokslut_status_id,
  bs.key   AS bokslut_status_key,
  bs.label AS bokslut_status_label,
  bs.sort_order AS bokslut_status_sort,
  bs.is_done AS bokslut_status_is_done,
  e.bokslut_status_changed_at,

  e.ink2_status_id,
  isk.key   AS ink2_status_key,
  isk.label AS ink2_status_label,
  isk.sort_order AS ink2_status_sort,
  isk.is_done AS ink2_status_is_done,
  e.ink2_status_changed_at,

  e.deadline,
  -- Overdue when the deadline has passed and the bokslut pipeline isn't done.
  (e.deadline IS NOT NULL
     AND e.deadline < CURRENT_DATE
     AND COALESCE(bs.is_done, false) = false) AS is_overdue,

  e.bokslut_comment,
  e.prior_year_comment,
  e.next_year_note,
  e.general_comment,
  e.setup,
  e.created_at,
  e.updated_at
FROM engagements e
JOIN customers c ON c.id = e.customer_id
LEFT JOIN profiles p ON p.id = e.consultant_id
LEFT JOIN engagement_statuses bs ON bs.id = e.bokslut_status_id
LEFT JOIN engagement_statuses isk ON isk.id = e.ink2_status_id;
