-- Let feedback submitters attach screenshots (screen clips) so bug reports
-- carry visual context. Paths point at objects in the shared crm-files bucket
-- under the `feedback/{user_id}/…` prefix; we store the storage paths rather
-- than public URLs so access stays gated by storage RLS.

ALTER TABLE feedback_submissions
  ADD COLUMN IF NOT EXISTS attachment_paths TEXT[] NOT NULL DEFAULT '{}';
