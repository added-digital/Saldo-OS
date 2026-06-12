-- =====================================================
-- Migration 00072: Engagement attachments
-- =====================================================
-- Lets consultants attach source files / supporting documents to a specific
-- engagement (uppdrag) from the Bokslut board detail sheet.
--
-- Storage: files live in the existing private `crm-files` bucket under an
-- `engagements/<engagement_id>/...` prefix. Unlike the admin-only `files` /
-- `Tjänster` roots (00041/00042), this prefix is gated by has_scope('customers')
-- so the same audience that can read/write engagements can manage attachments.
--
-- Metadata (filename, type, size, uploader) lives in engagement_attachments so
-- the UI can list files without enumerating storage. RLS mirrors engagements:
-- read/insert/delete for scope holders. Per product decision, ANY consultant
-- may delete an attachment (consistent with engagement edit/delete rights).

-- -----------------------------------------------------------------------------
-- 1. Metadata table
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS engagement_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id UUID NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  -- Full object name within the crm-files bucket (e.g. engagements/<id>/<uuid>.pdf)
  storage_path TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,            -- original filename for display
  file_type TEXT,                     -- MIME type
  file_size BIGINT,                   -- bytes
  uploaded_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_engagement_attachments_engagement
  ON engagement_attachments(engagement_id, created_at DESC);

ALTER TABLE engagement_attachments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS engagement_attachments_select ON engagement_attachments;
CREATE POLICY engagement_attachments_select ON engagement_attachments
  FOR SELECT USING (has_scope('customers'));

DROP POLICY IF EXISTS engagement_attachments_insert ON engagement_attachments;
CREATE POLICY engagement_attachments_insert ON engagement_attachments
  FOR INSERT WITH CHECK (has_scope('customers'));

-- Any scope holder may delete (matches engagements_delete).
DROP POLICY IF EXISTS engagement_attachments_delete ON engagement_attachments;
CREATE POLICY engagement_attachments_delete ON engagement_attachments
  FOR DELETE USING (has_scope('customers'));

-- -----------------------------------------------------------------------------
-- 2. Storage policies for the `engagements/` prefix in crm-files
-- -----------------------------------------------------------------------------
-- Scoped to has_scope('customers'). The bucket itself stays private; the app
-- serves files via short-lived signed URLs.

DROP POLICY IF EXISTS storage_crm_files_engagements_select ON storage.objects;
CREATE POLICY storage_crm_files_engagements_select
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'crm-files'
    AND (storage.foldername(name))[1] = 'engagements'
    AND has_scope('customers')
  );

DROP POLICY IF EXISTS storage_crm_files_engagements_insert ON storage.objects;
CREATE POLICY storage_crm_files_engagements_insert
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'crm-files'
    AND (storage.foldername(name))[1] = 'engagements'
    AND has_scope('customers')
  );

DROP POLICY IF EXISTS storage_crm_files_engagements_delete ON storage.objects;
CREATE POLICY storage_crm_files_engagements_delete
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'crm-files'
    AND (storage.foldername(name))[1] = 'engagements'
    AND has_scope('customers')
  );
