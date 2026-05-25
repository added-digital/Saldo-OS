import { NextRequest, NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { getSieAuthorizationUrl } from "@/lib/fortnox-sie/auth";

export const runtime = "nodejs";

/**
 * Initiates the per-customer SIE OAuth flow.
 *
 * Triggered by the "Connect" button on /settings/sie. The button navigates
 * the browser to /api/fortnox-sie/auth?customer_id=<uuid>; this route then
 * redirects the user to Fortnox's authorize URL.
 *
 * The `state` parameter sent to Fortnox encodes the customer_id AND a CSRF
 * nonce. The nonce is also written to an httpOnly cookie. When Fortnox
 * redirects back to /api/fortnox-sie/callback, that route compares the
 * nonce in `state` against the cookie — if they don't match, the request
 * is rejected (CSRF protection).
 *
 * Admin-only, matching the RLS policy on `sie_connections` (admin_rw).
 */

const STATE_COOKIE_NAME = "sie_oauth_state";
const STATE_COOKIE_MAX_AGE = 60 * 10; // 10 minutes — plenty of time to complete OAuth

function redirectError(request: NextRequest, error: string): NextResponse {
  const url = new URL("/settings/sie", request.url);
  url.searchParams.set("error", error);
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest) {
  // -------------------------------------------------------------------------
  // 1. AuthN — must be a signed-in admin.
  // -------------------------------------------------------------------------
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(new URL("/auth/login", request.url));
  }

  const { data: profileData } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  const profile = profileData as { role?: string | null } | null;
  if (profile?.role !== "admin") {
    return redirectError(request, "forbidden");
  }

  // -------------------------------------------------------------------------
  // 2. Validate the customer parameter.
  // -------------------------------------------------------------------------
  const customerId = request.nextUrl.searchParams.get("customer_id");
  if (!customerId) {
    return redirectError(request, "missing_customer");
  }

  const { data: customer } = await supabase
    .from("customers")
    .select("id")
    .eq("id", customerId)
    .maybeSingle();
  if (!customer) {
    return redirectError(request, "unknown_customer");
  }

  // -------------------------------------------------------------------------
  // 3. Build the OAuth state (customer_id + CSRF nonce) and the authorize URL.
  // -------------------------------------------------------------------------
  // crypto.randomUUID() is available in the Node 18+ runtime Next 16 uses.
  const nonce = crypto.randomUUID();
  const state = Buffer.from(
    JSON.stringify({ customer_id: customerId, nonce }),
    "utf8",
  ).toString("base64url");

  // Derive the redirect URI from the request origin so we automatically
  // match whichever environment we're running in (prod, staging, …). The
  // EXACT URLs need to be pre-registered with the Fortnox SIE app, or
  // Fortnox will reject the authorize request.
  const redirectUri = new URL(
    "/api/fortnox-sie/callback",
    request.url,
  ).toString();

  let authorizationUrl: string;
  try {
    authorizationUrl = getSieAuthorizationUrl({ redirectUri, state });
  } catch (error) {
    console.error("[SIE OAuth] Failed to build authorize URL:", error);
    return redirectError(request, "config_missing");
  }

  // -------------------------------------------------------------------------
  // 4. Redirect to Fortnox, leaving the nonce in an httpOnly cookie so the
  //    callback can verify it on return.
  // -------------------------------------------------------------------------
  const response = NextResponse.redirect(authorizationUrl);
  response.cookies.set({
    name: STATE_COOKIE_NAME,
    value: nonce,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: STATE_COOKIE_MAX_AGE,
    path: "/",
  });
  return response;
}
