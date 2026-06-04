import { createAdminClient } from "@/lib/supabase/admin";
import {
  KPI_DEFINITIONS,
  KPI_DEFINITIONS_BY_KEY,
  FLOW_KPI_KEYS,
} from "@/lib/fortnox-sie/kpi-definitions";

import type { ToolHandler } from "./types";

/**
 * Per-customer SIE-derived financial KPIs (the "Nyckeltal" numbers).
 *
 * Reads the precomputed `sie_kpis` table — the SAME source the /key-metrics
 * (Nyckeltal) page renders — so the figures reconcile with the UI exactly.
 * KPI metadata (display names, units, targets) comes from the canonical
 * `KPI_DEFINITIONS` registry, not a second hard-coded list, so chat answers
 * can't drift from the page.
 *
 * Scope: SIE data exists only for customers with a synced + KPI-generated
 * general ledger. When a customer has no YEAR rows we say so plainly rather
 * than implying the numbers are zero.
 *
 * Access: SIE financial data is firm-wide internal info (not per-user
 * restricted), so this reads through the admin client — same pattern as
 * search_documents. The asking user's customer scope does NOT limit results.
 *
 * This is a DIFFERENT revenue source from the invoice-based CRM KPIs
 * (get_kpi_summary / get_top_customers). See the SIE section in the system
 * prompt for the disambiguation the model must respect.
 */

export type GetSieKpisInput = {
  customer_id: string;
  /** Calendar year of the financial year (e.g. 2026). Defaults to current. */
  year?: number | null;
  /** Include the monthly trend for flow KPIs (revenue, margin, EBIT). */
  include_monthly?: boolean;
};

type SieKpiRow = {
  kpi_key: string;
  period: string;
  value: number | string | null;
  unit: string | null;
  flagged: boolean;
};

function toNumber(value: number | string | null): number | null {
  if (value == null) return null;
  const n = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(n) ? n : null;
}

export const getSieKpis: ToolHandler<GetSieKpisInput> = async (input) => {
  const supabase = createAdminClient();
  const customerId = input.customer_id?.trim();
  if (!customerId) {
    return {
      error:
        "`customer_id` is required. Call resolve_customer first to get the UUID.",
    };
  }

  const year =
    input.year != null ? Math.trunc(Number(input.year)) : new Date().getFullYear();
  if (!Number.isInteger(year) || year < 2000 || year > 3000) {
    return { error: "`year` must be a sensible integer (e.g. 2026)." };
  }
  const financialYearFrom = `${year}-01-01`;

  // ---------------------------------------------------------------------------
  // YEAR snapshot — one row per KPI for the full financial year.
  // ---------------------------------------------------------------------------
  const yearRes = await supabase
    .from("sie_kpis")
    .select("kpi_key, period, value, unit, flagged")
    .eq("customer_id", customerId)
    .eq("financial_year_from", financialYearFrom)
    .eq("period", "YEAR");

  if (yearRes.error) {
    return { error: yearRes.error.message };
  }

  // Best-effort customer name (the model usually already has it from
  // resolve_customer, but echoing it keeps the answer self-contained).
  let customerName: string | null = null;
  let fortnoxCustomerNumber: string | null = null;
  const nameRes = await supabase
    .from("customers")
    .select("name, fortnox_customer_number")
    .eq("id", customerId)
    .maybeSingle();
  if (!nameRes.error && nameRes.data) {
    const row = nameRes.data as unknown as {
      name: string | null;
      fortnox_customer_number: string | null;
    };
    customerName = row.name ?? null;
    fortnoxCustomerNumber = row.fortnox_customer_number ?? null;
  }

  const yearRows = (yearRes.data ?? []) as unknown as SieKpiRow[];
  const byKey = new Map<string, SieKpiRow>();
  for (const row of yearRows) byKey.set(row.kpi_key, row);

  if (yearRows.length === 0) {
    return {
      customer_id: customerId,
      customer_name: customerName,
      year,
      has_data: false,
      kpis: [],
      note:
        `No SIE-derived KPIs for ${customerName ?? "this customer"} in ${year}. ` +
        "The customer may not have a synced SIE file for that year, or KPIs " +
        "haven't been generated yet. This is NOT the same as the numbers being " +
        "zero. Invoice-based turnover is still available via get_kpi_summary.",
    };
  }

  // Present KPIs in the canonical registry order so the assistant lists them
  // the same way the Nyckeltal page does.
  const kpis = KPI_DEFINITIONS.map((def) => {
    const row = byKey.get(def.key);
    return {
      key: def.key,
      name_sv: def.names.sv,
      name_en: def.names.en,
      value: row ? toNumber(row.value) : null,
      unit: def.unit,
      decimals: def.decimals,
      flagged: row?.flagged ?? false,
      target: def.target ?? null,
    };
  });

  // ---------------------------------------------------------------------------
  // Optional monthly trend for flow KPIs (revenue / margin / EBIT). Stock
  // KPIs (kassalikviditet, soliditet) are point-in-time and don't get a
  // meaningful monthly series, so we only pull the flow keys.
  // ---------------------------------------------------------------------------
  let monthly:
    | Record<string, Array<{ period: string; value: number | null }>>
    | undefined;

  if (input.include_monthly) {
    const monthlyRes = await supabase
      .from("sie_kpis")
      .select("kpi_key, period, value")
      .eq("customer_id", customerId)
      .eq("financial_year_from", financialYearFrom)
      .neq("period", "YEAR")
      .in("kpi_key", FLOW_KPI_KEYS)
      .order("period", { ascending: true });

    if (!monthlyRes.error) {
      const series: Record<
        string,
        Array<{ period: string; value: number | null }>
      > = {};
      for (const raw of (monthlyRes.data ?? []) as unknown as SieKpiRow[]) {
        (series[raw.kpi_key] ??= []).push({
          period: raw.period,
          value: toNumber(raw.value),
        });
      }
      monthly = series;
    }
  }

  const flaggedKeys = kpis.filter((k) => k.flagged).map((k) => k.key);

  return {
    customer_id: customerId,
    customer_name: customerName,
    fortnox_customer_number: fortnoxCustomerNumber,
    year,
    has_data: true,
    kpis,
    flagged_kpis: flaggedKeys,
    ...(monthly ? { monthly } : {}),
    source:
      "sie_kpis (precomputed from the customer's synced SIE general ledger; " +
      "matches the Nyckeltal / key-metrics page). These are ledger-derived " +
      "financial KPIs — distinct from invoice-based turnover in get_kpi_summary.",
  };
};

// Re-export for the registry's enum derivation + any future callers.
export { KPI_DEFINITIONS_BY_KEY };
