-- =====================================================
-- Migration 00108: Lead attachments
-- =====================================================
-- Lets staff attach files to a lead — a signed quote, an offer draft, a
-- screenshot of the enquiry, an annual report pulled from the prospect. Same
-- shape as engagement_attachments (00072): the bytes go to the private
-- `crm-files` bucket under a `leads/<lead_id>/...` prefix, while filename,
-- type, size and uploader live in a metadata table so the UI can list files
-- without enumerating storage.
--
-- RLS mirrors website_leads (00089/00100): any authenticated staff member may
-- read, add and remove. Leads are a shared pipeline, so the same audience that
-- can retitle or delete a lead can manage its files — a narrower rule here
-- would only strand attachments on leads someone else created.

-- -----------------------------------------------------------------------------
-- 1. Metadata table
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lead_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES website_leads(id) ON DELETE CASCADE,
  -- Full object name within the crm-files bucket (e.g. leads/<id>/<uuid>.pdf)
  storage_path TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,            -- original filename for display
  file_type TEXT,                     -- MIME type
  file_size BIGINT,                   -- bytes
  uploaded_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lead_attachments_lead
  ON lead_attachments(lead_id, created_at DESC);

ALTER TABLE lead_attachments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lead_attachments_select ON lead_attachments;
CREATE POLICY lead_attachments_select
  ON lead_attachments
  FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS lead_attachments_insert ON lead_attachments;
CREATE POLICY lead_attachments_insert
  ON lead_attachments
  FOR INSERT
  TO authenticated
  WITH CHECK (true);

DROP POLICY IF EXISTS lead_attachments_delete ON lead_attachments;
CREATE POLICY lead_attachments_delete
  ON lead_attachments
  FOR DELETE
  TO authenticated
  USING (true);

-- -----------------------------------------------------------------------------
-- 2. Storage policies for the `leads/` prefix in crm-files
-- -----------------------------------------------------------------------------
-- The bucket stays private; the app serves files through short-lived signed
-- URLs. Note the prefix check: these policies grant nothing outside `leads/`,
-- so the admin-only `files` / `Tjänster` roots (00041/00042) are untouched.

DROP POLICY IF EXISTS storage_crm_files_leads_select ON storage.objects;
CREATE POLICY storage_crm_files_leads_select
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'crm-files'
    AND (storage.foldername(name))[1] = 'leads'
  );

DROP POLICY IF EXISTS storage_crm_files_leads_insert ON storage.objects;
CREATE POLICY storage_crm_files_leads_insert
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'crm-files'
    AND (storage.foldername(name))[1] = 'leads'
  );

DROP POLICY IF EXISTS storage_crm_files_leads_delete ON storage.objects;
CREATE POLICY storage_crm_files_leads_delete
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'crm-files'
    AND (storage.foldername(name))[1] = 'leads'
  );
