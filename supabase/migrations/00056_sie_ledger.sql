-- SIE ledger storage.
--
-- Holds the parsed contents of each customer's SIE 4 export from Fortnox:
-- chart of accounts, dimensions/objects (cost centres, projects), year-end
-- and monthly balances, and the underlying voucher + transaction stream.
--
-- Design notes:
--   * Every table is keyed off customer_id so a per-customer re-sync only
--     touches that customer's rows. ON DELETE CASCADE from customers cleans
--     everything up if a customer is removed.
--   * RLS is admin-only on every table — mirrors sie_connections, since the
--     data is financially sensitive customer bookkeeping.
--   * All amounts use numeric(18,2) to avoid floating-point drift on money.
--   * Every table with an account_number carries a generated `account_class`
--     smallint = the first digit of the account number (Swedish BAS scheme:
--       1=assets, 2=debt/equity, 3=income, 4-7=costs, 8=financial). This
--     turns common KPI queries ("all liquidity accounts", "all revenue
--     accounts") from substring scans into indexed lookups.
--   * Vouchers and balances are uniquely identified by natural keys that
--     include the financial year's from-date, so idempotent upserts work
--     across multi-year files without collision.
--   * sie_imports gives us an audit trail of every fetch — useful for
--     diagnostics ("when did we last refresh this customer?") and for
--     replay if a parse hits a regression.

-- ---------------------------------------------------------------------------
-- sie_imports — audit row per fetched + parsed SIE file
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sie_imports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

  -- Period the file covers. financial_year_from is the canonical year
  -- discriminator we'll reuse across all balance/voucher tables.
  financial_year_from DATE NOT NULL,
  financial_year_to DATE NOT NULL,

  -- Fortnox's internal financial-year ID (1, 2, 3, …) — useful when
  -- re-fetching the same file directly.
  fortnox_financial_year_id INTEGER,

  -- SIE 1/2/3/4. Type 4 is what we fetch by default (full transactional).
  sie_type SMALLINT NOT NULL,

  -- Snapshot point from the file's #OMFATTN line — "balances as of".
  as_of_date DATE,

  -- Identity captured from the file itself for sanity checks.
  fortnox_fnr TEXT,
  company_name TEXT,
  org_number TEXT,
  chart_type TEXT,         -- e.g. EUBAS97, BAS2014

  byte_size INTEGER,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  parsed_at TIMESTAMPTZ,

  -- Whatever the parser flagged. Empty array = clean parse.
  parse_warnings JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- success / parse_error / fetch_error — useful for the UI status badge.
  import_status TEXT NOT NULL DEFAULT 'success'
    CHECK (import_status IN ('success', 'parse_error', 'fetch_error')),
  error_message TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One canonical import per (customer, financial year, sie type). A re-sync
-- updates the existing row rather than appending a new one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sie_imports_unique
  ON sie_imports(customer_id, financial_year_from, sie_type);

CREATE INDEX IF NOT EXISTS idx_sie_imports_customer
  ON sie_imports(customer_id, fetched_at DESC);


-- ---------------------------------------------------------------------------
-- sie_accounts — chart of accounts per customer
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sie_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

  account_number TEXT NOT NULL,
  account_name TEXT NOT NULL,

  -- T=asset, S=debt, I=income, K=cost. Null when the exporter didn't
  -- include #KTYP — we can derive from account_class for most queries.
  account_type CHAR(1)
    CHECK (account_type IN ('T', 'S', 'I', 'K')),

  -- First digit of the account number, as a smallint. Generated column —
  -- always in sync with account_number, no risk of drift. Swedish BAS:
  --   1 = assets, 2 = debt/equity, 3 = income,
  --   4-7 = costs (4 cost of goods, 5-6 other costs, 7 personnel),
  --   8 = financial / extraordinary, 9 = closing accounts.
  account_class SMALLINT GENERATED ALWAYS AS (
    CASE WHEN account_number ~ '^[0-9]'
         THEN (substring(account_number from 1 for 1))::smallint
         ELSE NULL END
  ) STORED,

  -- SRU (Standardiserat räkenskapsutdrag) tax-declaration code.
  sru_code TEXT,
  unit TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sie_accounts_unique
  ON sie_accounts(customer_id, account_number);

CREATE INDEX IF NOT EXISTS idx_sie_accounts_class
  ON sie_accounts(customer_id, account_class);


-- ---------------------------------------------------------------------------
-- sie_dimensions / sie_objects — cost centres, projects, etc.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sie_dimensions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  dimension_number TEXT NOT NULL,
  dimension_name TEXT NOT NULL,
  parent_dimension_number TEXT,  -- for #UNDERDIM
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sie_dimensions_unique
  ON sie_dimensions(customer_id, dimension_number);


CREATE TABLE IF NOT EXISTS sie_objects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  dimension_number TEXT NOT NULL,
  object_id TEXT NOT NULL,
  object_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sie_objects_unique
  ON sie_objects(customer_id, dimension_number, object_id);


-- ---------------------------------------------------------------------------
-- sie_account_balances — IB (incoming), UB (outgoing), RES (result)
-- ---------------------------------------------------------------------------
-- One row per (account, year, kind). The most common KPI query — "what was
-- the closing balance for account X at end of year Y" — is a direct lookup.
CREATE TABLE IF NOT EXISTS sie_account_balances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

  -- Discriminate by the financial year's from-date (ISO YYYY-01-01 for
  -- calendar years) rather than the file-local year index (0, -1, …),
  -- which only makes sense relative to one specific export.
  financial_year_from DATE NOT NULL,

  -- ib = incoming balance (year start)
  -- ub = outgoing balance (year end)
  -- res = result account closing
  kind TEXT NOT NULL CHECK (kind IN ('ib', 'ub', 'res')),

  account_number TEXT NOT NULL,
  account_class SMALLINT GENERATED ALWAYS AS (
    CASE WHEN account_number ~ '^[0-9]'
         THEN (substring(account_number from 1 for 1))::smallint
         ELSE NULL END
  ) STORED,

  amount NUMERIC(18, 2) NOT NULL,
  quantity NUMERIC(18, 4),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sie_acc_balances_unique
  ON sie_account_balances(customer_id, financial_year_from, kind, account_number);

CREATE INDEX IF NOT EXISTS idx_sie_acc_balances_kpi
  ON sie_account_balances(customer_id, account_class, kind, financial_year_from);


-- ---------------------------------------------------------------------------
-- sie_period_balances — monthly PSALDO / PBUDGET per account
-- ---------------------------------------------------------------------------
-- One row per (account, year, period, kind). This is where time-series KPIs
-- get their data — "monthly receivables for the last 12 months", "month-
-- over-month revenue trend".
CREATE TABLE IF NOT EXISTS sie_period_balances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

  financial_year_from DATE NOT NULL,
  -- YYYYMM as text — matches SIE's #PSALDO format and sorts naturally.
  period TEXT NOT NULL CHECK (period ~ '^\d{6}$'),

  -- psaldo = actual period balance, pbudget = budgeted figure.
  kind TEXT NOT NULL CHECK (kind IN ('psaldo', 'pbudget')),

  account_number TEXT NOT NULL,
  account_class SMALLINT GENERATED ALWAYS AS (
    CASE WHEN account_number ~ '^[0-9]'
         THEN (substring(account_number from 1 for 1))::smallint
         ELSE NULL END
  ) STORED,

  -- Optional object scope (cost centre, project). Stored as JSONB array of
  -- {dimension, object_id} pairs to preserve multi-dimensional tagging
  -- without exploding into a separate join table for the common case
  -- (queries that don't filter by object skip it entirely).
  objects JSONB NOT NULL DEFAULT '[]'::jsonb,

  amount NUMERIC(18, 2) NOT NULL,
  quantity NUMERIC(18, 4),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Composite unique key includes objects-hash to handle the case where the
-- same account has multiple object-scoped balances in one period. For the
-- common no-objects case, the JSONB hash is stable on '[]'.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sie_period_balances_unique
  ON sie_period_balances(
    customer_id, financial_year_from, period, kind, account_number,
    md5(objects::text)
  );

CREATE INDEX IF NOT EXISTS idx_sie_period_balances_kpi
  ON sie_period_balances(customer_id, account_class, period);

CREATE INDEX IF NOT EXISTS idx_sie_period_balances_account
  ON sie_period_balances(customer_id, account_number, period);


-- ---------------------------------------------------------------------------
-- sie_object_balances — OIB / OUB (incoming/outgoing balances scoped to objects)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sie_object_balances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

  financial_year_from DATE NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('oib', 'oub')),

  account_number TEXT NOT NULL,
  account_class SMALLINT GENERATED ALWAYS AS (
    CASE WHEN account_number ~ '^[0-9]'
         THEN (substring(account_number from 1 for 1))::smallint
         ELSE NULL END
  ) STORED,

  objects JSONB NOT NULL DEFAULT '[]'::jsonb,

  amount NUMERIC(18, 2) NOT NULL,
  quantity NUMERIC(18, 4),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sie_object_balances_unique
  ON sie_object_balances(
    customer_id, financial_year_from, kind, account_number,
    md5(objects::text)
  );


-- ---------------------------------------------------------------------------
-- sie_vouchers + sie_transactions — the actual ledger entries
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sie_vouchers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

  financial_year_from DATE NOT NULL,

  -- Voucher series + number is the natural key within a financial year
  -- (e.g. "A 1", "A 2", "B 1"). Series can be alphabetic or numeric
  -- depending on the bookkeeping setup.
  series TEXT NOT NULL,
  voucher_number TEXT NOT NULL,

  voucher_date DATE NOT NULL,
  voucher_text TEXT,
  registration_date DATE,
  registered_by TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sie_vouchers_unique
  ON sie_vouchers(customer_id, financial_year_from, series, voucher_number);

CREATE INDEX IF NOT EXISTS idx_sie_vouchers_date
  ON sie_vouchers(customer_id, voucher_date);


CREATE TABLE IF NOT EXISTS sie_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  voucher_id UUID NOT NULL REFERENCES sie_vouchers(id) ON DELETE CASCADE,

  -- Position within the voucher (0-indexed). Lets us upsert deterministically
  -- when a voucher is re-imported with the same transactions.
  ordinal SMALLINT NOT NULL,

  -- TRANS = regular, RTRANS = reversing, BTRANS = already-booked.
  trans_type TEXT NOT NULL DEFAULT 'TRANS'
    CHECK (trans_type IN ('TRANS', 'RTRANS', 'BTRANS')),

  account_number TEXT NOT NULL,
  account_class SMALLINT GENERATED ALWAYS AS (
    CASE WHEN account_number ~ '^[0-9]'
         THEN (substring(account_number from 1 for 1))::smallint
         ELSE NULL END
  ) STORED,

  objects JSONB NOT NULL DEFAULT '[]'::jsonb,

  amount NUMERIC(18, 2) NOT NULL,
  quantity NUMERIC(18, 4),

  -- Optional transaction-level date (when it differs from the voucher's
  -- date) and free-text comment.
  transaction_date DATE,
  transaction_text TEXT,
  registered_by TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sie_transactions_unique
  ON sie_transactions(voucher_id, ordinal);

-- Hot-path indexes for KPI queries. Account-class + date covers "all costs
-- in this period", "all revenue this year", etc. Voucher_id covers "what
-- transactions belong to this voucher".
CREATE INDEX IF NOT EXISTS idx_sie_transactions_kpi
  ON sie_transactions(customer_id, account_class, transaction_date);

CREATE INDEX IF NOT EXISTS idx_sie_transactions_account
  ON sie_transactions(customer_id, account_number, transaction_date);


-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS sie_imports_set_updated_at ON sie_imports;
CREATE TRIGGER sie_imports_set_updated_at
  BEFORE UPDATE ON sie_imports
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS sie_accounts_set_updated_at ON sie_accounts;
CREATE TRIGGER sie_accounts_set_updated_at
  BEFORE UPDATE ON sie_accounts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS sie_dimensions_set_updated_at ON sie_dimensions;
CREATE TRIGGER sie_dimensions_set_updated_at
  BEFORE UPDATE ON sie_dimensions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS sie_objects_set_updated_at ON sie_objects;
CREATE TRIGGER sie_objects_set_updated_at
  BEFORE UPDATE ON sie_objects
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS sie_account_balances_set_updated_at ON sie_account_balances;
CREATE TRIGGER sie_account_balances_set_updated_at
  BEFORE UPDATE ON sie_account_balances
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS sie_period_balances_set_updated_at ON sie_period_balances;
CREATE TRIGGER sie_period_balances_set_updated_at
  BEFORE UPDATE ON sie_period_balances
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS sie_object_balances_set_updated_at ON sie_object_balances;
CREATE TRIGGER sie_object_balances_set_updated_at
  BEFORE UPDATE ON sie_object_balances
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS sie_vouchers_set_updated_at ON sie_vouchers;
CREATE TRIGGER sie_vouchers_set_updated_at
  BEFORE UPDATE ON sie_vouchers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS sie_transactions_set_updated_at ON sie_transactions;
CREATE TRIGGER sie_transactions_set_updated_at
  BEFORE UPDATE ON sie_transactions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ---------------------------------------------------------------------------
-- RLS — admin-only across the board (matches sie_connections policy)
-- ---------------------------------------------------------------------------
ALTER TABLE sie_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE sie_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sie_dimensions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sie_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE sie_account_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE sie_period_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE sie_object_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE sie_vouchers ENABLE ROW LEVEL SECURITY;
ALTER TABLE sie_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sie_imports_admin_rw ON sie_imports;
CREATE POLICY sie_imports_admin_rw ON sie_imports
  FOR ALL TO authenticated
  USING (get_user_role() = 'admin')
  WITH CHECK (get_user_role() = 'admin');

DROP POLICY IF EXISTS sie_accounts_admin_rw ON sie_accounts;
CREATE POLICY sie_accounts_admin_rw ON sie_accounts
  FOR ALL TO authenticated
  USING (get_user_role() = 'admin')
  WITH CHECK (get_user_role() = 'admin');

DROP POLICY IF EXISTS sie_dimensions_admin_rw ON sie_dimensions;
CREATE POLICY sie_dimensions_admin_rw ON sie_dimensions
  FOR ALL TO authenticated
  USING (get_user_role() = 'admin')
  WITH CHECK (get_user_role() = 'admin');

DROP POLICY IF EXISTS sie_objects_admin_rw ON sie_objects;
CREATE POLICY sie_objects_admin_rw ON sie_objects
  FOR ALL TO authenticated
  USING (get_user_role() = 'admin')
  WITH CHECK (get_user_role() = 'admin');

DROP POLICY IF EXISTS sie_account_balances_admin_rw ON sie_account_balances;
CREATE POLICY sie_account_balances_admin_rw ON sie_account_balances
  FOR ALL TO authenticated
  USING (get_user_role() = 'admin')
  WITH CHECK (get_user_role() = 'admin');

DROP POLICY IF EXISTS sie_period_balances_admin_rw ON sie_period_balances;
CREATE POLICY sie_period_balances_admin_rw ON sie_period_balances
  FOR ALL TO authenticated
  USING (get_user_role() = 'admin')
  WITH CHECK (get_user_role() = 'admin');

DROP POLICY IF EXISTS sie_object_balances_admin_rw ON sie_object_balances;
CREATE POLICY sie_object_balances_admin_rw ON sie_object_balances
  FOR ALL TO authenticated
  USING (get_user_role() = 'admin')
  WITH CHECK (get_user_role() = 'admin');

DROP POLICY IF EXISTS sie_vouchers_admin_rw ON sie_vouchers;
CREATE POLICY sie_vouchers_admin_rw ON sie_vouchers
  FOR ALL TO authenticated
  USING (get_user_role() = 'admin')
  WITH CHECK (get_user_role() = 'admin');

DROP POLICY IF EXISTS sie_transactions_admin_rw ON sie_transactions;
CREATE POLICY sie_transactions_admin_rw ON sie_transactions
  FOR ALL TO authenticated
  USING (get_user_role() = 'admin')
  WITH CHECK (get_user_role() = 'admin');
