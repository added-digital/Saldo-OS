-- Mail campaigns: a named grouping above mail_send_batches. One campaign
-- gathers several send actions ("Spring 2026 outreach") so the history can be
-- filtered by campaign instead of by individual batch.
--
-- Cardinality: one campaign per batch (nullable campaign_id FK on the batch).
-- Ownership: personal — each campaign belongs to the user who created it,
-- mirroring how mail_send_batches is already owner-scoped.

CREATE TABLE IF NOT EXISTS mail_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Don't allow blank names — the UI relies on a meaningful label.
  CONSTRAINT mail_campaigns_name_not_blank CHECK (length(btrim(name)) > 0)
);

-- One campaign name per owner (case-insensitive), so "pick or create" by name
-- is unambiguous and a repeat send under the same name reuses the campaign.
CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_campaigns_user_name
  ON mail_campaigns(user_id, lower(name));

CREATE INDEX IF NOT EXISTS idx_mail_campaigns_user_created
  ON mail_campaigns(user_id, created_at DESC);

DROP TRIGGER IF EXISTS mail_campaigns_set_updated_at ON mail_campaigns;
CREATE TRIGGER mail_campaigns_set_updated_at
  BEFORE UPDATE ON mail_campaigns
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE mail_campaigns ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mail_campaigns_owner_rw ON mail_campaigns;
CREATE POLICY mail_campaigns_owner_rw
  ON mail_campaigns
  FOR ALL
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Link batches to a campaign. Nullable — most sends start unfiled. ON DELETE
-- SET NULL so deleting a campaign un-files its batches rather than destroying
-- the send history.
ALTER TABLE mail_send_batches
  ADD COLUMN IF NOT EXISTS campaign_id UUID
    REFERENCES mail_campaigns(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_mail_send_batches_campaign
  ON mail_send_batches(user_id, campaign_id);
