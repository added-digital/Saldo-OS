-- Open read access on contact tables to all authenticated users.
--
-- The Contacts page is now visible in the sidebar regardless of role/scope,
-- so the RLS policy that previously required has_scope('customers') for
-- SELECT was filtering every row out for plain users — they saw the page
-- but no rows ever loaded.
--
-- Writes (insert / update / delete) still require has_scope('customers') —
-- which is also satisfied by admins. So non-scope users get read-only.
-- Edit / delete buttons will still render in the UI but the underlying
-- mutation will fail; if that's a concern, gate those buttons on `isAdmin`
-- or on the user's scopes in the component.

-- ---------------------------------------------------------------------------
-- customer_contacts
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS customer_contacts_select ON customer_contacts;
CREATE POLICY customer_contacts_select
  ON customer_contacts
  FOR SELECT
  TO authenticated
  USING (true);

-- ---------------------------------------------------------------------------
-- customer_contact_links — needed for the page's join from contact to its
-- linked customers. Without opening SELECT here, the contacts page would
-- show contacts but couldn't render their associated customers.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS customer_contact_links_select ON customer_contact_links;
CREATE POLICY customer_contact_links_select
  ON customer_contact_links
  FOR SELECT
  TO authenticated
  USING (true);
