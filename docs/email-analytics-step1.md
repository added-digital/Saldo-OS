# Email Analytics — Step 1: Metadata Sync + Volume KPIs

Foundation for email analytics in SaldoOS over Microsoft 365 (Microsoft Graph).
Pattern mirrors Fortnox: **Graph API → Supabase/Postgres → aggregate in the database**.

Scope of step 1: **metadata only** + volume KPIs. No body, no attachments, no
response times / SLA / AI. All Graph facts below verified against current Microsoft
Learn docs (June 2026) — see Sources at the bottom.

---

## 1. Data model

Three tables: `mailboxes` (one row per individual or shared mailbox),
`messages` (one row per message *occurrence in a mailbox*), and
`message_recipients` (normalized, for unique-contact counts).
Plus `mailbox_sync_state` to hold delta tokens.

> 🔒 **Personal data (GDPR):** `mailboxes`, `messages`, `message_recipients` all
> hold personal data (email addresses, names, communication/traffic metadata).
> Flagged here for the data inventory. See §5.

```sql
-- Extensions (Supabase: both available)
create extension if not exists citext;     -- case-insensitive email addresses
create extension if not exists pgcrypto;   -- gen_random_uuid()

-- ── Mailboxes ────────────────────────────────────────────────────────────────
-- One row per mailbox we sync. Maps a personal mailbox to a consultant (profiles).
-- Shared mailboxes (info@, support@) have person_id = null and type = 'shared'.
create table public.mailboxes (
  id            uuid primary key default gen_random_uuid(),
  graph_user_id text not null unique,          -- Graph /users id (immutable)
  address       citext not null unique,         -- person@, info@, support@
  display_name  text,
  type          text not null default 'user'
                  check (type in ('user','shared')),
  person_id     uuid references public.profiles(id) on delete set null, -- null for shared
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);

-- ── Messages (metadata only) ─────────────────────────────────────────────────
-- The same email can appear in two of our mailboxes (sender's Sent + recipient's
-- Inbox). That is intentional: volume is counted per mailbox. internet_message_id
-- lets us dedupe across mailboxes later if needed.
create table public.messages (
  id                  uuid primary key default gen_random_uuid(),
  mailbox_id          uuid not null references public.mailboxes(id) on delete cascade,
  graph_id            text not null,            -- message id, immutable within a mailbox
  internet_message_id text,                     -- RFC 5322 Message-ID, stable across mailboxes
  conversation_id     text,                     -- thread key
  direction           text not null
                        check (direction in ('inbound','outbound')),
  from_address        citext,
  from_name           text,                     -- minimization: nullable, drop if not needed
  received_at         timestamptz,              -- inbound timestamp
  sent_at             timestamptz,              -- outbound timestamp
  event_at            timestamptz generated always as
                        (coalesce(sent_at, received_at)) stored,  -- unified time axis
  folder_id           text,
  folder_name         text,
  has_attachments     boolean,
  is_read             boolean,
  synced_at           timestamptz not null default now(),
  deleted_at          timestamptz,              -- soft delete: set when Graph reports @removed
  unique (mailbox_id, graph_id)                 -- upsert target
);

-- ── Recipients (normalized) ──────────────────────────────────────────────────
-- Needed for "unique contacts per person" and per-recipient analysis.
create table public.message_recipients (
  message_id  uuid not null references public.messages(id) on delete cascade,
  kind        text not null check (kind in ('to','cc','bcc')),
  address     citext not null,
  name        text,
  primary key (message_id, kind, address)
);

-- ── Sync state (delta tokens, per folder) ────────────────────────────────────
create table public.mailbox_sync_state (
  mailbox_id     uuid not null references public.mailboxes(id) on delete cascade,
  folder_id      text not null,
  folder_name    text,
  delta_link     text,                          -- full @odata.deltaLink for next round
  last_synced_at timestamptz,
  primary key (mailbox_id, folder_id)
);

-- ── Indexes ──────────────────────────────────────────────────────────────────
create index on public.messages (mailbox_id, event_at);   -- per-mailbox time queries
create index on public.messages (direction, event_at);    -- sent/received over time
create index on public.messages (conversation_id);
create index on public.messages (from_address);
create index on public.messages using brin (event_at);    -- cheap for large append-mostly table
create index on public.message_recipients (address);
create index on public.message_recipients (message_id);
```

**Why these choices**
- **One row per (mailbox, message)** — volume KPIs are inherently per-mailbox; deduping at write time would lose that. `internet_message_id` keeps cross-mailbox dedup possible later.
- **`unique (mailbox_id, graph_id)`** — Graph `id` is immutable per mailbox, so this is the natural idempotent upsert key for delta sync.
- **`direction`** — Graph has no "direction" field. We derive it at sync time: `outbound` when `from_address = mailbox.address` (or the message is in the Sent Items folder), else `inbound`.
- **`event_at` generated column** — one column to bucket on regardless of in/out; indexed for all the time-series KPIs.
- **No `subject`, no body** — data minimization. Volume KPIs don't need them, and `Mail.ReadBasic.All` can't return the body anyway (§2).
- **Normalized recipients** — `count(distinct address)` for unique contacts is clean and indexable; a JSONB array would force per-row unnesting on every query.
- **BRIN on `event_at`** — messages arrive roughly in time order, so BRIN gives near-free range pruning on a large table; the btree composites cover the grouped queries.

---

## 2. Graph endpoints & permissions (verified)

**Auth:** OAuth 2.0 **client credentials** (app-only), tenant admin consent. Org-level, no signed-in user.

### Application permissions (admin consent required)
| Permission | Why | Notes |
|---|---|---|
| **`Mail.ReadBasic.All`** | Read message **metadata** in all mailboxes | **Least privileged for `messages/delta`. Returns all message properties EXCEPT `body`, `previewBody`, `attachments`, and extended properties.** This is our guardrail — the body is structurally inaccessible. |
| **`User.Read.All`** | Enumerate mailboxes (users + shared) | Read `id`, `mail`, `displayName`, `userPrincipalName`. |

> Do **not** request `Mail.Read` — it grants body + attachments and breaks the "metadata only" guarantee.

### Optional but recommended: scope the blast radius
`Mail.ReadBasic.All` is tenant-wide. Restrict *which* mailboxes the app token can read with **RBAC for Applications in Exchange Online** (`New-ManagementRoleAssignment` scoped to a mail-enabled security group). This replaces the older Application Access Policies. Lets you start with a pilot group and expand.

### Endpoints
```http
# 1. Enumerate mailboxes (users + shared mailboxes both appear here)
GET /v1.0/users?$select=id,displayName,mail,userPrincipalName&$filter=mail ne null&$top=999

# 2. List folders for a mailbox (to track each folder's delta)
GET /v1.0/users/{userId}/mailFolders?$select=id,displayName,wellKnownName&$top=100
#   ...or track changes to the folder list itself:
GET /v1.0/users/{userId}/mailFolders/delta

# 3. Metadata sync — per folder, metadata-only via $select (NEVER select body/attachments)
GET /v1.0/users/{userId}/mailFolders/{folderId}/messages/delta?$select=id,conversationId,internetMessageId,receivedDateTime,sentDateTime,from,toRecipients,ccRecipients,bccRecipients,parentFolderId,hasAttachments,isRead
Prefer: odata.maxpagesize=100
```
All requested `$select` fields are covered by `Mail.ReadBasic.All`. `delta` is **per folder**. **Step-1 decision: track only Inbox + Sent Items** (well-known folder names `inbox` and `sentitems`). This covers every volume KPI, keeps sync cheap, and avoids Junk/Deleted Items inflating "received". More folders can be added later with no schema change.

---

## 3. Sync strategy

### Initial backfill
For each mailbox → each folder, call `…/messages/delta` with **no token** and page through `@odata.nextLink` (`$skiptoken`) until you receive `@odata.deltaLink` (`$deltatoken`). Upsert each page into `messages` (+ `message_recipients`). Store the final `@odata.deltaLink` in `mailbox_sync_state`.

- **Step-1 decision: backfill from 2025-01-01.** Add `$filter=receivedDateTime ge 2025-01-01T00:00:00Z` to the **initial** delta call. Caveat: a filtered delta returns at most **5,000 messages** — if any single folder has more than that since 2025-01-01, chunk the backfill by date range (e.g. month by month) and merge.
- Use a large `Prefer: odata.maxpagesize` (≤100 here) to minimize request count.

### Ongoing / incremental
On a schedule (e.g. every 5–15 min), call the saved `@odata.deltaLink` per folder. You get only changes since last round, ending in a fresh `@odata.deltaLink` to persist.

### How delta query works
- Tokens are **opaque state tokens**. `@odata.nextLink` carries a **`$skiptoken`** → more pages this round. `@odata.deltaLink` carries a **`$deltatoken`** → you're caught up; reuse it next round.
- Query options (`$select`, `changeType`, …) are set **once** on the initial call; Graph re-encodes them into every `next`/`delta` link, so subsequent requests just replay the URL.
- Delta is **collection-level**, so it emits some events that don't match your filter and must be handled:
  - `@removed` with `"reason": "deleted"` → message deleted/moved out of folder. **Step-1 decision: soft delete** — set `deleted_at = now()`, keep the row. KPIs intentionally still count it, so historical volume stays stable when users clean their mailboxes; `deleted_at` is for audit + GDPR erasure.
  - Read/unread state changes → an upsert that updates `is_read`.

### Avoiding throttling
- **Limits (Outlook, non-adjustable):** 10,000 requests / 10 min **per app + mailbox**, **max 4 concurrent** requests per mailbox. Limits are *per mailbox*, so **parallelize across mailboxes, serialize within one**.
- On **HTTP 429**, honor the **`Retry-After`** header exactly; add exponential backoff + jitter as a fallback.
- Fewer, larger pages (`odata.maxpagesize`) → fewer requests. Only sync folders you actually need.
- (Optional, later) Add Graph **change notifications** (subscriptions/webhooks) on Inbox/Sent for near-real-time triggers, then delta to fetch — not required for step 1.

---

## 4. KPI SQL (SECURITY INVOKER, JSONB, aggregated in-DB)

All functions are `security invoker` + `stable`, return `jsonb`, and aggregate
server-side. Time bucketing converts UTC → a business timezone (default
`Europe/Stockholm`) so weekday/hour reflect local time.

```sql
-- ── 4.1 Sent vs received per day / week / month (+ net flow + ratio) ──────────
create or replace function public.email_volume_by_period(
  p_grain   text        default 'day',     -- 'day' | 'week' | 'month'
  p_from    timestamptz default now() - interval '30 days',
  p_to      timestamptz default now(),
  p_mailbox uuid        default null,       -- null = all mailboxes
  p_tz      text        default 'Europe/Stockholm'
)
returns jsonb
language sql
security invoker
stable
as $$
  with base as (
    select date_trunc(p_grain, (m.event_at at time zone p_tz)) as bucket,
           m.direction
    from public.messages m
    where m.event_at >= p_from
      and m.event_at <  p_to
      and (p_mailbox is null or m.mailbox_id = p_mailbox)
  )
  select coalesce(jsonb_agg(r order by r->>'period'), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'period',   to_char(bucket, 'YYYY-MM-DD'),
      'sent',     count(*) filter (where direction = 'outbound'),
      'received', count(*) filter (where direction = 'inbound'),
      'net',      count(*) filter (where direction = 'outbound')
                - count(*) filter (where direction = 'inbound'),
      'ratio',    round( count(*) filter (where direction = 'outbound')::numeric
                       / nullif(count(*) filter (where direction = 'inbound'), 0), 3)
    ) as r
    from base
    group by bucket
  ) t;
$$;

-- ── 4.2 Volume per person (personal mailboxes → profiles) ─────────────────────
create or replace function public.email_volume_by_person(
  p_from timestamptz default now() - interval '30 days',
  p_to   timestamptz default now()
)
returns jsonb
language sql
security invoker
stable
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'person_id', person_id,
           'name',      full_name,
           'sent',      sent,
           'received',  received,
           'total',     sent + received
         ) order by sent + received desc), '[]'::jsonb)
  from (
    select p.id as person_id, p.full_name,
           count(*) filter (where m.direction = 'outbound') as sent,
           count(*) filter (where m.direction = 'inbound')  as received
    from public.messages m
    join public.mailboxes mb on mb.id = m.mailbox_id
    join public.profiles  p  on p.id  = mb.person_id
    where m.event_at >= p_from and m.event_at < p_to
      and mb.type = 'user'
    group by p.id, p.full_name
  ) t;
$$;

-- ── 4.3 Volume per mailbox (covers shared mailboxes: info@, support@) ─────────
create or replace function public.email_volume_by_mailbox(
  p_from timestamptz default now() - interval '30 days',
  p_to   timestamptz default now()
)
returns jsonb
language sql
security invoker
stable
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'mailbox_id', mailbox_id,
           'address',    address,
           'type',       type,
           'sent',       sent,
           'received',   received,
           'total',      sent + received
         ) order by sent + received desc), '[]'::jsonb)
  from (
    select mb.id as mailbox_id, mb.address, mb.type,
           count(*) filter (where m.direction = 'outbound') as sent,
           count(*) filter (where m.direction = 'inbound')  as received
    from public.messages m
    join public.mailboxes mb on mb.id = m.mailbox_id
    where m.event_at >= p_from and m.event_at < p_to
    group by mb.id, mb.address, mb.type
  ) t;
$$;

-- ── 4.4 Unique contacts per person ───────────────────────────────────────────
-- Contact = the counterpart address: sender for inbound, each recipient for outbound.
create or replace function public.email_unique_contacts_by_person(
  p_from timestamptz default now() - interval '30 days',
  p_to   timestamptz default now()
)
returns jsonb
language sql
security invoker
stable
as $$
  with msg as (
    select m.id, m.direction, m.from_address, mb.person_id
    from public.messages m
    join public.mailboxes mb on mb.id = m.mailbox_id
    where m.event_at >= p_from and m.event_at < p_to and mb.type = 'user'
  ),
  contacts as (
    select person_id, from_address as contact
    from msg
    where direction = 'inbound' and from_address is not null
    union
    select msg.person_id, r.address as contact
    from msg
    join public.message_recipients r on r.message_id = msg.id
    where msg.direction = 'outbound'
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'person_id',       person_id,
           'name',            full_name,
           'unique_contacts', cnt
         ) order by cnt desc), '[]'::jsonb)
  from (
    select c.person_id, p.full_name, count(distinct c.contact) as cnt
    from contacts c
    join public.profiles p on p.id = c.person_id
    group by c.person_id, p.full_name
  ) t;
$$;

-- ── 4.5 Volume per weekday (1 = Monday … 7 = Sunday, local time) ──────────────
create or replace function public.email_volume_by_weekday(
  p_from    timestamptz default now() - interval '90 days',
  p_to      timestamptz default now(),
  p_mailbox uuid        default null,
  p_tz      text        default 'Europe/Stockholm'
)
returns jsonb
language sql
security invoker
stable
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'weekday',  dow,            -- 1=Mon … 7=Sun
           'sent',     sent,
           'received', received,
           'total',    sent + received
         ) order by dow), '[]'::jsonb)
  from (
    select extract(isodow from (m.event_at at time zone p_tz))::int as dow,
           count(*) filter (where m.direction = 'outbound') as sent,
           count(*) filter (where m.direction = 'inbound')  as received
    from public.messages m
    where m.event_at >= p_from and m.event_at < p_to
      and (p_mailbox is null or m.mailbox_id = p_mailbox)
    group by 1
  ) t;
$$;

-- ── 4.6 Volume per hour of day (0–23, local time) ────────────────────────────
create or replace function public.email_volume_by_hour(
  p_from    timestamptz default now() - interval '90 days',
  p_to      timestamptz default now(),
  p_mailbox uuid        default null,
  p_tz      text        default 'Europe/Stockholm'
)
returns jsonb
language sql
security invoker
stable
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'hour',     hod,
           'sent',     sent,
           'received', received,
           'total',    sent + received
         ) order by hod), '[]'::jsonb)
  from (
    select extract(hour from (m.event_at at time zone p_tz))::int as hod,
           count(*) filter (where m.direction = 'outbound') as sent,
           count(*) filter (where m.direction = 'inbound')  as received
    from public.messages m
    where m.event_at >= p_from and m.event_at < p_to
      and (p_mailbox is null or m.mailbox_id = p_mailbox)
    group by 1
  ) t;
$$;
```

Calls return ready-to-render JSONB, e.g.:
```sql
select public.email_volume_by_period('week', now() - interval '12 weeks', now());
select public.email_volume_by_person();
select public.email_unique_contacts_by_person();
```

---

## 5. GDPR considerations (step 1)

1. **It's all personal data — even without text.** Addresses, names, and "who emailed whom, when, how often" are personal data and **communications/traffic metadata**, which is sensitive because it reveals relationships and behavioral patterns. Tables `mailboxes`, `messages`, `message_recipients` are flagged in the data inventory.
2. **Lawful basis + DPIA.** Document the legal basis (likely legitimate interest in an employment context). Systematic analysis of employee communications usually warrants a **DPIA**; in Sweden, monitoring employees may also trigger **MBL co-determination / works-council consultation** — flag for legal/HR before go-live.
3. **Data minimization is built in.** `Mail.ReadBasic.All` makes the body inaccessible; we additionally store no `subject`. Keep `from_name`/recipient `name` only if a KPI needs them.
4. **Purpose limitation.** Use strictly for volume analytics in step 1; don't repurpose for individual performance surveillance without a fresh basis.
5. **Retention.** Define a retention period and automate deletion (e.g. raw rows N months; keep only aggregates beyond that).
6. **External contacts.** Recipient/sender addresses include external people who never consented — covered by minimization + retention, and relevant to transparency.
7. **Access control.** `security invoker` + Supabase **RLS** so only authorized roles read these tables/functions.
8. **Transparency & data-subject rights.** Inform employees; be able to service DSARs and **erasure by address** (cascading deletes already support this).
9. **Data residency.** Keep processing in the EU (M365 tenant + Supabase EU region); document any sub-processors.

---

## Decisions (locked for step 1)
- **Folder scope:** Inbox + Sent Items only.
- **Backfill window:** from 2025-01-01.
- **Deletes:** soft delete (`deleted_at`); rows stay counted in KPIs.
- **Mailbox scoping:** restrict the app to a mail-enabled security group (`sg-email-analytics`) via RBAC for Applications. Start with a small pilot (a few people + shared mailboxes info@/support@), then expand. Avoids granting the app access to every mailbox in the tenant.
- **Real-time:** delta polling every 10–15 min. Change-notification webhooks deferred to a later step.

---

### Sources
- [message: delta — Graph v1.0](https://learn.microsoft.com/en-us/graph/api/message-delta?view=graph-rest-1.0)
- [Get incremental changes to messages in a folder](https://learn.microsoft.com/en-us/graph/delta-query-messages)
- [Use delta query to track changes](https://learn.microsoft.com/en-us/graph/delta-query-overview)
- [Microsoft Graph permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference)
- [RBAC for Applications in Exchange Online](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac)
- [Microsoft Graph service-specific throttling limits](https://learn.microsoft.com/en-us/graph/throttling-limits)
- [Microsoft Graph throttling guidance](https://learn.microsoft.com/en-us/graph/throttling)
