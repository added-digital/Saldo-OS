import { NextRequest, NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { syncSieForCustomer } from "@/lib/fortnox-sie/sync";

export const runtime = "nodejs";
// 5 minutes — covers ~30 customers at typical 8s/customer. Generous so a
// full firm-wide manual trigger doesn't get killed mid-loop. Vercel Pro
// supports up to 300s; bump higher if you're on a plan that allows it.
export const maxDuration = 300;

// Pause briefly between customers to be polite to Fortnox's rate limiter.
// Mirrors the 350ms delay used by the firm-wide sync in src/lib/fortnox/sync.ts.
const INTER_CUSTOMER_DELAY_MS = 350;

interface PerCustomerResult {
  customer_id: string;
  status: string;
  error_message: string | null;
  counts?: {
    accounts: number;
    vouchers: number;
    transactions: number;
    warnings: number;
  };
}

/**
 * Admin-only batch-sync endpoint.
 *
 * Loops `syncSieForCustomer()` over every `sie_connections` row with
 * `connection_status='active'`. Triggered manually from the "Sync all" button
 * on /settings/sync, and reusable by the future nightly cron.
 *
 * Returns a per-customer breakdown and a top-line summary so the UI can show
 * "Synced N/M customers (K failed)" in a toast.
 */
/**
 * Returns true if the request carries a valid CRON_SECRET bearer token.
 *
 * The nightly chain calls this endpoint via the sync-sie Edge Function, which
 * authenticates with the same CRON_SECRET used by `/api/sync/nightly`. Admin
 * cookies aren't available in that context, so this is the only safe escape
 * hatch from the admin gate below. If CRON_SECRET is unset we treat all such
 * calls as unauthorized to avoid accidentally opening the endpoint in prod.
 */
function isCronCall(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  const authHeader = request.headers.get("authorization");
  // TEMPORARY DEBUG — remove once cron auth is confirmed working.
  // Logs only lengths and a 4-char prefix so the secret itself never appears
  // in logs. If you see CRON_SECRET length 0, the env var isn't reaching the
  // runtime. If both prefixes match but lengths differ, there's a whitespace
  // or quoting issue.
  console.log(
    `[sync-all cron check] CRON_SECRET length=${secret?.length ?? 0} prefix=${(secret ?? "").slice(0, 4)} | auth header present=${Boolean(authHeader)} prefix=${(authHeader ?? "").slice(0, 11)}`,
  );
  if (!secret) return false;
  return authHeader === `Bearer ${secret}`;
}

export async function POST(request: NextRequest) {
  // -------------------------------------------------------------------------
  // 1. Admin gate. Cron callers (nightly chain → sync-sie Edge Function)
  //    bypass cookie auth via CRON_SECRET; everyone else needs an admin
  //    profile in Supabase.
  // -------------------------------------------------------------------------
  if (!isCronCall(request)) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "unauthorized" },
        { status: 401 },
      );
    }
    const { data: profileData } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();
    const profile = profileData as { role?: string | null } | null;
    if (profile?.role !== "admin") {
      return NextResponse.json(
        { ok: false, error: "forbidden" },
        { status: 403 },
      );
    }
  }

  // -------------------------------------------------------------------------
  // 2. Load every active connection.
  // -------------------------------------------------------------------------
  const admin = createAdminClient();
  const { data: connectionsData, error: loadError } = await admin
    .from("sie_connections")
    .select("customer_id")
    .eq("connection_status", "active");
  if (loadError) {
    return NextResponse.json(
      {
        ok: false,
        error: "load_failed",
        message: loadError.message,
      },
      { status: 500 },
    );
  }
  const connections = (connectionsData ?? []) as Array<{
    customer_id: string;
  }>;

  // Optional `?year=YYYY` override — defaults to current calendar year inside
  // syncSieForCustomer when omitted.
  let year: number | undefined;
  const yearRaw = request.nextUrl.searchParams.get("year");
  if (yearRaw) {
    const parsed = Number(yearRaw);
    if (!Number.isInteger(parsed) || parsed < 2000 || parsed > 3000) {
      return NextResponse.json(
        { ok: false, error: "bad_request", message: "invalid year" },
        { status: 400 },
      );
    }
    year = parsed;
  }

  // -------------------------------------------------------------------------
  // 3. Loop sequentially. Sequential — not parallel — to stay polite with
  //    Fortnox; if you need speed at scale, swap in p-limit with concurrency
  //    of 3-5 later, but verify rate-limit headroom first.
  // -------------------------------------------------------------------------
  const started = Date.now();
  const results: PerCustomerResult[] = [];
  let successCount = 0;
  let failureCount = 0;

  for (let i = 0; i < connections.length; i += 1) {
    const conn = connections[i];
    try {
      const result = await syncSieForCustomer({
        customerId: conn.customer_id,
        year,
        admin,
      });
      results.push({
        customer_id: conn.customer_id,
        status: result.status,
        error_message: result.errorMessage,
        counts: {
          accounts: result.counts.accounts,
          vouchers: result.counts.vouchers,
          transactions: result.counts.transactions,
          warnings: result.counts.warnings,
        },
      });
      if (result.status === "success") successCount += 1;
      else failureCount += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error.";
      console.error(
        `[/api/fortnox-sie/sync-all] customer ${conn.customer_id} threw:`,
        err,
      );
      results.push({
        customer_id: conn.customer_id,
        status: "error",
        error_message: message,
      });
      failureCount += 1;
    }

    // Polite delay between customers — skip after the last one.
    if (i < connections.length - 1) {
      await new Promise((r) => setTimeout(r, INTER_CUSTOMER_DELAY_MS));
    }
  }

  return NextResponse.json({
    ok: true,
    summary: {
      total: connections.length,
      success: successCount,
      failure: failureCount,
      duration_ms: Date.now() - started,
    },
    results,
  });
}
