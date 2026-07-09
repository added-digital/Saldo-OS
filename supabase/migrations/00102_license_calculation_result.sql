-- =====================================================
-- Migration 00102: Shared licensing result
-- =====================================================
-- Admins compute the monthly licensing result from the uploaded Fortnox/Reda/
-- NVR sheets. The computed snapshot is stored here (single 'latest' row) so that
-- every logged-in user can view the results read-only, while uploading and
-- recalculating stay admin-only. Raw upload files are NOT stored.

CREATE TABLE IF NOT EXISTS license_calculation_result (
  id TEXT PRIMARY KEY DEFAULT 'latest' CHECK (id = 'latest'),
  period TEXT,
  payload JSONB NOT NULL,
  computed_by UUID,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE license_calculation_result ENABLE ROW LEVEL SECURITY;

-- Any authenticated user may read the latest shared result.
DROP POLICY IF EXISTS license_calculation_result_select ON license_calculation_result;
CREATE POLICY license_calculation_result_select
  ON license_calculation_result FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- Only admins may write (compute / update) it.
DROP POLICY IF EXISTS license_calculation_result_manage ON license_calculation_result;
CREATE POLICY license_calculation_result_manage
  ON license_calculation_result FOR ALL
  USING (get_user_role() = 'admin')
  WITH CHECK (get_user_role() = 'admin');
