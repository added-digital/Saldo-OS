-- Per-company handling status for the hit list (Träfflista).
--
-- One row per (customer, rule) the user has acted on. The absence of a row
-- means "no status" — the default — so we only ever write a row when an admin
-- picks "Under hantering" or "Hanterad", and delete it when they clear the
-- status back to nothing. Scoped per rule because the same company can match
-- several rules and may be handled under one but not another.

CREATE TABLE IF NOT EXISTS hit_list_statuses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

  -- Matches HitListRule.key in src/lib/fortnox-sie/hit-list-definitions.ts.
  -- Kept as free text (not an FK) because the rule registry lives in code,
  -- not the database.
  rule_key TEXT NOT NULL,

  --   under_hantering — being worked on
  --   hanterad        — handled / done
  -- "nothing" is represented by the row not existing.
  status TEXT NOT NULL
    CHECK (status IN ('under_hantering', 'hanterad')),

  updated_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One status per (customer, rule); the UI upserts on this key.
CREATE UNIQUE INDEX IF NOT EXISTS idx_hit_list_statuses_customer_rule
  ON hit_list_statuses(customer_id, rule_key);

DROP TRIGGER IF EXISTS hit_list_statuses_set_updated_at ON hit_list_statuses;
CREATE TRIGGER hit_list_statuses_set_updated_at
  BEFORE UPDATE ON hit_list_statuses
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE hit_list_statuses ENABLE ROW LEVEL SECURITY;

-- Admin-only, matching the hit list page's own admin gate and the RLS on the
-- SIE tables it reads from.
DROP POLICY IF EXISTS hit_list_statuses_admin_rw ON hit_list_statuses;
CREATE POLICY hit_list_statuses_admin_rw
  ON hit_list_statuses
  FOR ALL
  TO authenticated
  USING (get_user_role() = 'admin')
  WITH CHECK (get_user_role() = 'admin');
