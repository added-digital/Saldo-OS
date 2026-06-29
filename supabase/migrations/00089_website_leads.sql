-- Website leads. Inbound contact-form submissions forwarded from the public
-- marketing site (Next.js + CMS) to OS via POST /api/leads/intake. OS is the
-- lead store and the sender: the row shows up in the Leads view and a
-- notification email is sent to the owning inbox via the Azure app-only Graph
-- flow. The site has already run its anti-bot + reCAPTCHA checks, so rows here
-- are pre-screened.
--
-- Writes happen ONLY through the service-role client in /api/leads/intake
-- (which bypasses RLS). Authenticated staff can read every lead and update its
-- triage status from the Leads view; they cannot insert or delete.

CREATE TABLE IF NOT EXISTS website_leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Which form on the site produced this lead (e.g. 'contact'). Used for
  -- display and, later, per-form recipient routing.
  form_name TEXT NOT NULL DEFAULT 'contact',

  -- Submitted fields. name/company/message are required by the intake
  -- endpoint; email/phone are optional.
  name TEXT NOT NULL,
  company TEXT NOT NULL,
  message TEXT NOT NULL,
  email TEXT,
  phone TEXT,

  -- Context from the site.
  page_path TEXT,
  submitted_at TIMESTAMPTZ,
  recaptcha_score NUMERIC(3, 2),
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Triage state, owned by staff in the Leads view.
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'contacted', 'archived', 'spam')),

  -- Outcome of the notification email send, set by the intake endpoint.
  -- 'skipped' = Azure app-only mail not configured / no recipient; the lead is
  -- still captured so nothing is lost while admin consent is being arranged.
  notification_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (notification_status IN ('pending', 'sent', 'failed', 'skipped')),
  notification_recipient TEXT,
  notification_error TEXT,

  -- Optional idempotency key sent by the site (Idempotency-Key header) so a
  -- retried POST does not create a duplicate lead.
  idempotency_key TEXT,

  source_ip TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_website_leads_created_at
  ON website_leads(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_website_leads_status
  ON website_leads(status);

-- Enforce idempotency: at most one lead per supplied key. NULL keys are
-- allowed to repeat (a UNIQUE index treats NULLs as distinct in Postgres),
-- so leads sent without a key are never collapsed together.
CREATE UNIQUE INDEX IF NOT EXISTS uq_website_leads_idempotency_key
  ON website_leads(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

DROP TRIGGER IF EXISTS website_leads_set_updated_at ON website_leads;
CREATE TRIGGER website_leads_set_updated_at
  BEFORE UPDATE ON website_leads
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE website_leads ENABLE ROW LEVEL SECURITY;

-- Any signed-in staff member can browse leads.
DROP POLICY IF EXISTS website_leads_select ON website_leads;
CREATE POLICY website_leads_select
  ON website_leads
  FOR SELECT
  TO authenticated
  USING (true);

-- Staff can update triage fields (status). Inserts/deletes are intentionally
-- NOT granted to authenticated — leads are created only by the service-role
-- intake endpoint, which bypasses RLS.
DROP POLICY IF EXISTS website_leads_update ON website_leads;
CREATE POLICY website_leads_update
  ON website_leads
  FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);
