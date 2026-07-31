# MIGRATION KNOWLEDGE

## Scope
Applies to `supabase/migrations`.

## Overview
Migrations define schema, RLS policies, sync orchestration, reporting/KPI functions, pgvector document tables, storage buckets, and mail tables.

## Naming And Style
- Use ordered numeric filenames: `00050_description.sql`.
- Prefer idempotent SQL: `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`.
- Drop policies before recreating them: `DROP POLICY IF EXISTS ...` then `CREATE POLICY ...`.
- Keep indexes and triggers near the tables/functions they support.
- Use concise SQL comments only for intent, legacy compatibility, or security-sensitive behavior.

## RLS Rules
- Enable RLS explicitly for new app tables.
- Reuse `get_user_role()` for role checks and `has_scope(scope_key)` for scope checks.
- Admin policies usually check `get_user_role() = 'admin'`.
- Customer-domain policies usually align with `has_scope('customers')` unless more specific logic exists.

## Data Rules
- Use `gen_random_uuid()` UUID primary keys unless an existing table pattern differs.
- Include `created_at` and `updated_at` where mutable app records need audit timestamps.
- Reuse `update_updated_at()` triggers for mutable tables.
- Reporting totals should preserve `total_ex_vat` and active-contract KPI rules.
- SQL functions used by generated SQL/RAG must remain read-only or tightly allowlisted.

## Sync And Vector Rules
- Keep `sync_jobs` queue fields compatible with API and Edge Function orchestration.
- pgvector/document migrations must align with embedding dimensions used by API document ingestion/search.
- Storage bucket policies should be explicit and match dashboard settings/file behavior.

## Verification
- Run `pnpm supabase db push` when possible.
- After schema changes that affect TypeScript, regenerate/update database types if that workflow is available.
