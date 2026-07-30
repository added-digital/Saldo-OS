-- =====================================================
-- Migration 00105: Tasks (uppgiftstavla)
-- =====================================================
-- An internal task board for work that falls OUTSIDE the recurring services:
-- rådgivning, one-off questions, follow-ups — the things colleagues hand to
-- each other rather than run on a schedule. Modelled on the engagement board
-- (status lookup + drag ordering + activity log) but deliberately its own
-- table, because a task has:
--   • no fiscal year, and no "one per customer per year" uniqueness,
--   • an optional customer (plenty of tasks are purely internal),
--   • a single pipeline, so one status column instead of the bokslut/ink2 pair.
--
-- Visibility is firm-wide: any staff profile reads and writes the board, the
-- same way the whole team can see every bokslut card. Deleting is limited to
-- the task's creator and admins.

-- -----------------------------------------------------------------------------
-- 1. Lookups: statuses and categories
-- -----------------------------------------------------------------------------
-- Both are tables rather than enums so the firm can rename, reorder or extend
-- them from SQL without a code change (same trade-off as engagement_statuses).

CREATE TABLE IF NOT EXISTS task_statuses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  -- Terminal stage: cards here are finished and stop counting as open work.
  is_done BOOLEAN NOT NULL DEFAULT false,
  -- Optional UI accent; semantic token name or hex, resolved by the client.
  color TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotent seed: re-running updates label / ordering / flags so this file
-- stays the canonical list.
INSERT INTO task_statuses (key, label, sort_order, is_done) VALUES
  ('att_gora', 'Att göra',        10, false),
  ('pagar',    'Pågår',           20, false),
  ('vantar',   'Väntar på svar',  30, false),
  ('klar',     'Klar',            40, true)
ON CONFLICT (key)
  DO UPDATE SET
    label = EXCLUDED.label,
    sort_order = EXCLUDED.sort_order,
    is_done = EXCLUDED.is_done;

CREATE TABLE IF NOT EXISTS task_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  color TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO task_categories (key, label, sort_order) VALUES
  ('radgivning',     'Rådgivning',      10),
  ('bokforing',      'Bokföring',       20),
  ('moms',           'Moms',            30),
  ('lon',            'Lön',             40),
  ('skatt',          'Skatt',           50),
  ('arsredovisning', 'Årsredovisning',  60),
  ('internt',        'Internt',         70),
  ('ovrigt',         'Övrigt',          80)
ON CONFLICT (key)
  DO UPDATE SET
    label = EXCLUDED.label,
    sort_order = EXCLUDED.sort_order;

-- -----------------------------------------------------------------------------
-- 2. Tasks
-- -----------------------------------------------------------------------------
-- `description` is the note field on the card: what the task actually involves,
-- written by whoever creates it. `position` mirrors 00086 — NULL means "never
-- manually ordered", so untouched cards keep a deterministic fallback order.

CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT,

  status_id UUID REFERENCES task_statuses(id) ON DELETE SET NULL,
  status_changed_at TIMESTAMPTZ,
  category_id UUID REFERENCES task_categories(id) ON DELETE SET NULL,

  -- Optional: a task may be about a customer, or purely internal.
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,

  -- Who is expected to do it, and who asked. Both survive as NULL if the
  -- profile is removed, so the task itself is never lost with the person.
  assignee_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_by UUID REFERENCES profiles(id) ON DELETE SET NULL,

  deadline DATE,
  position DOUBLE PRECISION,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT tasks_title_not_blank CHECK (length(btrim(title)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id);
CREATE INDEX IF NOT EXISTS idx_tasks_category ON tasks(category_id);
CREATE INDEX IF NOT EXISTS idx_tasks_customer ON tasks(customer_id)
  WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_position ON tasks(position)
  WHERE position IS NOT NULL;

DROP TRIGGER IF EXISTS tasks_set_updated_at ON tasks;
CREATE TRIGGER tasks_set_updated_at
  BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- -----------------------------------------------------------------------------
-- 3. Activity feed
-- -----------------------------------------------------------------------------
-- Append-only history per task. Status moves and (re)assignments are written by
-- the trigger below; the app may insert 'comment' / 'field_changed' rows.

CREATE TABLE IF NOT EXISTS task_activity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  -- Null = system/automated (no JWT on the writing session).
  actor_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  type TEXT NOT NULL
    CHECK (type IN ('created', 'status_changed', 'assigned', 'comment', 'field_changed')),
  from_status_id UUID REFERENCES task_statuses(id) ON DELETE SET NULL,
  to_status_id UUID REFERENCES task_statuses(id) ON DELETE SET NULL,
  message TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_task_activity_task
  ON task_activity(task_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- 4. Triggers: stamp status changes + log activity
-- -----------------------------------------------------------------------------
-- BEFORE: stamp status_changed_at whenever the status actually changes (or is
-- set for the first time on INSERT). IS DISTINCT FROM handles NULLs so both
-- setting and clearing a status register.

CREATE OR REPLACE FUNCTION task_stamp_status_change()
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

DROP TRIGGER IF EXISTS tasks_stamp_status ON tasks;
CREATE TRIGGER tasks_stamp_status
  BEFORE INSERT OR UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION task_stamp_status_change();

-- AFTER: log creation, status moves and handovers. SECURITY DEFINER so the log
-- is written regardless of the caller's RLS on task_activity — including
-- server-side writes where auth.uid() is NULL, which the feed renders as a
-- system entry (matching engagement_log_activity in 00066).
CREATE OR REPLACE FUNCTION task_log_activity()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO task_activity (task_id, actor_id, type, to_status_id)
      VALUES (NEW.id, auth.uid(), 'created', NEW.status_id);
    IF NEW.assignee_id IS NOT NULL THEN
      INSERT INTO task_activity (task_id, actor_id, type, metadata)
        VALUES (NEW.id, auth.uid(), 'assigned',
                jsonb_build_object('to', NEW.assignee_id));
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status_id IS DISTINCT FROM OLD.status_id THEN
    INSERT INTO task_activity (task_id, actor_id, type, from_status_id, to_status_id)
      VALUES (NEW.id, auth.uid(), 'status_changed', OLD.status_id, NEW.status_id);
  END IF;

  IF NEW.assignee_id IS DISTINCT FROM OLD.assignee_id THEN
    INSERT INTO task_activity (task_id, actor_id, type, metadata)
      VALUES (NEW.id, auth.uid(), 'assigned',
              jsonb_build_object('from', OLD.assignee_id, 'to', NEW.assignee_id));
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS tasks_log_activity ON tasks;
CREATE TRIGGER tasks_log_activity
  AFTER INSERT OR UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION task_log_activity();

-- -----------------------------------------------------------------------------
-- 5. RLS
-- -----------------------------------------------------------------------------
-- The board is firm-wide: any staff profile may read and write every task, so
-- work can be picked up when someone is away. Deleting is narrower — the
-- creator or an admin — because a delete loses the activity trail with it.

ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_statuses ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_categories ENABLE ROW LEVEL SECURITY;

-- Staff = anyone with a profile row (every authenticated app user has one).
CREATE OR REPLACE FUNCTION is_staff()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid());
$$ LANGUAGE sql SECURITY DEFINER STABLE;

DROP POLICY IF EXISTS task_statuses_select ON task_statuses;
CREATE POLICY task_statuses_select ON task_statuses
  FOR SELECT USING (is_staff());

DROP POLICY IF EXISTS task_categories_select ON task_categories;
CREATE POLICY task_categories_select ON task_categories
  FOR SELECT USING (is_staff());

DROP POLICY IF EXISTS tasks_select ON tasks;
CREATE POLICY tasks_select ON tasks
  FOR SELECT USING (is_staff());

-- Creating: staff only, and the row must be stamped as your own creation so
-- the "who asked" column can be trusted.
DROP POLICY IF EXISTS tasks_insert ON tasks;
CREATE POLICY tasks_insert ON tasks
  FOR INSERT WITH CHECK (is_staff() AND created_by = auth.uid());

DROP POLICY IF EXISTS tasks_update ON tasks;
CREATE POLICY tasks_update ON tasks
  FOR UPDATE USING (is_staff()) WITH CHECK (is_staff());

DROP POLICY IF EXISTS tasks_delete ON tasks;
CREATE POLICY tasks_delete ON tasks
  FOR DELETE USING (created_by = auth.uid() OR get_user_role() = 'admin');

DROP POLICY IF EXISTS task_activity_select ON task_activity;
CREATE POLICY task_activity_select ON task_activity
  FOR SELECT USING (is_staff());

-- App-written entries (comments, field changes) must be attributed to the
-- author; the trigger-written rows run as the table owner and bypass this.
DROP POLICY IF EXISTS task_activity_insert ON task_activity;
CREATE POLICY task_activity_insert ON task_activity
  FOR INSERT WITH CHECK (is_staff() AND actor_id = auth.uid());

-- -----------------------------------------------------------------------------
-- 6. Board read model
-- -----------------------------------------------------------------------------
-- Denormalizes the lookups and people so the board needs no joins client-side.
-- security_invoker keeps the caller's RLS in force through the view.

DROP VIEW IF EXISTS task_board;
CREATE VIEW task_board
WITH (security_invoker = on) AS
SELECT
  t.id,
  t.title,
  t.description,

  t.status_id,
  s.key        AS status_key,
  s.label      AS status_label,
  s.sort_order AS status_sort,
  s.is_done    AS status_is_done,
  t.status_changed_at,

  t.category_id,
  cat.key   AS category_key,
  cat.label AS category_label,
  cat.color AS category_color,

  t.customer_id,
  c.name AS customer_name,

  t.assignee_id,
  a.full_name AS assignee_name,
  t.created_by,
  cb.full_name AS created_by_name,

  t.deadline,
  (t.deadline IS NOT NULL
     AND t.deadline < CURRENT_DATE
     AND COALESCE(s.is_done, false) = false) AS is_overdue,

  t.position,
  t.created_at,
  t.updated_at
FROM tasks t
LEFT JOIN task_statuses s   ON s.id = t.status_id
LEFT JOIN task_categories cat ON cat.id = t.category_id
LEFT JOIN customers c       ON c.id = t.customer_id
LEFT JOIN profiles a        ON a.id = t.assignee_id
LEFT JOIN profiles cb       ON cb.id = t.created_by;

-- -----------------------------------------------------------------------------
-- 7. Atomic column renumber
-- -----------------------------------------------------------------------------
-- p_ids is the FULL ordered set of task ids for one column (top → bottom).
-- SECURITY INVOKER (the default) keeps RLS in force, and the IS DISTINCT FROM
-- guard means a no-op reorder writes nothing — so untouched cards never bump
-- updated_at or fire the activity trigger.
CREATE OR REPLACE FUNCTION reorder_tasks(p_ids UUID[])
RETURNS VOID
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  UPDATE tasks t
     SET position = ord.idx
    FROM unnest(p_ids) WITH ORDINALITY AS ord(id, idx)
   WHERE t.id = ord.id
     AND t.position IS DISTINCT FROM ord.idx::double precision;
END;
$$;

REVOKE ALL ON FUNCTION reorder_tasks(UUID[]) FROM public;
GRANT EXECUTE ON FUNCTION reorder_tasks(UUID[]) TO authenticated;

-- -----------------------------------------------------------------------------
-- 8. Assignment notifications
-- -----------------------------------------------------------------------------
-- Handing a task to a colleague should reach them without a page refresh, so it
-- feeds the existing bell. `customer_name` on notifications is the subtitle
-- line the bell renders — for task rows it carries the task title, since that
-- is what identifies the work (the customer may be absent entirely).

ALTER TABLE notifications
  DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_check
    CHECK (type IN ('engagement_mention', 'lead_assignment', 'task_assignment'));

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS task_id UUID
    REFERENCES tasks(id) ON DELETE CASCADE;

-- Called by the client after assigning a task. SECURITY DEFINER so it can write
-- a row for the assignee; notifications has no INSERT policy by design. Skips
-- unassignment, self-assignment and unknown recipients.
CREATE OR REPLACE FUNCTION create_task_assignment_notification(
  p_task_id UUID,
  p_recipient_id UUID
)
RETURNS INTEGER AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_actor_name TEXT;
  v_title TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor) THEN
    RAISE EXCEPTION 'insufficient_privilege';
  END IF;

  IF p_recipient_id IS NULL OR p_recipient_id = v_actor THEN
    RETURN 0;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_recipient_id) THEN
    RETURN 0;
  END IF;

  SELECT title INTO v_title FROM tasks WHERE id = p_task_id;
  IF v_title IS NULL THEN
    RAISE EXCEPTION 'task_not_found';
  END IF;

  SELECT full_name INTO v_actor_name FROM profiles WHERE id = v_actor;

  INSERT INTO notifications
    (recipient_id, actor_id, actor_name, type, task_id, customer_name)
    VALUES
    (p_recipient_id, v_actor, v_actor_name, 'task_assignment', p_task_id, v_title);

  RETURN 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION create_task_assignment_notification(UUID, UUID) FROM public;
GRANT EXECUTE ON FUNCTION create_task_assignment_notification(UUID, UUID) TO authenticated;
