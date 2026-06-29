-- Bug fix: setting a contact as "primary" silently reverted to "regular".
--
-- Root cause: customer_contact_links had RLS policies for SELECT / INSERT /
-- DELETE (00004, 00011) but never an UPDATE policy. The is_primary column was
-- added later (00020) without extending the policies. With RLS enabled and no
-- permissive UPDATE policy, Postgres rejects every UPDATE — and via PostgREST
-- this is NOT an error: the statement simply affects zero rows.
--
-- So promoting an existing (regular) link to primary, which the app does with
-- `UPDATE ... SET is_primary = true`, silently no-op'd and the link stayed
-- is_primary = false. Demoting primary -> regular failed the same way.
--
-- Fix: add the missing UPDATE policy, matching the scope check already used by
-- the INSERT/DELETE policies on this table.

DROP POLICY IF EXISTS customer_contact_links_update ON customer_contact_links;
CREATE POLICY customer_contact_links_update
  ON customer_contact_links
  FOR UPDATE
  USING (has_scope('customers'))
  WITH CHECK (has_scope('customers'));
