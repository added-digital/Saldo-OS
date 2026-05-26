import { NextRequest, NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import {
  fetchSieFile,
  getValidSieAccessToken,
  type SieType,
} from "@/lib/fortnox-sie/client";
import { parseSieFile } from "@/lib/fortnox-sie/parser";

export const runtime = "nodejs";
// Long-ish so a slow Fortnox response (SIE files can be large) doesn't
// kill the request before we can see what we got back.
export const maxDuration = 60;

/**
 * One-shot debug endpoint for the SIE fetch path.
 *
 * Admin-gated (matches the RLS policy on sie_connections). Returns a JSON
 * blob describing what Fortnox sent back: status, headers, byte length,
 * encoding hint, and a sample of the first ~2000 chars of the file. The
 * sample is decoded as latin1 so it's readable regardless of the file's
 * actual encoding (CP437/PC8 or ISO-8859-1).
 *
 * Usage:
 *   GET /api/fortnox-sie/debug?customer_id=<uuid>
 *   GET /api/fortnox-sie/debug?customer_id=<uuid>&type=4&year=2026
 *   GET /api/fortnox-sie/debug?customer_id=<uuid>&type=4&financialyear=42
 *   GET /api/fortnox-sie/debug?customer_id=<uuid>&full=1   ← returns ALL bytes
 *
 * If `full=1` is set, the response includes the full SIE text instead of
 * just a 2000-char sample. Use sparingly — large files in a JSON response
 * are awkward to read in a browser.
 */

const DEFAULT_TYPE: SieType = 4;
const SAMPLE_LIMIT_CHARS = 2000;

function badRequest(message: string): NextResponse {
  return NextResponse.json(
    { ok: false, error: "bad_request", message },
    { status: 400 },
  );
}

/**
 * Parse the `type` query param. Returns the SieType on success, or an
 * error message string on failure (suitable to pass straight to badRequest).
 */
function parseTypeArg(raw: string | null): SieType | string {
  if (raw == null) return DEFAULT_TYPE;
  const parsed = Number(raw);
  if (parsed !== 1 && parsed !== 2 && parsed !== 3 && parsed !== 4) {
    return "type must be 1, 2, 3 or 4";
  }
  return parsed as SieType;
}

/**
 * Parse `year` and `financialyear` query params (mutually exclusive). Returns
 * the resolved period inputs for fetchSieFile, or an error message on bad
 * input.
 */
function parsePeriodArgs(
  yearRaw: string | null,
  financialYearRaw: string | null,
): { year?: number; financialYearId?: number } | string {
  if (financialYearRaw != null) {
    const parsed = Number(financialYearRaw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return "financialyear must be a positive integer";
    }
    return { financialYearId: parsed };
  }
  if (yearRaw != null) {
    const parsed = Number(yearRaw);
    if (!Number.isInteger(parsed) || parsed < 2000 || parsed > 3000) {
      return "year must be a 4-digit calendar year";
    }
    return { year: parsed };
  }
  // Neither — let fetchSieFile default to current year.
  return {};
}

export async function GET(request: NextRequest) {
  // -------------------------------------------------------------------------
  // 1. Admin gate.
  // -------------------------------------------------------------------------
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

  // -------------------------------------------------------------------------
  // 2. Parse query params.
  // -------------------------------------------------------------------------
  const sp = request.nextUrl.searchParams;
  const customerId = sp.get("customer_id");
  if (!customerId) {
    return badRequest("customer_id is required");
  }

  // -------------------------------------------------------------------------
  // Mode switch — `?mode=whoami` short-circuits the SIE fetch and instead
  // calls /3/companyinformation against this connection's tokens. Useful
  // for confirming which Fortnox tenant the OAuth actually authorised
  // (e.g. when the customer in CRM and the Fortnox account being read
  // don't appear to match).
  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // Mode switch — `?mode=financialyears` lists every financial year on the
  // connection's tenant (no date filter). Uses the `bookkeeping` scope we
  // already have, so it works even without `companyinformation`. Useful to
  // distinguish "no year matching this calendar year" from "tenant has no
  // bookkeeping data at all".
  // -------------------------------------------------------------------------
  if (sp.get("mode") === "financialyears") {
    try {
      const { accessToken, tenantId } = await getValidSieAccessToken(customerId);
      const response = await fetch(
        "https://api.fortnox.se/3/financialyears",
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/json",
            ...(tenantId ? { TenantId: tenantId } : {}),
          },
        },
      );
      const body = (await response.json().catch(() => null)) as unknown;
      return NextResponse.json({
        ok: response.ok,
        customer_id: customerId,
        stored_tenant_id: tenantId,
        fortnox_status: response.status,
        fortnox_response: body,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error.";
      console.error("[SIE debug financialyears] failed:", error);
      return NextResponse.json(
        { ok: false, error: "financialyears_failed", message },
        { status: 500 },
      );
    }
  }

  if (sp.get("mode") === "whoami") {
    try {
      const { accessToken, tenantId } = await getValidSieAccessToken(customerId);
      const response = await fetch(
        "https://api.fortnox.se/3/companyinformation",
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/json",
            ...(tenantId ? { TenantId: tenantId } : {}),
          },
        },
      );
      const body = (await response.json().catch(() => null)) as unknown;
      return NextResponse.json({
        ok: response.ok,
        customer_id: customerId,
        stored_tenant_id: tenantId,
        fortnox_status: response.status,
        fortnox_response: body,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error.";
      console.error("[SIE debug whoami] failed:", error);
      return NextResponse.json(
        { ok: false, error: "whoami_failed", message },
        { status: 500 },
      );
    }
  }

  // -------------------------------------------------------------------------
  // Mode switch — `?mode=parse` fetches AND parses the SIE file, returning
  // a JSON summary of what we got. Use this to verify the parser handles a
  // real-world file without flooding the browser with the raw SIE text.
  // Accepts the same `type` / `year` / `financialyear` params as the default
  // mode. Pass `?vouchers=N` to include the first N vouchers in full.
  // -------------------------------------------------------------------------
  if (sp.get("mode") === "parse") {
    try {
      const typeArg = parseTypeArg(sp.get("type"));
      if (typeof typeArg === "string") return badRequest(typeArg);
      const periodArg = parsePeriodArgs(
        sp.get("year"),
        sp.get("financialyear"),
      );
      if (typeof periodArg === "string") return badRequest(periodArg);

      const fetched = await fetchSieFile({
        customerId,
        type: typeArg,
        year: periodArg.year,
        financialYearId: periodArg.financialYearId,
      });

      const parsed = parseSieFile(fetched.buffer);

      const vouchersInclude = (() => {
        const raw = sp.get("vouchers");
        if (raw == null) return 0;
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 0 || n > 200) return 0;
        return n;
      })();

      const transactionCount = parsed.vouchers.reduce(
        (acc, v) => acc + v.transactions.length,
        0,
      );

      return NextResponse.json({
        ok: true,
        fortnox: {
          url: fetched.url,
          status: fetched.status,
          byte_length: fetched.byteLength,
          resolved_financial_year_id: fetched.financialYearId,
        },
        parsed: {
          meta: parsed.meta,
          counts: {
            accounts: parsed.accounts.length,
            dimensions: parsed.dimensions.length,
            objects: parsed.objects.length,
            account_balances: parsed.accountBalances.length,
            object_balances: parsed.objectBalances.length,
            period_balances: parsed.periodBalances.length,
            vouchers: parsed.vouchers.length,
            transactions: transactionCount,
            warnings: parsed.warnings.length,
          },
          first_5_accounts: parsed.accounts.slice(0, 5),
          first_5_warnings: parsed.warnings.slice(0, 5),
          vouchers_sample: vouchersInclude > 0
            ? parsed.vouchers.slice(0, vouchersInclude)
            : undefined,
        },
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error.";
      console.error("[SIE debug parse] failed:", error);
      return NextResponse.json(
        { ok: false, error: "parse_failed", message },
        { status: 500 },
      );
    }
  }

  const typeArg = parseTypeArg(sp.get("type"));
  if (typeof typeArg === "string") return badRequest(typeArg);
  const type: SieType = typeArg;

  const periodArg = parsePeriodArgs(sp.get("year"), sp.get("financialyear"));
  if (typeof periodArg === "string") return badRequest(periodArg);
  const { year, financialYearId } = periodArg;

  const full = sp.get("full") === "1";

  // -------------------------------------------------------------------------
  // 3. Fetch and report.
  // -------------------------------------------------------------------------
  try {
    const result = await fetchSieFile({
      customerId,
      type,
      year,
      financialYearId,
    });

    // Heuristic encoding hint from the SIE #FORMAT line, if present.
    // PC8 → CP437 (legacy DOS). Anything else, we mention what we saw.
    const formatMatch = result.text.match(/^#FORMAT\s+(\S+)/m);
    const encodingHint = formatMatch
      ? `SIE #FORMAT = ${formatMatch[1]} (text returned decoded as latin1)`
      : "no #FORMAT header found (text returned decoded as latin1)";

    return NextResponse.json({
      ok: true,
      request: {
        customer_id: customerId,
        type,
        year: year ?? null,
        financial_year_id: financialYearId ?? null,
      },
      fortnox: {
        url: result.url,
        status: result.status,
        headers: result.headers,
        byte_length: result.byteLength,
        encoding_hint: encodingHint,
        resolved_financial_year_id: result.financialYearId,
        sample: full
          ? result.text
          : result.text.slice(0, SAMPLE_LIMIT_CHARS) +
            (result.text.length > SAMPLE_LIMIT_CHARS
              ? `\n…[truncated, ${result.text.length - SAMPLE_LIMIT_CHARS} more chars, pass full=1 to see all]`
              : ""),
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown error.";
    console.error("[SIE debug] fetch failed:", error);
    return NextResponse.json(
      { ok: false, error: "fetch_failed", message },
      { status: 500 },
    );
  }
}
