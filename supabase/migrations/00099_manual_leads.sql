-- Manual leads + lead activity history.
--
-- 1) website_leads grows a `source` ('website' | 'manual') plus company/org
--    fields so consultants can add leads by hand. Manual leads are verified
--    against Bolagsverket by org number when possible (name -> org.nr search
--    is not available in the HVD API, so entry is org.nr-first with a manual
--    fallback).
-- 2) Status gains pipeline stages: offer_sent, won, lost.
-- 3) lead_activities is an outreach log ("called", "emailed", "offer sent",
--    ...) so consultants can see who has touched a lead. Authors can edit and
--    delete their own entries; leads themselves can be deleted by any staff
--    member (activities cascade).

-- ---------------------------------------------------------------------
-- website_leads: new columns
-- ---------------------------------------------------------------------
ALTER TABLE website_leads
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'website',
  ADD COLUMN IF NOT EXISTS org_number TEXT,
  ADD COLUMN IF NOT EXISTS company_legal_form TEXT,
  ADD COLUMN IF NOT EXISTS address_street TEXT,
  ADD COLUMN IF NOT EXISTS address_postal_code TEXT,
  ADD COLUMN IF NOT EXISTS address_city TEXT,
  ADD COLUMN IF NOT EXISTS contact_role TEXT,
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  -- Raw Bolagsverket snapshot captured at lead creation (NULL when the org
  -- number was not looked up / not found).
  ADD COLUMN IF NOT EXISTS bolagsverket_data JSONB;

ALTER TABLE website_leads
  DROP CONSTRAINT IF EXISTS website_leads_source_check;
ALTER TABLE website_leads
  ADD CONSTRAINT website_leads_source_check
  CHECK (source IN ('website', 'manual'));

-- Manual leads have no website message; allow empty via default.
ALTER TABLE website_leads
  ALTER COLUMN message SET DEFAULT '';

-- ---------------------------------------------------------------------
-- website_leads: pipeline statuses
-- ---------------------------------------------------------------------
ALTER TABLE website_leads
  DROP CONSTRAINT IF EXISTS website_leads_status_check;
ALTER TABLE website_leads
  ADD CONSTRAINT website_leads_status_check
  CHECK (status IN ('new', 'contacted', 'offer_sent', 'won', 'lost', 'archived', 'spam'));

CREATE INDEX IF NOT EXISTS idx_website_leads_source
  ON website_leads(source);

-- ---------------------------------------------------------------------
-- website_leads: staff may INSERT manual leads (website rows still come only
-- through the service-role intake endpoint).
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS website_leads_insert_manual ON website_leads;
CREATE POLICY website_leads_insert_manual
  ON website_leads
  FOR INSERT
  TO authenticated
  WITH CHECK (source = 'manual' AND created_by = auth.uid());

-- DELETE on website_leads + UPDATE/DELETE on lead_activities live in
-- 00100_lead_delete_policies.sql (added after this migration was applied).

-- ---------------------------------------------------------------------
-- lead_activities: append-only outreach history
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lead_activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES website_leads(id) ON DELETE CASCADE,

  -- Preset actions. 'status_change' rows are logged automatically when the
  -- lead status is updated; the rest are logged manually by consultants.
  activity_type TEXT NOT NULL
    CHECK (activity_type IN (
      'called',
      'emailed',
      'meeting_booked',
      'offer_sent',
      'follow_up',
      'note',
      'status_change'
    )),

  note TEXT,

  created_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lead_activities_lead_created
  ON lead_activities(lead_id, created_at DESC);

ALTER TABLE lead_activities ENABLE ROW LEVEL SECURITY;

-- Any signed-in staff member can read the full history.
DROP POLICY IF EXISTS lead_activities_select ON lead_activities;
CREATE POLICY lead_activities_select
  ON lead_activities
  FOR SELECT
  TO authenticated
  USING (true);

-- Staff log activities as themselves.
DROP POLICY IF EXISTS lead_activities_insert ON lead_activities;
CREATE POLICY lead_activities_insert
  ON lead_activities
  FOR INSERT
  TO authenticated
  WITH CHECK (created_by = auth.uid());
