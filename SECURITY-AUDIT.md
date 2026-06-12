# Saldo CRM — Security & App Health Audit

_Read-only review. No application code was modified. Date: 2026-06-11._

## How to read this

The app exposes the **browser Supabase client (anon key) directly from ~33 client components**, with no server-side data-access layer for most CRUD. That is a valid pattern — **but it makes Row Level Security (RLS) the only thing standing between any logged-in user and the entire database.** Most of the critical findings below are places where that single boundary has a hole.

Authentication itself is sound (Azure OAuth via Supabase, correct `getUser()` usage, middleware redirects unauthenticated users). **The problems are in the authorization layer, not authentication.**

Severity legend: 🔴 Critical · 🟠 High · 🟡 Medium · ⚪ Low

---

## 🔴 Critical — fix first

### C1. ~~Any user can grant themselves any permission~~ — FALSE POSITIVE (verified)
`supabase/migrations/00004_rls_policies.sql:61-62` — flagged as `user_scopes_manage` having `FOR ALL ... USING (get_user_role() = 'admin')` with no `WITH CHECK`. On verification this is **not exploitable**: in PostgreSQL, when `WITH CHECK` is omitted it **defaults to the `USING` expression**, so the admin condition is applied as the INSERT check. A non-admin INSERT into `user_scopes` is therefore rejected. No fix required. (Adding an explicit `WITH CHECK` is harmless documentation-as-code but changes nothing functionally.)

### C2. `documents` / `document_chunks` tables have no RLS at all
`supabase/migrations/00044_document_tables.sql` creates both tables but never calls `ENABLE ROW LEVEL SECURITY` (confirmed across all later migrations). These hold `content_text` — the full extracted text of every uploaded document. Any authenticated user can `supabase.from("documents").select("content_text")` and read all uploaded file contents, completely bypassing the admin-only storage bucket policy.

**Fix:** `ALTER TABLE documents ENABLE ROW LEVEL SECURITY;` (+ `document_chunks`) with admin-only SELECT policies mirroring the bucket gate.

### C3. `sync_jobs` table has no RLS and is published to realtime
`supabase/migrations/00015_sync_jobs.sql` — no `ENABLE ROW LEVEL SECURITY`, plus `ALTER PUBLICATION supabase_realtime ADD TABLE sync_jobs`. It is the only client-queried table with RLS fully disabled. Any authenticated user (or realtime subscriber) can read and write all rows, including the free-form `payload`/`error_message` columns.

**Fix:** enable RLS, add scope/admin policies, and reconsider whether it belongs in the realtime publication if payload can hold sensitive data.

### C4. AI SQL endpoint runs arbitrary generated SQL as service-role for any logged-in user
`src/app/api/questions/ask-sql/route.ts:316-368` — auth check is only `getUser()` (no role/scope gate), then executes LLM-generated SQL via `adminClient.rpc("run_generated_sql", …)`. `run_generated_sql` (`00025_*.sql`) is `SECURITY DEFINER`, so it runs with full privileges and **bypasses all RLS**. The guardrails are a regex table allow-list (misses subselects/comment tricks) and a keyword denylist (bypassable). Any plain `user` can drive it to read every profile, customer, invoice — even `fortnox_connection` tokens. It also echoes the generated SQL and raw OpenAI response back to the client.

**Fix:** require admin (or an explicit reporting scope) in the route; better, bind the query to the caller's JWT so RLS applies instead of using the admin client. Enforce a hard table allow-list in SQL, not regex. Stop returning SQL/OpenAI payloads to clients. Remove the leftover `console.log(response)` at `:288`.

### C5. Fortnox webhook is unauthenticated and unsigned
`src/app/api/fortnox/webhook/route.ts:5-15` → `src/lib/fortnox/websocket.ts` (no signature/HMAC/secret verification anywhere). Any internet caller can POST forged events that drive DB writes/syncs, and the route always returns `{success:true}`, masking abuse.

**Fix:** verify a shared secret / HMAC header before processing; reject unsigned or invalid requests with 401.

---

## 🟠 High

### H1. Chat tools read firm-wide financial data via admin client with no role gate
`src/app/api/chat/route.ts:211-229` admits any authenticated profile. These tool handlers then use the service-role client without checking `context.user.role`, despite their own comments noting the tables are "admin-only RLS":
- `tools/get-sie-kpis.ts:54-55`, `tools/get-sie-account-balance.ts:56`, `tools/get-sie-account-trend.ts:81`, `tools/rank-sie-kpis.ts:65`, `tools/get-hit-list-matches.ts:87`.

A non-admin can ask the chat for any customer's SIE ledger, KPIs (revenue/EBIT/solidity), or the prospecting hit list. **Fix:** check `context.user.role === "admin"` (or run via the RLS-scoped `context.supabase`) in each handler.

### H2. Document ingest trusts a client-supplied storage path + no admin gate
`src/app/api/documents/ingest/route.ts:164-209` — only `getUser()`, then `adminClient.storage.from("crm-files").download(storagePath)` with an arbitrary caller-supplied path. A non-admin can read any object in the bucket, extract its text, and persist it into the unprotected `documents` table (then read it back per C2). Contrast `documents/delete` which correctly enforces `role === "admin"`.

**Fix:** add the admin gate and validate `storage_path` against an allowed prefix (reject `..`, absolute, out-of-prefix paths).

### H3. Main Fortnox OAuth callback has no `state`/CSRF check
`src/app/api/fortnox/auth/route.ts:6-60` — unlike the SIE flow (which uses an httpOnly nonce cookie and verifies it), this callback carries no `state` and performs no CSRF check before upserting tenant tokens into `fortnox_connection`. Enables connection-fixation (binding an attacker-controlled tenant).

**Fix:** mirror the SIE flow's `state` nonce + httpOnly cookie verification; require the initiator be an admin.

### H4. Fortnox OAuth tokens are plaintext and pulled into the browser
`src/app/(dashboard)/settings/integrations/page.tsx:41-43` does `.from("fortnox_connection").select("*")` from a client component. RLS limits this to admins (good), but `select("*")` ships live, unexpired `access_token`/`refresh_token` (stored plaintext, `00003_customers.sql:52-53`) into the browser — visible in devtools, network tab, JS memory, any XSS.

**Fix:** never select token columns client-side — use an explicit safe column list, or move the read server-side. Encrypt the four token columns at rest (also applies to `sie_connections`).

### H5. Admin/settings pages are gated only client-side
`src/app/(dashboard)/settings/layout.tsx:46-48`, `users/page.tsx`, `files/page.tsx` hide tabs/return null for non-admins, but `(dashboard)/layout.tsx` only verifies a session exists — there is **no server-side role check**. Non-admins still mount the page; protection depends entirely on RLS, which C1/C2/world-readable `profiles` partly defeat.

**Fix:** make sensitive settings routes server components (or add a server layout) that fetch the profile and `redirect()` non-admins. Treat client hiding as cosmetic.

### H6. `useScope` ignores the scope it's asked about
`src/hooks/use-scope.ts:21-29` returns true if the user has *any* row in `user_scopes`, ignoring `scopeKey`. A user with one scope is treated as having all of them client-side. Combined with C1, broadens exposed UI.

**Fix:** filter on the specific `scopeKey` (as `useUserScopes` already does).

---

## 🟡 Medium

- **M1. `profiles` readable by all authenticated users** — `00004_rls_policies.sql:28` (`SELECT USING (true)`) exposes every employee's email, role, `is_active`, and Fortnox IDs. Often intentional for an internal CRM, but make it an explicit decision; consider exposing only `id, full_name, avatar_url` broadly.
- **M2. `segments` / `customer_segments` world-readable** — `00006_segments.sql:36,50` leak which customers exist and their classification regardless of `customers` scope. Change SELECT policies to `USING (has_scope('customers'))`.
- **M3. `customers`/`invoices` UPDATE policies lack `WITH CHECK`** — `00004:67-68`; combined with the pervasive `as never` write casts (per `AGENTS.md` convention), a scoped user can write *any* column on any row. Add `WITH CHECK` restricting mutable columns/ownership.
- **M4. Profile self-update allows changing `is_active` / `team_id`** — `00004:30-35` correctly pins `role`, but a deactivated user could re-activate themselves or self-assign a team. Whitelist self-updatable columns to `full_name, avatar_url`.
- **M5. Open redirect after login** — `src/app/(auth)/auth/confirm/route.ts:7,15` follows an unvalidated `next` param (`?next=https://evil.com`). Require `next` to be app-relative (starts with `/`, not `//`).
- **M6. No rate limiting** — `src/app/api/email/route.ts` (a logged-in user can send unlimited outbound mail via the org's Graph token) and the LLM endpoints (`ask-sql`, `ask-documents`, `chat`) per-request paid-API cost. Add per-user throttling + a recipient/batch cap on email.

---

## ⚪ Low / hardening

- **L1. Verbose error responses** — multiple routes echo raw `error.message` (and `ask-sql` echoes generated SQL + raw OpenAI response) to clients: `ask-sql/route.ts:371-377,396-401`, `chat/route.ts:165-173`, `email/route.ts:558`, `users/invite/route.ts:58/83`, `documents/*`, `fortnox/debug`. Return generic messages; log detail server-side.
- **L2. Leftover debug logging** — `ask-sql/route.ts:288` `console.log(response)`; `fortnox-sie/callback/route.ts:135` logs the full error object (could capture OAuth code/token). Log `error.message` only.
- **L3. File upload validation is client-side only** — `settings/files/page.tsx:42-74` sanitizes names but there is no server-side file-type allow-list or size limit; uploads go directly client→storage. Add server-side limits if untrusted content is a concern.
- **L4. Tokens unencrypted at rest** — `fortnox_connection` and `sie_connections` keep `access_token`/`refresh_token` in plaintext. Use column-level encryption (pgsodium / `pgp_sym_encrypt`), decrypt only in server sync code.

---

## What's already done well

- Service-role key (`SUPABASE_SERVICE_ROLE_KEY`) is used **only** in `src/lib/supabase/admin.ts` and server code — no client component imports it. (verified)
- No hardcoded secrets in source; `.env*` is gitignored and was **never committed** (full-history scan clean). All `NEXT_PUBLIC_*` vars are non-sensitive (anon key, public OAuth client ID, URLs). Anthropic/OpenAI/Voyage keys are server-only.
- The **SIE OAuth subsystem** is a model to copy: CSRF nonce, admin gate, org-number identity guard, fail-closed cron auth (`CRON_SECRET`).
- Mail tracking pixels validate UUIDs and have a solid open-redirect guard (`isSafeRedirectUrl`, https/mailto only).
- Most API routes correctly follow `getUser()` + `role === 'admin'`. Auth (not authorization) is solid; `getUser()` (not `getSession()`) used server-side.

---

## Suggested fix order

1. **C2 + C3** — enable RLS on `documents`, `document_chunks`, `sync_jobs`. ✅ **Done** in migration `00071_security_rls_hardening.sql`.
2. **C4** — gate/RLS-bind the AI SQL runner; stop leaking SQL. _(code change, not yet done)_
3. **C5 + H3** — verify the Fortnox webhook signature; add `state` to the OAuth callback. _(code change)_
4. **H1 + H2** — role-gate the chat SIE/hit-list tools and the ingest route. _(code change)_
5. **H4 + L4** — stop selecting token columns client-side; encrypt tokens at rest.
6. **H5 / H6 / M-series** — server-side admin gates, fix `useScope`, tighten the over-permissive RLS policies.

~~C1~~ was a false positive (see above). The remaining criticals are small, surgical code changes (route guards) rather than architectural rework.
