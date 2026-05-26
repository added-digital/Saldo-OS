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
 */
export async function resolveFinancialYearId(opts: {
  accessToken: string;
  tenantId: string | null;
  year: number;
}): Promise<number | null> {
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

  // Two response shapes observed in the wild:
  //   { FinancialYear: { Id: 1, ... } }
  //   { FinancialYears: { FinancialYear: [ {...} ] } }
  // Handle both defensively.
  const body = (await response.json()) as Record<string, unknown>;
  const single = (body as { FinancialYear?: { Id?: number } }).FinancialYear;
  if (single && typeof single.Id === "number") return single.Id;

  const list = (
    body as { FinancialYears?: { FinancialYear?: Array<{ Id?: number }> } }
  ).FinancialYears?.FinancialYear;
  if (Array.isArray(list) && list.length > 0 && typeof list[0].Id === "number") {
    return list[0].Id;
  }
  return null;
}

export interface FetchSieResult {
  url: string;
  status: number;
  headers: Record<string, string>;
  byteLength: number;
  /** Decoded as latin1 so all bytes are preserved and the text is readable
   *  even for CP437-encoded SIE files. Callers can re-decode if needed. */
  text: string;
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
    financialYearId = await resolveFinancialYearId({
      accessToken,
      tenantId,
      year,
    });
    if (financialYearId == null) {
      throw new Error(
        `No Fortnox financial year matching ${year} for customer ${opts.customerId}.`,
      );
    }
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

  return {
    url,
    status: response.status,
    headers,
    byteLength: arrayBuffer.byteLength,
    text: Buffer.from(arrayBuffer).toString("latin1"),
    financialYearId,
  };
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
