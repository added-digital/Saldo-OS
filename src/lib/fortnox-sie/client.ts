import type { SupabaseClient } from "@supabase/supabase-js";

import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Per-customer SIE HTTP client.
 *
 * Three responsibilities:
 *   1. Read the per-customer token pair from `sie_connections`.
 *   2. Refresh the access token using the refresh token when it's within 5
 *      minutes of expiry (or already expired). Persist the rotated pair
 *      back to the row — Fortnox rotates BOTH tokens on every refresh.
 *   3. Call Fortnox's bookkeeping API on behalf of the customer:
 *        - GET /3/financialyears (to translate calendar year → year id)
 *        - GET /3/sie/{type}?financialyear={id} (the actual SIE export)
 *
 * The whole module is admin-context only — it uses the Supabase admin
 * client to read/write `sie_connections`, bypassing RLS. The calling route
 * is responsible for verifying the user is admin BEFORE invoking these
 * helpers.
 */

const FORTNOX_API_BASE = "https://api.fortnox.se";
const FORTNOX_AUTH_BASE = "https://apps.fortnox.se/oauth-v1";

// Refresh when the token has less than this much life remaining. Mirrors
// the buffer used by the firm-wide Fortnox sync (src/lib/fortnox/sync.ts).
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

// Fortnox's refresh token lifetime isn't echoed back in the refresh
// response, so we encode the known-good value here.
const REFRESH_TOKEN_LIFETIME_DAYS = 45;

// SIE export format types per the standard:
//   1 — Year-end balances (årsbokslut)
//   2 — Period balances
//   3 — Object/cost-centre balances
//   4 — Full transactional export (vouchers + transactions) ← default
export type SieType = 1 | 2 | 3 | 4;

interface SieConnectionRow {
  id: string;
  customer_id: string;
  access_token: string | null;
  refresh_token: string | null;
  access_token_expires_at: string | null;
  refresh_token_expires_at: string | null;
  fortnox_tenant_id: string | null;
  connection_status: string;
}

interface FortnoxRefreshResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

interface FortnoxApiErrorBody {
  ErrorInformation?: {
    Error?: number;
    Message?: string;
    Code?: number;
  };
}

function clientCredsHeader(): string {
  const id = process.env.FORTNOX_SIE_CLIENT_ID;
  const secret = process.env.FORTNOX_SIE_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error(
      "FORTNOX_SIE_CLIENT_ID / FORTNOX_SIE_CLIENT_SECRET are not configured.",
    );
  }
  return `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
}

async function loadConnection(
  admin: SupabaseClient,
  customerId: string,
): Promise<SieConnectionRow | null> {
  const { data, error } = await admin
    .from("sie_connections")
    .select(
      "id, customer_id, access_token, refresh_token, access_token_expires_at, refresh_token_expires_at, fortnox_tenant_id, connection_status",
    )
    .eq("customer_id", customerId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load sie_connections: ${error.message}`);
  }
  return (data as unknown as SieConnectionRow) ?? null;
}

/**
 * Exchange the stored refresh token for a fresh pair, persist the new
 * pair, and return the new access token. Marks the row `needs_reauth` and
 * throws on failure so callers can surface a useful error rather than
 * silently retrying with a dead token.
 */
async function refreshAccessToken(
  admin: SupabaseClient,
  conn: SieConnectionRow,
): Promise<{ accessToken: string; tenantId: string | null }> {
  if (!conn.refresh_token) {
    throw new Error(
      "SIE connection has no refresh_token — re-authorise required.",
    );
  }

  const response = await fetch(`${FORTNOX_AUTH_BASE}/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: clientCredsHeader(),
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: conn.refresh_token,
    }),
  });

  if (!response.ok) {
    // Mark the connection needs_reauth so the UI surfaces the problem.
    await admin
      .from("sie_connections")
      .update({
        connection_status: "needs_reauth",
        last_error: `refresh_token rejected (${response.status})`,
      } as never)
      .eq("id", conn.id);
    const bodyText = await response.text().catch(() => "");
    throw new Error(
      `Fortnox refresh failed: ${response.status} ${bodyText.slice(0, 200)}`,
    );
  }

  const tokens = (await response.json()) as FortnoxRefreshResponse;
  const now = Date.now();
  const accessExpiresAt = new Date(
    now + (tokens.expires_in ?? 3600) * 1000,
  ).toISOString();
  const refreshExpiresAt = new Date(
    now + REFRESH_TOKEN_LIFETIME_DAYS * 24 * 3600 * 1000,
  ).toISOString();

  // Extract tenant from the new JWT in case Fortnox rotated it.
  let tenantId = conn.fortnox_tenant_id;
  try {
    const payload = JSON.parse(
      Buffer.from(tokens.access_token.split(".")[1], "base64").toString(),
    );
    tenantId = String(payload.tenantId ?? payload.tenant_id ?? tenantId ?? "");
  } catch {
    // Keep the stored tenant id on parse failure.
  }

  const { error: updateError } = await admin
    .from("sie_connections")
    .update({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      access_token_expires_at: accessExpiresAt,
      refresh_token_expires_at: refreshExpiresAt,
      fortnox_tenant_id: tenantId,
      connection_status: "active",
      last_error: null,
    } as never)
    .eq("id", conn.id);

  if (updateError) {
    throw new Error(
      `Failed to persist refreshed SIE tokens: ${updateError.message}`,
    );
  }

  return { accessToken: tokens.access_token, tenantId };
}

/**
 * Return a valid access token + tenant id for the given customer's SIE
 * connection. Refreshes transparently if the stored token is within the
 * 5-minute expiry buffer (or already expired).
 */
export async function getValidSieAccessToken(
  customerId: string,
  admin?: SupabaseClient,
): Promise<{
  accessToken: string;
  tenantId: string | null;
  connectionId: string;
  refreshedJustNow: boolean;
}> {
  const adminClient = admin ?? createAdminClient();
  const conn = await loadConnection(adminClient, customerId);
  if (!conn) {
    throw new Error(
      `No SIE connection found for customer ${customerId}. Connect via /settings/sie first.`,
    );
  }
  if (!conn.access_token) {
    throw new Error(
      `SIE connection for customer ${customerId} has no access_token.`,
    );
  }

  const expiresAt = conn.access_token_expires_at
    ? Date.parse(conn.access_token_expires_at)
    : 0;
  const needsRefresh = !expiresAt || expiresAt - Date.now() < REFRESH_BUFFER_MS;

  if (!needsRefresh) {
    return {
      accessToken: conn.access_token,
      tenantId: conn.fortnox_tenant_id,
      connectionId: conn.id,
      refreshedJustNow: false,
    };
  }

  const { accessToken, tenantId } = await refreshAccessToken(adminClient, conn);
  return {
    accessToken,
    tenantId,
    connectionId: conn.id,
    refreshedJustNow: true,
  };
}

/**
 * Resolve a Fortnox `financialyear` numeric id for a given calendar year.
 * Fortnox's SIE endpoint requires the internal id, not the calendar year.
 *
 * `?debugBody` is filled in on the return value when present — useful for
 * the debug route to surface what Fortnox actually sent back when no
 * match is found.
 */
export async function resolveFinancialYearId(opts: {
  accessToken: string;
  tenantId: string | null;
  year: number;
}): Promise<{ id: number | null; rawBody: unknown; url: string }> {
  // GET /3/financialyears?date=YYYY-06-30
  // Mid-year date guarantees we land inside the financial year row even
  // for organisations using non-calendar fiscal years (1 Jul → 30 Jun).
  const url = `${FORTNOX_API_BASE}/3/financialyears?date=${opts.year}-06-30`;
  const response = await fetch(url, {
    method: "GET",
    headers: buildAuthedHeaders(opts.accessToken, opts.tenantId),
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw new Error(
      `Fortnox /financialyears failed: ${response.status} ${bodyText.slice(0, 200)}`,
    );
  }

  const body = (await response.json()) as Record<string, unknown>;

  // Fortnox returns financial years in one of several wrapping shapes
  // depending on the endpoint variant and whether the resource is treated
  // as a list or a single record. Handle all observed variants:
  //
  //   1. { FinancialYears: [ { Id, ... } ] }          (modern REST list)
  //   2. { FinancialYears: { FinancialYear: [ … ] } } (legacy XML-style list)
  //   3. { FinancialYear: { Id, ... } }               (single-record fetch)
  //   4. [ { Id, ... } ]                              (bare array)
  //
  // We also handle lower-case `id` defensively because some Fortnox
  // endpoints have inconsistent casing.
  const pickId = (item: unknown): number | null => {
    if (!item || typeof item !== "object") return null;
    const rec = item as Record<string, unknown>;
    const cand = rec.Id ?? rec.id;
    return typeof cand === "number" ? cand : null;
  };

  // Shape 1: { FinancialYears: [...] }
  const listDirect = (body as { FinancialYears?: unknown }).FinancialYears;
  if (Array.isArray(listDirect) && listDirect.length > 0) {
    const id = pickId(listDirect[0]);
    if (id != null) return { id, rawBody: body, url };
  }

  // Shape 2: { FinancialYears: { FinancialYear: [...] } }
  if (
    listDirect &&
    typeof listDirect === "object" &&
    "FinancialYear" in (listDirect as Record<string, unknown>)
  ) {
    const nested = (listDirect as { FinancialYear?: unknown }).FinancialYear;
    if (Array.isArray(nested) && nested.length > 0) {
      const id = pickId(nested[0]);
      if (id != null) return { id, rawBody: body, url };
    }
  }

  // Shape 3: { FinancialYear: { Id, ... } }
  const single = (body as { FinancialYear?: unknown }).FinancialYear;
  if (single && !Array.isArray(single)) {
    const id = pickId(single);
    if (id != null) return { id, rawBody: body, url };
  }

  // Shape 4: bare array at the top
  if (Array.isArray(body) && body.length > 0) {
    const id = pickId(body[0]);
    if (id != null) return { id, rawBody: body, url };
  }

  return { id: null, rawBody: body, url };
}

export interface FetchSieResult {
  url: string;
  status: number;
  headers: Record<string, string>;
  byteLength: number;
  /** Decoded as latin1 so all bytes are preserved and the text is readable
   *  even for CP437-encoded SIE files. Callers can re-decode if needed.
   *  For correct Swedish characters use `buffer` with the parser instead. */
  text: string;
  /** Raw bytes as returned by Fortnox. SIE files are typically CP437/PC8
   *  encoded — pass this to the parser which detects the encoding from
   *  the `#FORMAT` header and decodes accordingly. */
  buffer: Buffer;
}

/**
 * Fetch an SIE export file for the given customer + year. This is the
 * one-shot data pull that the future nightly sync step will wrap.
 */
export async function fetchSieFile(opts: {
  customerId: string;
  type: SieType;
  /** Calendar year (e.g. 2026). Mutually exclusive with financialYearId. */
  year?: number;
  /** Pre-resolved Fortnox financial-year id. Skips the lookup call. */
  financialYearId?: number;
  admin?: SupabaseClient;
}): Promise<FetchSieResult & { financialYearId: number }> {
  const adminClient = opts.admin ?? createAdminClient();
  const { accessToken, tenantId } = await getValidSieAccessToken(
    opts.customerId,
    adminClient,
  );

  // Resolve financial year id if not provided.
  let financialYearId = opts.financialYearId ?? null;
  if (financialYearId == null) {
    const year = opts.year ?? new Date().getFullYear();
    const resolved = await resolveFinancialYearId({
      accessToken,
      tenantId,
      year,
    });
    if (resolved.id == null) {
      // Include the raw response shape in the error so the debug route can
      // surface what Fortnox actually sent back. Helps diagnose "no match"
      // cases that turn out to be a parser miss rather than a missing year.
      const preview = JSON.stringify(resolved.rawBody).slice(0, 600);
      throw new Error(
        `No Fortnox financial year matching ${year} for customer ${opts.customerId}. Fortnox responded (${resolved.url}): ${preview}`,
      );
    }
    financialYearId = resolved.id;
  }

  const url = `${FORTNOX_API_BASE}/3/sie/${opts.type}?financialyear=${financialYearId}`;
  const response = await fetch(url, {
    method: "GET",
    headers: buildAuthedHeaders(accessToken, tenantId),
  });

  const arrayBuffer = await response.arrayBuffer();
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  if (!response.ok) {
    // Try to parse a Fortnox error payload if the body is JSON-ish.
    let detail = "";
    try {
      const parsed = JSON.parse(
        Buffer.from(arrayBuffer).toString("utf8"),
      ) as FortnoxApiErrorBody;
      detail = parsed.ErrorInformation?.Message ?? "";
    } catch {
      detail = Buffer.from(arrayBuffer).toString("latin1").slice(0, 200);
    }
    throw new Error(
      `Fortnox /3/sie/${opts.type} failed: ${response.status} ${detail}`,
    );
  }

  const buffer = Buffer.from(arrayBuffer);
  return {
    url,
    status: response.status,
    headers,
    byteLength: arrayBuffer.byteLength,
    text: buffer.toString("latin1"),
    buffer,
    financialYearId,
  };
}

/**
 * Fetch the connected company's organisation number straight from Fortnox,
 * using a raw access token + tenant (NOT a stored sie_connections row).
 *
 * Used by the OAuth callback as a connect-time guard: at that point no row
 * exists yet, so we can't go through `getValidSieAccessToken`. We compare the
 * value this returns against the Saldo customer's `org_number` to make sure
 * the admin authorised the Fortnox company they actually intended to.
 *
 * Returns null (rather than throwing) when Fortnox doesn't surface an org
 * number, so the caller can decide how to treat the "unknown" case. A failed
 * HTTP call still throws — that's a real error worth surfacing.
 */
export async function fetchCompanyOrgNumber(opts: {
  accessToken: string;
  tenantId: string | null;
}): Promise<string | null> {
  const url = `${FORTNOX_API_BASE}/3/companyinformation`;
  const response = await fetch(url, {
    method: "GET",
    headers: buildAuthedHeaders(opts.accessToken, opts.tenantId),
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw new Error(
      `Fortnox /companyinformation failed: ${response.status} ${bodyText.slice(0, 200)}`,
    );
  }

  const body = (await response.json()) as {
    CompanyInformation?: Record<string, unknown>;
  };
  const info = body.CompanyInformation ?? {};
  // Fortnox spells this "OrganizationNumber" on companyinformation (with a z),
  // but accept the s-spelling too in case of endpoint/version drift.
  const raw =
    (info.OrganizationNumber as string | undefined) ??
    (info.OrganisationNumber as string | undefined) ??
    null;
  return raw && raw.trim() !== "" ? raw : null;
}

function buildAuthedHeaders(
  accessToken: string,
  tenantId: string | null,
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };
  if (tenantId) {
    headers["TenantId"] = tenantId;
  }
  return headers;
}
