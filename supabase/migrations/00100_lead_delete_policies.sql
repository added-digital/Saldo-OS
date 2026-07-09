-- Delete/update policies for leads + activities. Split out of 00099 because
-- that migration was already applied without these; without them, RLS makes
-- DELETE/UPDATE silently affect 0 rows.

-- Staff can delete leads (manual or website); activities cascade with the row.
DROP POLICY IF EXISTS website_leads_delete ON website_leads;
CREATE POLICY website_leads_delete
  ON website_leads
  FOR DELETE
  TO authenticated
  USING (true);

-- Authors may edit and delete their own activity entries (others' entries
-- stay intact so the shared outreach trail remains trustworthy).
DROP POLICY IF EXISTS lead_activities_update_own ON lead_activities;
CREATE POLICY lead_activities_update_own
  ON lead_activities
  FOR UPDATE
  TO authenticated
  USING (created_by = auth.uid())
  WITH CHECK (created_by = auth.uid());

DROP POLICY IF EXISTS lead_activities_delete_own ON lead_activities;
CREATE POLICY lead_activities_delete_own
  ON lead_activities
  FOR DELETE
  TO authenticated
  USING (created_by = auth.uid());
