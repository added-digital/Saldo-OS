# SIE Integration Handoff — Saldo CRM

**Date:** 2026-05-25
**Purpose:** Brief a separate chat session on how Saldo CRM's existing Fortnox integration is wired, so that the upcoming SIE (Standard Import Export) file integration can be designed to slot into that architecture without colliding with it.

---

## TL;DR

Saldo CRM already has a working Fortnox integration that runs nightly and pulls operational data (customers, employees, invoices, time reports, contracts, cost centers) into Supabase. The integration is **firm-wide**: one OAuth token, one tenant. KPI rollups are computed nightly from this data.

**SIE is a different beast.** It carries each *customer's own bookkeeping* (general ledger, balance sheet, P&L) — not the firm's operational data. The plan is to OAuth into Fortnox **per-customer**, pull SIE files for each, parse the ledger entries, and store them in new tables alongside the existing operational data.

Groundwork already exists: a `sie_connections` table, a Settings UI page, and a stub OAuth handler. The OAuth flow, the file parser, the storage schema for ledger data, and the nightly sync step all still need to be built.

---

## 1. Current Fortnox Integration (what's already working)

### 1.1 Authentication

- **Method:** OAuth 2.0, firm-wide (one connection for the entire firm, stored in `fortnox_connection` table).
- **Token lifetime:** Access token ≈ 1h, refresh token ≈ 45 days. Both rotate on each refresh. Refresh handled in `getConnectionWithValidToken()` (`src/lib/fortnox/sync.ts:9-60`) with a 5-minute safety buffer.
- **Scopes:** `companyinformation, customer, invoice, article, costcenter, bookkeeping, settings, salary` (`src/lib/fortnox/auth.ts:10-19`).
- **TenantId** extracted from the JWT payload at auth time, used for downstream API calls.

### 1.2 What's synced FROM Fortnox

One-way: Fortnox → CRM. No writes back to Fortnox.

| Fortnox endpoint | Destination table(s) | Notes |
|---|---|---|
| `/3/customers` | `customers` | Paginated, 500/page |
| `/3/employees` | Supabase Auth users + `profiles` | Linked via `fortnox_employee_id` |
| `/3/costcenters` | `cost_centers` | Upserted by `code` |
| `/3/invoices` | `invoices`, `invoice_rows` | |
| `/api/time/registrations-v2` | `time_reports` | Normalizer handles 10+ field-name variants |
| `/3/contracts/accruals` | `contract_accruals` | |
| `/3/articles` | (article registry) | |

### 1.3 Sync cadence

- **Nightly cron at 01:00 Europe/Stockholm.** Steps run in order: `customers → invoices → time-reports → contracts → articles → generate-kpis` (`src/lib/sync/nightly.ts:11-18`).
- **Manual triggers** available via `/api/fortnox/sync` and `/api/sync/[step]` endpoints.
- **Webhook** route exists at `/api/fortnox/webhook` but the handler is a **stub** (`src/lib/fortnox/websocket.ts:21-29` — Kafka-event Fortnox push, not implemented). Currently only nightly polling works.

### 1.4 The cost-center concept (important context)

Customers are linked to consultants **not by a foreign key, but by a string match** on `fortnox_cost_center`. The pipeline:

1. Fortnox cost centers (e.g. code `MAT`, name `Mattias Thorslund`) are upserted into `cost_centers`.
2. Customers carry their `fortnox_cost_center` code on `customers.fortnox_cost_center`.
3. `linkCostCentersToProfiles()` (`src/lib/fortnox/sync.ts:388-454`) matches the cost-center `name` (case-insensitive, whitespace-normalised) against `profiles.full_name` and writes the matching code back to `profiles.fortnox_cost_center`.
4. Every query that needs "consultant's portfolio" joins customers ↔ profiles via that string code.

This matters for SIE because: SIE data is *per customer*, so it inherits the customer's cost-center linkage automatically — no new linkage logic needed if the SIE tables carry `customer_id` or `fortnox_customer_number`.

### 1.5 Database tables receiving Fortnox data

`customers`, `invoices`, `invoice_rows`, `time_reports`, `contract_accruals`, `customer_kpis`, `profiles`, `cost_centers`. Each carries Fortnox identifiers: `fortnox_customer_number`, `fortnox_cost_center`, `fortnox_employee_id`, `fortnox_active`, `fortnox_raw` (raw API payload preserved for debugging).

---

## 2. What's already in place for SIE (groundwork)

| Asset | Location | Status |
|---|---|---|
| `sie_connections` table | `supabase/migrations/00052_sie_connections.sql` | **Exists.** Per-customer OAuth token storage. Plaintext today; encryption (pgsodium / `pgp_sym_encrypt`) flagged as a post-pilot TODO in the migration comment. |
| TypeScript types | `src/types/database.ts:411` (`SieConnection`) | **Exists.** |
| Settings UI | `src/app/(dashboard)/settings/sie/page.tsx` | **Exists.** Customer list with status badges and "Connect" buttons. |
| OAuth handler | `handleConnect()` in the SIE settings page (lines ~261-276) | **Stub.** Surfaces a toast saying "SIE OAuth not yet wired — awaiting Fortnox app credentials." Requires `FORTNOX_SIE_CLIENT_ID` env var and an `/api/fortnox-sie/auth` route that does not yet exist. |
| Nightly sync step | `NIGHTLY_SYNC_STEPS` in `src/lib/sync/nightly.ts:11-18` | **SIE is NOT included.** A new step would need to be added. |

---

## 3. What still needs to be built for SIE

The order below reflects natural dependency:

1. **Per-customer OAuth flow.** A new `/api/fortnox-sie/auth` route + callback. Unlike the existing firm-wide auth, this needs to be invocable per customer and store the resulting tokens in `sie_connections` keyed by `customer_id`. Mirror the structure of `src/lib/fortnox/auth.ts` but with `bookkeeping` (and any SIE-specific) scopes only.
2. **SIE file fetch.** Endpoint to call per `sie_connections` row, retrieve the SIE file (Fortnox endpoint TBD by the implementer — likely a downloads endpoint on the bookkeeping API). Honour the existing 350ms inter-call delay pattern (`src/lib/fortnox/sync.ts:102`) to stay under rate limits.
3. **SIE parser.** SIE is a structured *plain-text* format with header lines (e.g. `#FNAMN`, `#ORGNR`, `#KPTYP`) and record lines (e.g. `#VER`, `#TRANS`, `#IB`, `#UB`, `#RES`). It is **not safely runnable through the existing `/api/documents/ingest` chunker** (`src/app/api/documents/ingest/route.ts`) — that pipeline word-chunks for vector search and would break SIE semantics. A dedicated parser is required (`sie4` npm package or custom).
4. **Storage schema for ledger data.** New tables, none of which exist yet. Likely shape:
   - `sie_accounts` (chart of accounts per customer)
   - `sie_verifications` (header per accounting voucher)
   - `sie_transactions` (line items inside each verification)
   - `sie_period_balances` (opening/closing/result per period per account)

   All keyed to `customer_id` and `fortnox_customer_number` so they join into the existing customer/KPI graph the same way `invoices` and `time_reports` do.
5. **Nightly sync step.** Add `sie` (or `sie-imports`) to `NIGHTLY_SYNC_STEPS`. Iterate over `sie_connections` rows, fetch+parse+upsert per customer. Reuse the existing batching/delay patterns.
6. **Token encryption.** Move `sie_connections.access_token` / `refresh_token` from plaintext to encrypted storage before pilot. See migration comment at `00052_sie_connections.sql:8-10`.

---

## 4. Constraints & gotchas to design around

- **Rate limits.** Fortnox enforces them aggressively. The existing sync uses a 350ms inter-request delay and 500-row pagination (`src/lib/fortnox/sync.ts:102`). Replicate this for SIE.
- **Name matching is fragile.** Cost-centre linkage relies on exact lowercase-normalised string match between Fortnox cost-centre names and `profiles.full_name`. Typos in Fortnox don't link. SIE shouldn't introduce a second fragile string match — use IDs (`customer_id`, `fortnox_customer_number`) for all linkage.
- **Customer deletion cascades.** When `/api/fortnox/sync-customer` detects a 404 ("Kan inte hitta kunden") it cascades deletes across `invoices`, `invoice_rows`, `time_reports`, `contract_accruals` in chunks of 200 (`src/app/api/fortnox/sync-customer/route.ts:44-153`). SIE tables will need the same cascade behaviour.
- **Webhook is unimplemented.** Don't design SIE around real-time webhooks; nightly polling is the only reliable trigger today.
- **Plaintext tokens are a known security debt.** Don't add to that — implement encryption from day one for SIE if at all possible.
- **Document RAG pipeline is the wrong fit for SIE.** `/api/documents/ingest` is for unstructured text (PDF, DOCX, plain text) and chunks at 400 words with 50-word overlap. SIE is structured ledger data and needs its own parsing path.

---

## 5. Where to plug in (specific files to read or mirror)

- **Auth pattern to mirror:** `src/lib/fortnox/auth.ts` (90 lines, OAuth + JWT decode + token persist).
- **Sync orchestration pattern to mirror:** `src/lib/fortnox/sync.ts` (454 lines — read `syncCostCenters` and `syncCustomers` for the canonical upsert-with-pagination pattern).
- **Adding a nightly step:** `src/lib/sync/nightly.ts:11-18` (just an array; the step runner reads it).
- **Per-step route pattern:** `src/app/api/sync/[step]/route.ts` is a generic step runner you can wire `sie` into.
- **Existing SIE migration:** `supabase/migrations/00052_sie_connections.sql` (the only SIE-related schema today).
- **SIE settings page (UI to extend once OAuth lands):** `src/app/(dashboard)/settings/sie/page.tsx`.

---

## 6. Caveats on this brief

This summary was compiled by reading the relevant files but not exhaustively verifying every line. Treat the file:line references as pointers to start from, not as authoritative excerpts. When designing the actual integration, re-read each cited file directly — they're short, and assumptions in this brief should be cross-checked against the live code before being baked into design decisions.

Specifically worth double-checking:

- The exact Fortnox SIE-download endpoint and its rate-limit behaviour (we did not verify this from Fortnox's own docs — it's outside the codebase).
- Whether `sie_connections` already includes columns for tenant/realm IDs needed for the per-customer OAuth handshake.
- Whether `customer_id` in the proposed SIE tables can be a hard FK (some existing tables use it as a soft link via `fortnox_customer_number` to survive late customer linkage).
