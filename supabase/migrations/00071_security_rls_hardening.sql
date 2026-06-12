-- =====================================================
-- Migration 00071: Security RLS hardening
-- =====================================================
-- Closes two tables that were created WITHOUT Row Level Security, leaving them
-- fully readable/writable by any authenticated user via the anon/auth API:
--
--   * documents / document_chunks  (00044) — hold full extracted text of every
--     uploaded file. Only ever accessed through the service-role client in
--     server routes, so enabling RLS does not affect app behaviour.
--   * sync_jobs (00015) — sync progress + free-form payload/error_message.
--     Written from the client only via admin-only sync flows; the global
--     SyncProvider's stale-job UPDATE simply matches zero rows for non-admins.
--
-- The service-role key bypasses RLS entirely, so all server-side ingest / sync
-- / search code continues to work unchanged.
--
-- NOTE: the audited "user_scopes missing WITH CHECK" finding was a false
-- positive — in PostgreSQL an omitted WITH CHECK defaults to the USING
-- expression, so `FOR ALL USING (get_user_role() = 'admin')` already blocks
-- non-admin INSERTs. No change needed there.
-- =====================================================

-- ---------- documents / document_chunks (admin-only) ----------

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_chunks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS documents_select ON documents;
CREATE POLICY documents_select ON documents
  FOR SELECT USING (get_user_role() = 'admin');

DROP POLICY IF EXISTS documents_manage ON documents;
CREATE POLICY documents_manage ON documents
  FOR ALL USING (get_user_role() = 'admin')
  WITH CHECK (get_user_role() = 'admin');

DROP POLICY IF EXISTS document_chunks_select ON document_chunks;
CREATE POLICY document_chunks_select ON document_chunks
  FOR SELECT USING (get_user_role() = 'admin');

DROP POLICY IF EXISTS document_chunks_manage ON document_chunks;
CREATE POLICY document_chunks_manage ON document_chunks
  FOR ALL USING (get_user_role() = 'admin')
  WITH CHECK (get_user_role() = 'admin');

-- ---------- sync_jobs (admin-only) ----------

ALTER TABLE sync_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sync_jobs_select ON sync_jobs;
CREATE POLICY sync_jobs_select ON sync_jobs
  FOR SELECT USING (get_user_role() = 'admin');

DROP POLICY IF EXISTS sync_jobs_manage ON sync_jobs;
CREATE POLICY sync_jobs_manage ON sync_jobs
  FOR ALL USING (get_user_role() = 'admin')
  WITH CHECK (get_user_role() = 'admin');
