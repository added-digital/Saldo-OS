-- Extend the sie_imports.import_status enum to record the new connect/sync
-- identity guard. When the org number in a fetched SIE file (or the company
-- authorised at connect time) doesn't match the Saldo customer's org_number,
-- the sync refuses to persist and writes an audit row with this status so the
-- mismatch is visible in the UI rather than silently swallowed.

ALTER TABLE sie_imports
  DROP CONSTRAINT IF EXISTS sie_imports_import_status_check;

ALTER TABLE sie_imports
  ADD CONSTRAINT sie_imports_import_status_check
  CHECK (import_status IN ('success', 'parse_error', 'fetch_error', 'org_mismatch'));
