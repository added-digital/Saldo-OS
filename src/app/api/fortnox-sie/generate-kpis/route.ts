import { NextRequest, NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { evaluateKpisForCustomer } from "@/lib/fortnox-sie/kpi-engine";

export const runtime = "nodejs";
// Generous timeout: ~50 customers × ~5 KPIs × per-month rows can add up,
// but the engine is pure memory work after two DB round-trips per customer,
// so 3 minutes is plenty of headroom even with the polite inter-customer
// delay below.
export const maxDuration = 300;

// Tiny breather between customers. Not strictly required (we're not hitting
// Fortnox) but it keeps the Supabase write load tame on shared-CPU plans.
const INTER_CUSTOMER_DELAY_MS = 50;

/**
 * Admin POST endpoint that recomputes sie_kpis for every successfully
 * imported (customer, financial_year_from) pair.
 *
 * Iterates sie_imports (status='success'), runs the KPI engine for each
 * row, and upserts the results into sie_kpis. The current-year YEAR-period
 * rows are what powers the Nyckeltal overview page; the monthly rows feed
 * the detail-page trend charts.
 *
 * Query params:
 *   ?customer_id=<uuid>   — limit to a single customer (otherwise: all)
 *   ?year=YYYY            — limit to a single year (otherwise: all years
 *                           the customer has imported)
 *
 * Returns a per-customer breakdown so the UI can render a toast.
 */

interface SieImportRow {
  customer_id: string;
  financial_year_from: string;
}

interface PerCustomerResult {
  customer_id: string;
  financial_year_from: string;
  status: "success" | "error";
  kpis_written: number;
  months_covered: number;
  error_message: string | null;
}

export async function POST(request: NextRequest) {
  // -------------------------------------------------------------------------
  // 1. Admin gate. Match the rest of the SIE pipeline — only admins can
  //    trigger a recompute, since the underlying data is restricted.
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
  // 2. Parse optional filters.
  // -------------------------------------------------------------------------
  const customerIdFilter = request.nextUrl.searchParams.get("customer_id");
  const yearRaw = request.nextUrl.searchParams.get("year");
  let yearFilterFrom: string | null = null;
  if (yearRaw) {
    const parsed = Number(yearRaw);
    if (!Number.isInteger(parsed) || parsed < 2000 || parsed > 3000) {
      return NextResponse.json(
        { ok: false, error: "bad_request", message: "invalid year" },
        { status: 400 },
      );
    }
    yearFilterFrom = `${parsed}-01-01`;
  }

  // -------------------------------------------------------------------------
  // 3. Load the list of (customer, year) pairs to recompute.
  // -------------------------------------------------------------------------
  const admin = createAdminClient();
  let query = admin
    .from("sie_imports")
    .select("customer_id, financial_year_from")
    .eq("import_status", "success");

  if (customerIdFilter) query = query.eq("customer_id", customerIdFilter);
  if (yearFilterFrom) query = query.eq("financial_year_from", yearFilterFrom);

  const { data: importsData, error: loadError } = await query;
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
  const imports = (importsData ?? []) as SieImportRow[];

  // -------------------------------------------------------------------------
  // 4. Loop. Sequential — the engine itself is fast, but writing per
  //    customer in parallel would saturate the Supabase pool for no real
  //    speed-up.
  // -------------------------------------------------------------------------
  const started = Date.now();
  const results: PerCustomerResult[] = [];
  let successCount = 0;
  let failureCount = 0;

  for (let i = 0; i < imports.length; i += 1) {
    const row = imports[i];
    try {
      const evaluation = await evaluateKpisForCustomer({
        customerId: row.customer_id,
        financialYearFrom: row.financial_year_from,
        admin,
      });

      // Delete-then-insert scoped to (customer, year). Same pattern as the
      // sync orchestrator uses for balances / vouchers — guarantees the
      // table mirrors the latest evaluation without stranded rows from a
      // KPI definition we've since removed.
      const { error: delErr } = await admin
        .from("sie_kpis")
        .delete()
        .eq("customer_id", row.customer_id)
        .eq("financial_year_from", row.financial_year_from);
      if (delErr) {
        throw new Error(`delete sie_kpis: ${delErr.message}`);
      }

      const rowsToInsert = evaluation.kpis.map((k) => ({
        customer_id: row.customer_id,
        financial_year_from: row.financial_year_from,
        period: k.period,
        kpi_key: k.kpiKey,
        value: k.value,
        unit: k.unit,
        flagged: k.flagged,
        target: k.target,
        inputs: k.inputs,
        computed_at: new Date().toISOString(),
      }));

      if (rowsToInsert.length > 0) {
        // Chunked insert to stay within Supabase's request-size budget.
        for (let off = 0; off < rowsToInsert.length; off += 1000) {
          const chunk = rowsToInsert.slice(off, off + 1000);
          const { error: insErr } = await admin
            .from("sie_kpis")
            .insert(chunk as never);
          if (insErr) {
            throw new Error(`insert sie_kpis: ${insErr.message}`);
          }
        }
      }

      results.push({
        customer_id: row.customer_id,
        financial_year_from: row.financial_year_from,
        status: "success",
        kpis_written: rowsToInsert.length,
        months_covered: evaluation.monthsCovered.length,
        error_message: null,
      });
      successCount += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error.";
      console.error(
        `[/api/fortnox-sie/generate-kpis] customer ${row.customer_id} year ${row.financial_year_from} threw:`,
        err,
      );
      results.push({
        customer_id: row.customer_id,
        financial_year_from: row.financial_year_from,
        status: "error",
        kpis_written: 0,
        months_covered: 0,
        error_message: message,
      });
      failureCount += 1;
    }

    if (i < imports.length - 1) {
      await new Promise((r) => setTimeout(r, INTER_CUSTOMER_DELAY_MS));
    }
  }

  return NextResponse.json({
    ok: true,
    summary: {
      total: imports.length,
      success: successCount,
      failure: failureCount,
      duration_ms: Date.now() - started,
    },
    results,
  });
}
