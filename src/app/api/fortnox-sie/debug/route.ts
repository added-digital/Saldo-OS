import { NextRequest, NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { fetchSieFile, type SieType } from "@/lib/fortnox-sie/client";

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

  const typeRaw = sp.get("type");
  let type: SieType = DEFAULT_TYPE;
  if (typeRaw != null) {
    const parsed = Number(typeRaw);
    if (parsed !== 1 && parsed !== 2 && parsed !== 3 && parsed !== 4) {
      return badRequest("type must be 1, 2, 3 or 4");
    }
    type = parsed as SieType;
  }

  const yearRaw = sp.get("year");
  const financialYearRaw = sp.get("financialyear");
  let year: number | undefined;
  let financialYearId: number | undefined;
  if (financialYearRaw != null) {
    const parsed = Number(financialYearRaw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return badRequest("financialyear must be a positive integer");
    }
    financialYearId = parsed;
  } else if (yearRaw != null) {
    const parsed = Number(yearRaw);
    if (!Number.isInteger(parsed) || parsed < 2000 || parsed > 3000) {
      return badRequest("year must be a 4-digit calendar year");
    }
    year = parsed;
  }
  // If neither was provided, fetchSieFile defaults to the current year.

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
