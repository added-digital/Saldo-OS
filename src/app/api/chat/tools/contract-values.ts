/**
 * Shared helper for fetching annualized contract values per customer.
 *
 * Every tool that surfaces `contract_value` should use this rather than
 * reading from `customer_kpis.contract_value` or the denormalized
 * `customers.contract_value` column — both are populated by the same sync
 * pipeline that's known to misrepresent annualized commitments (see the
 * contract-value bug investigation). This helper reads the source of truth:
 * `contract_accruals`, with on-the-fly annualization matching the
 * dashboard's `/reports` page.
 *
 * Rules:
 *   - Sum over `is_active = true` contracts only.
 *   - Annualize via `annualizeContractTotal(total_ex_vat, period)`:
 *       period '1' → ×12 (monthly)
 *       period '3' → ×4  (quarterly)
 *       else       → ×1  (annual / unknown)
 *   - The returned values are SEK per year.
 *
 * RLS-aware via the caller's supabase client. Customers not in the caller's
 * scope simply won't be returned.
 */

import { annualizeContractTotal, chunkArray } from "@/lib/reports";

import type { SupabaseServerClient } from "./types";

const CHUNK = 200;

type CustomerIdRow = {
  id: string;
  fortnox_customer_number: string | null;
};

type AccrualRow = {
  fortnox_customer_number: string | null;
  total_ex_vat: number | null;
  period: string | null;
};

/**
 * Fetch the annualized contract value for each customer id and return a
 * `Map<customer_id, annualized_value_in_sek_per_year>`. Customers with no
 * active contracts (or no fortnox_customer_number) are absent from the map
 * — callers should treat absence as 0.
 *
 * One round-trip to `customers` (id → fortnox_customer_number) and one
 * round-trip per chunk of fortnox numbers to `contract_accruals`. Worst
 * case for a ~750-customer global rollup: ~5 queries.
 */
export async function fetchAnnualizedContractValuesByCustomerId(
  supabase: SupabaseServerClient,
  customerIds: string[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  const uniqueIds = Array.from(new Set(customerIds.filter(Boolean)));
  if (uniqueIds.length === 0) return result;

  // ---------------------------------------------------------------------------
  // Step 1 — resolve customer_id → fortnox_customer_number.
  // ---------------------------------------------------------------------------
  const fortnoxByCustomerId = new Map<string, string>();
  for (const chunk of chunkArray(uniqueIds, CHUNK)) {
    const { data, error } = await supabase
      .from("customers")
      .select("id, fortnox_customer_number")
      .in("id", chunk);
    if (error) {
      // Best-effort: log and return whatever we already have rather than
      // failing the whole tool call. Tools that depend on this should
      // treat a missing entry as 0.
      console.error(
        "fetchAnnualizedContractValuesByCustomerId: customers lookup failed",
        error,
      );
      return result;
    }
    for (const row of (data ?? []) as unknown as CustomerIdRow[]) {
      if (row.fortnox_customer_number) {
        fortnoxByCustomerId.set(row.id, row.fortnox_customer_number);
      }
    }
  }

  if (fortnoxByCustomerId.size === 0) return result;

  // ---------------------------------------------------------------------------
  // Step 2 — fetch active contract_accruals and sum annualized per fortnox
  // customer number.
  // ---------------------------------------------------------------------------
  const fortnoxNumbers = Array.from(new Set(fortnoxByCustomerId.values()));
  const annualizedByFortnox = new Map<string, number>();
  for (const chunk of chunkArray(fortnoxNumbers, CHUNK)) {
    const { data, error } = await supabase
      .from("contract_accruals")
      .select("fortnox_customer_number, total_ex_vat, period")
      .in("fortnox_customer_number", chunk)
      .eq("is_active", true);
    if (error) {
      console.error(
        "fetchAnnualizedContractValuesByCustomerId: contract_accruals lookup failed",
        error,
      );
      return result;
    }
    for (const row of (data ?? []) as unknown as AccrualRow[]) {
      if (!row.fortnox_customer_number) continue;
      const annualized = annualizeContractTotal(row.total_ex_vat, row.period);
      const prev = annualizedByFortnox.get(row.fortnox_customer_number) ?? 0;
      annualizedByFortnox.set(
        row.fortnox_customer_number,
        prev + annualized,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Step 3 — fold back: customer_id → annualized.
  // ---------------------------------------------------------------------------
  for (const [customerId, fortnoxNumber] of fortnoxByCustomerId) {
    const annualized = annualizedByFortnox.get(fortnoxNumber);
    if (annualized != null && annualized > 0) {
      result.set(customerId, annualized);
    }
  }
  return result;
}
