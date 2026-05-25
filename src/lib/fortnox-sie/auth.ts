import type {
  FortnoxTokenResponse,
  FortnoxApiError,
} from "@/types/fortnox";

/**
 * Per-customer SIE OAuth helper.
 *
 * Separate from the firm-wide Fortnox app (`src/lib/fortnox/auth.ts`) because:
 *   - Different Fortnox app registration (different client_id/secret)
 *   - Narrower scope (bookkeeping only — for SIE/general-ledger access)
 *   - Per-customer tokens (one row in `sie_connections` per customer),
 *     vs. one firm-wide row in `fortnox_connection`.
 *
 * The redirect URI is supplied by the caller (the route handler derives it
 * from the incoming request URL) so this module stays environment-agnostic
 * and works on prod, staging, and any future preview deploys that have
 * been registered with the Fortnox app.
 */

const FORTNOX_AUTH_BASE = "https://apps.fortnox.se/oauth-v1";

// Only `bookkeeping` is needed for SIE downloads / ledger reads. Keeping
// the scope narrow matches what's registered on the SIE Fortnox app and
// minimises the permissions a single customer grants when they connect.
const SIE_SCOPES = ["bookkeeping"].join(" ");

function authHeader(): string {
  const clientId = process.env.FORTNOX_SIE_CLIENT_ID;
  const clientSecret = process.env.FORTNOX_SIE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "FORTNOX_SIE_CLIENT_ID / FORTNOX_SIE_CLIENT_SECRET are not configured.",
    );
  }
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}

/**
 * Build the URL the user is redirected to in order to grant the SIE
 * integration access to their Fortnox bookkeeping. `state` is opaque to
 * Fortnox — the callback route reads it back to know which customer the
 * grant belongs to and to enforce CSRF.
 */
export function getSieAuthorizationUrl(params: {
  redirectUri: string;
  state: string;
}): string {
  const clientId = process.env.FORTNOX_SIE_CLIENT_ID;
  if (!clientId) {
    throw new Error("FORTNOX_SIE_CLIENT_ID is not configured.");
  }
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: params.redirectUri,
    scope: SIE_SCOPES,
    state: params.state,
    response_type: "code",
    account_type: "service",
  });
  return `${FORTNOX_AUTH_BASE}/auth?${query.toString()}`;
}

/**
 * Exchange the authorization code Fortnox returned for an access+refresh
 * token pair. The same `redirectUri` used to start the flow must be passed
 * here byte-for-byte, or Fortnox rejects with `invalid_grant`.
 */
export async function exchangeSieCodeForTokens(params: {
  code: string;
  redirectUri: string;
}): Promise<FortnoxTokenResponse> {
  const response = await fetch(`${FORTNOX_AUTH_BASE}/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: authHeader(),
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: params.redirectUri,
    }),
  });

  if (!response.ok) {
    const error = (await response.json()) as FortnoxApiError;
    throw new Error(
      `Fortnox SIE auth error: ${error.ErrorInformation?.Message ?? response.statusText}`,
    );
  }

  return response.json() as Promise<FortnoxTokenResponse>;
}
