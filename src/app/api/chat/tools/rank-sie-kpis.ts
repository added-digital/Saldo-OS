import { createAdminClient } from "@/lib/supabase/admin";
import {
  KPI_DEFINITIONS_BY_KEY,
} from "@/lib/fortnox-sie/kpi-definitions";

import type { ToolHandler } from "./types";

/**
 * Cross-customer ranking / thresholding / flag-filtering over ONE SIE
 * financial KPI for a year. The SIE counterpart to get_top_customers, but for
 * ledger-derived KPIs (revenue, gross_margin_pct, ebit, kassalikviditet,
 * soliditet) rather than invoice turnover.
 *
 * Answers questions like:
 *   - "which customers have negative EBIT this year"      (kpi_key=ebit, flagged_only)
 *   - "lowest soliditet"                                  (kpi_key=soliditet, order=asc)
 *   - "companies with kassalikviditet under 100%"         (kpi_key=kassalikviditet, max_value=100)
 *   - "highest revenue from the ledger"                   (kpi_key=revenue, order=desc)
 *
 * Reads `sie_kpis` (period='YEAR') joined to customers, ordered + capped at
 * the database. Reports coverage so the model never implies the ranking spans
 * customers that have no SIE data.
 *
 * Access: SIE financial data is firm-wide internal info, so this reads through
 * the admin client (same pattern as search_documents) — the ranking spans all
 * customers with a synced ledger, not just the asking user's portfolio.
 */

export type RankSieKpisInput = {
  kpi_key: string;
  /** Calendar year of the financial year (e.g. 2026). Defaults to current. */
  year?: number | null;
  /** Sort direction by value. 'desc' (default) = highest first. */
  order?: "asc" | "desc";
  /** Only customers whose value breaches the KPI's target (flagged=true). */
  flagged_only?: boolean;
  /** Lower bound — only values >= this. */
  min_value?: number | null;
  /** Upper bound — only values <= this. */
  max_value?: number | null;
  /** Max rows to return (1-50). Default 10. */
  n?: number | null;
};

type RankRow = {
  customer_id: string;
  value: number | string | null;
  flagged: boolean;
  customers:
    | { id: string; name: string; fortnox_customer_number: string | null }
    | Array<{ id: string; name: string; fortnox_customer_number: string | null }>
    | null;
};

const DEFAULT_N = 10;
const MAX_N = 50;

function toNumber(value: number | string | null): number | null {
  if (value == null) return null;
  const n = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(n) ? n : null;
}

export const rankSieKpis: ToolHandler<RankSieKpisInput> = async (input) => {
  const supabase = createAdminClient();
  const kpiKey = input.kpi_key?.trim();
  const def = kpiKey ? KPI_DEFINITIONS_BY_KEY[kpiKey] : undefined;
  if (!def) {
    return {
      error:
        `Unknown kpi_key '${input.kpi_key}'. Allowed: ` +
        `${Object.keys(KPI_DEFINITIONS_BY_KEY).join(", ")}.`,
    };
  }

  const year =
    input.year != null ? Math.trunc(Number(input.year)) : new Date().getFullYear();
  if (!Number.isInteger(year) || year < 2000 || year > 3000) {
    return { error: "`year` must be a sensible integer (e.g. 2026)." };
  }
  const financialYearFrom = `${year}-01-01`;

  const order: "asc" | "desc" = input.order === "asc" ? "asc" : "desc";
  const n =
    typeof input.n === "number" && Number.isInteger(input.n) && input.n > 0
      ? Math.min(input.n, MAX_N)
      : DEFAULT_N;

  const minValue =
    typeof input.min_value === "number" && Number.isFinite(input.min_value)
      ? input.min_value
      : null;
  const maxValue =
    typeof input.max_value === "number" && Number.isFinite(input.max_value)
      ? input.max_value
      : null;

  // ---------------------------------------------------------------------------
  // Coverage — how many customers have this KPI computed for the year. This is
  // the denominator the model should cite ("12 of 42 customers with SIE data").
  // ---------------------------------------------------------------------------
  const coverageRes = await supabase
    .from("sie_kpis")
    .select("customer_id", { count: "exact", head: true })
    .eq("financial_year_from", financialYearFrom)
    .eq("period", "YEAR")
    .eq("kpi_key", kpiKey);
  const customersWithKpi = coverageRes.error ? null : coverageRes.count ?? null;

  // ---------------------------------------------------------------------------
  // Ranked slice — ordered + capped at the database.
  // ---------------------------------------------------------------------------
  let query = supabase
    .from("sie_kpis")
    .select(
      "customer_id, value, flagged, customers!inner(id, name, fortnox_customer_number)",
      { count: "exact" },
    )
    .eq("financial_year_from", financialYearFrom)
    .eq("period", "YEAR")
    .eq("kpi_key", kpiKey)
    // Exclude un-computable values (null) so the ranking is meaningful.
    .not("value", "is", null);

  if (input.flagged_only) query = query.eq("flagged", true);
  if (minValue != null) query = query.gte("value", minValue);
  if (maxValue != null) query = query.lte("value", maxValue);

  query = query
    .order("value", { ascending: order === "asc", nullsFirst: false })
    .limit(n);

  const { data, error, count } = await query;
  if (error) return { error: error.message };

  const rows = (data ?? []) as unknown as RankRow[];
  const ranked = rows.map((row, index) => {
    const customer = Array.isArray(row.customers)
      ? row.customers[0] ?? null
      : row.customers;
    return {
      rank: index + 1,
      customer_id: row.customer_id,
      customer_name: customer?.name ?? null,
      fortnox_customer_number: customer?.fortnox_customer_number ?? null,
      value: toNumber(row.value),
      flagged: row.flagged,
    };
  });

  // matched_count = rows passing the filters (flagged / thresholds), which may
  // exceed n (the visible slice). customers_with_kpi = the full denominator.
  const matchedCount = count ?? ranked.length;

  return {
    kpi: {
      key: def.key,
      name_sv: def.names.sv,
      name_en: def.names.en,
      unit: def.unit,
      decimals: def.decimals,
      target: def.target ?? null,
    },
    year,
    order,
    filters: {
      flagged_only: Boolean(input.flagged_only),
      min_value: minValue,
      max_value: maxValue,
    },
    n,
    ranked,
    matched_count: matchedCount,
    customers_with_kpi: customersWithKpi,
    ...(matchedCount > ranked.length
      ? {
          _compacted: [
            {
              field: "ranked",
              total_count: matchedCount,
              shown_count: ranked.length,
              note:
                "More customers match — raise `n` (max 50) or tighten the " +
                "thresholds to narrow the list.",
            },
          ],
        }
      : {}),
    source:
      "sie_kpis (precomputed YEAR values from synced SIE ledgers; matches the " +
      "Nyckeltal / key-metrics page and the hit-list rules). Ledger-derived — " +
      "not invoice turnover.",
  };
};
