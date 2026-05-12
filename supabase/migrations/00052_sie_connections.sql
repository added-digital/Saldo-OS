-- Per-customer connection records for the Fortnox SIE integration. Each row
-- represents one customer's OAuth grant — admin (Mattias) authorizes once
-- against that customer's Fortnox tenant, we capture the resulting token
-- pair, and the nightly sync uses these tokens to fetch the customer's SIE
-- (general ledger) export.
--
-- Tokens are stored in plaintext for now. Once the integration is past
-- pilot, consider wrapping access_token / refresh_token writes in a
-- column-level encryption helper (e.g. pgsodium / pgp_sym_encrypt) so a
-- compromised read-only DB credential can't lift live Fortnox grants.

CREATE TABLE IF NOT EXISTS sie_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

  -- Identifies the customer's company file inside Fortnox. Sent as the
  -- `TenantId` header on every authenticated request.
  fortnox_tenant_id TEXT,

  -- OAuth token pair from Fortnox. access_token lasts ~1h, refresh_token
  -- lasts ~45 days. Both rotate on every refresh, so we always write the
  -- newly returned pair back here.
  access_token TEXT,
  refresh_token TEXT,
  access_token_expires_at TIMESTAMPTZ,
  refresh_token_expires_at TIMESTAMPTZ,

  -- Scopes Fortnox actually granted, space-separated. Useful for debugging
  -- when a customer approved a narrower scope than we requested.
  scope TEXT,

  -- High-level state machine for the UI's connection badge.
  --   pending       — row exists but OAuth hasn't completed yet
  --   active        — tokens present and valid, sync allowed
  --   needs_reauth  — refresh token expired or revoked; admin must redo OAuth
  --   error         — last sync hit a non-auth error (rate limit, parser, …)
  connection_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (connection_status IN ('pending', 'active', 'needs_reauth', 'error')),

  last_synced_at TIMESTAMPTZ,
  last_error TEXT,
  connected_at TIMESTAMPTZ,                          -- when OAuth round-trip completed
  connected_by UUID REFERENCES profiles(id),         -- which admin clicked Connect
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One SIE connection per customer. If a customer reconnects, we UPDATE the
-- existing row instead of inserting a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sie_connections_customer_id
  ON sie_connections(customer_id);

-- For the nightly sync job: quickly find rows that are due for a refresh
-- (active + last_synced_at older than X). Composite index helps the typical
-- "next batch to process" query.
CREATE INDEX IF NOT EXISTS idx_sie_connections_status_last_synced
  ON sie_connections(connection_status, last_synced_at);

DROP TRIGGER IF EXISTS sie_connections_set_updated_at ON sie_connections;
CREATE TRIGGER sie_connections_set_updated_at
  BEFORE UPDATE ON sie_connections
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE sie_connections ENABLE ROW LEVEL SECURITY;

-- Admin-only. Tokens grant access to live customer financial data, so we
-- restrict reads + writes to admins regardless of which profile scope they
-- have on the rest of the app.
DROP POLICY IF EXISTS sie_connections_admin_rw ON sie_connections;
CREATE POLICY sie_connections_admin_rw
  ON sie_connections
  FOR ALL
  TO authenticated
  USING (get_user_role() = 'admin')
  WITH CHECK (get_user_role() = 'admin');
