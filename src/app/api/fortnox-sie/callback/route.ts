import { NextRequest, NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { exchangeSieCodeForTokens } from "@/lib/fortnox-sie/auth";
import { extractTenantIdFromJwt } from "@/lib/fortnox/auth";

export const runtime = "nodejs";

/**
 * Receives the OAuth redirect from Fortnox after the user authorises the
 * SIE integration for one of their customers' Fortnox tenants.
 *
 * Checks performed before persisting tokens:
 *   1. `state` is well-formed and the embedded CSRF nonce matches the
 *      httpOnly cookie we set in /api/fortnox-sie/auth.
 *   2. Caller is a signed-in admin (matches the RLS policy on
 *      `sie_connections`).
 *   3. Token exchange against Fortnox succeeds.
 *
 * On success, upserts a row into `sie_connections` keyed by customer_id
 * with the new tokens, tenant id, scope, and status='active'.
 */

const STATE_COOKIE_NAME = "sie_oauth_state";

// Fortnox SIE refresh tokens last roughly 45 days. The token endpoint
// doesn't echo this back, so we encode the known-good lifetime here as a
// best-effort hint for the UI ("expires in N days").
const REFRESH_TOKEN_LIFETIME_DAYS = 45;

function redirectBack(
  request: NextRequest,
  params: Record<string, string>,
): NextResponse {
  const url = new URL("/settings/sie", request.url);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const response = NextResponse.redirect(url);
  // Always clear the one-shot CSRF cookie, regardless of outcome.
  response.cookies.delete(STATE_COOKIE_NAME);
  return response;
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const code = searchParams.get("code");
  const stateParam = searchParams.get("state");
  const fortnoxError = searchParams.get("error");
  const fortnoxErrorDescription = searchParams.get("error_description");

  // -------------------------------------------------------------------------
  // 0. Fortnox surfaced an error directly (user denied, app misconfigured…).
  // -------------------------------------------------------------------------
  if (fortnoxError) {
    const message = fortnoxErrorDescription ?? fortnoxError;
    console.error("[SIE OAuth] Fortnox returned error:", message);
    return redirectBack(request, {
      error: "oauth_denied",
      message: message.slice(0, 200),
    });
  }

  if (!code || !stateParam) {
    return redirectBack(request, { error: "missing_code_or_state" });
  }

  // -------------------------------------------------------------------------
  // 1. Decode state and verify CSRF nonce.
  // -------------------------------------------------------------------------
  let customerId: string | null = null;
  let stateNonce: string | null = null;
  try {
    const decoded = JSON.parse(
      Buffer.from(stateParam, "base64url").toString("utf8"),
    ) as { customer_id?: string; nonce?: string };
    customerId = decoded.customer_id ?? null;
    stateNonce = decoded.nonce ?? null;
  } catch {
    return redirectBack(request, { error: "invalid_state" });
  }

  const cookieNonce = request.cookies.get(STATE_COOKIE_NAME)?.value ?? null;
  if (
    !customerId ||
    !stateNonce ||
    !cookieNonce ||
    stateNonce !== cookieNonce
  ) {
    return redirectBack(request, { error: "csrf_mismatch" });
  }

  // -------------------------------------------------------------------------
  // 2. AuthN — must still be a signed-in admin when the callback hits us
  //    (the user could have signed out mid-flow, or another tab could be
  //     trying to replay the callback).
  // -------------------------------------------------------------------------
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return redirectBack(request, { error: "unauthorized" });
  }

  const { data: profileData } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  const profile = profileData as { role?: string | null } | null;
  if (profile?.role !== "admin") {
    return redirectBack(request, { error: "forbidden" });
  }

  // -------------------------------------------------------------------------
  // 3. Re-derive the redirect URI (must be byte-for-byte identical to the
  //    one used in /api/fortnox-sie/auth, or Fortnox rejects the exchange).
  // -------------------------------------------------------------------------
  const redirectUri = new URL(
    "/api/fortnox-sie/callback",
    request.url,
  ).toString();

  // -------------------------------------------------------------------------
  // 4. Exchange the code for tokens.
  // -------------------------------------------------------------------------
  let tokens;
  try {
    tokens = await exchangeSieCodeForTokens({ code, redirectUri });
  } catch (error) {
    console.error("[SIE OAuth] Token exchange failed:", error);
    return redirectBack(request, { error: "token_exchange_failed" });
  }

  const tenantId = extractTenantIdFromJwt(tokens.access_token);
  const now = new Date();
  const accessExpiresAt = new Date(
    now.getTime() + (tokens.expires_in ?? 3600) * 1000,
  ).toISOString();
  const refreshExpiresAt = new Date(
    now.getTime() + REFRESH_TOKEN_LIFETIME_DAYS * 24 * 3600 * 1000,
  ).toISOString();

  // -------------------------------------------------------------------------
  // 5. Persist via the admin client. RLS on sie_connections is admin-only,
  //    and the admin client bypasses RLS anyway — we've already verified
  //    the caller is admin above, so this is safe.
  // -------------------------------------------------------------------------
  const adminClient = createAdminClient();
  const { error: upsertError } = await adminClient
    .from("sie_connections")
    .upsert(
      {
        customer_id: customerId,
        fortnox_tenant_id: tenantId,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        access_token_expires_at: accessExpiresAt,
        refresh_token_expires_at: refreshExpiresAt,
        scope: tokens.scope ?? null,
        connection_status: "active",
        last_error: null,
        connected_at: now.toISOString(),
        connected_by: user.id,
      } as never,
      { onConflict: "customer_id" } as never,
    );

  if (upsertError) {
    console.error("[SIE OAuth] DB upsert failed:", upsertError);
    return redirectBack(request, { error: "persist_failed" });
  }

  return redirectBack(request, {
    success: "true",
    customer_id: customerId,
  });
}
