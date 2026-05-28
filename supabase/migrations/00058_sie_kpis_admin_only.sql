-- Tighten sie_kpis read access to admin-only.
--
-- The original 00057 migration opened SELECT to anyone with the
-- `customers` scope on the assumption we'd ship per-portfolio filtering
-- at the same time. The /key-metrics page doesn't yet handle that
-- filtering cleanly (the overview lists every synced customer regardless
-- of which consultant owns them), so for now reads should mirror the
-- write policy: admins only.
--
-- When per-portfolio filtering ships, this migration can be reverted in
-- a follow-up: drop the admin-only select policy and re-create the
-- has_scope('customers') one.

DROP POLICY IF EXISTS sie_kpis_select ON sie_kpis;

CREATE POLICY sie_kpis_select_admin ON sie_kpis
  FOR SELECT
  TO authenticated
  USING (get_user_role() = 'admin');
