import { chunkArray } from "@/lib/reports";

import type { ToolHandler } from "./types";

export type GetKpiSummaryInput = {
  year: number;
  month?: number | null;
  /** Single customer scope (kept for compatibility). */
  customer_id?: string | null;
  /** Batch customer scope — pass an array to get a per-customer breakdown. */
  customer_ids?: string[] | null;
  include_inactive?: boolean;
  /**
   * If true, the response includes `by_customer` with one entry per customer
   * in scope. Defaults to true whenever the caller passes a specific
   * customer_id or customer_ids; false otherwise (a global rollup).
   */
  include_per_customer?: boolean;
};

type KpiRow = {
  customer_id: string;
  period_year: number;
  period_month: number;
  total_turnover: number | null;
  invoice_count: number | null;
  total_hours: number | null;
  customer_hours: number | null;
  absence_hours: number | null;
  internal_hours: number | null;
  other_hours: number | null;
  contract_value: number | null;
};

type CustomerNameRow = {
  id: string;
  name: string;
  fortnox_customer_number: string | null;
};

const KPI_COLUMNS =
  "customer_id, period_year, period_month, total_turnover, invoice_count, " +
  "total_hours, customer_hours, absence_hours, internal_hours, other_hours, " +
  "contract_value";

const CUSTOMER_ID_CHUNK = 200;

const ZERO_TOTALS = () => ({
  total_turnover: 0,
  invoice_count: 0,
  total_hours: 0,
  customer_hours: 0,
  absence_hours: 0,
  internal_hours: 0,
  other_hours: 0,
  contract_value: 0,
});

/**
 * Returns aggregated KPI numbers from the precomputed `customer_kpis` rollup
 * — the same source the reports dashboard uses. This is the *correct* tool
 * for "how much did we invoice / how many invoices / total hours" style
 * questions, because the rollup already applies business rules (Licenser
 * exclusion, status filters, etc.) at sync time.
 *
 * Single vs batch:
 *   - No customer_id / customer_ids → global rollup across all in-scope
 *     customers (active by default).
 *   - customer_id (string) → single customer view.
 *   - customer_ids (string[]) → batch view; the response includes
 *     `by_customer` so Claude can answer "give me each customer's numbers"
 *     in one call instead of one tool call per customer.
 */
export const getKpiSummary: ToolHandler<GetKpiSummaryInput> = async (
  input,
  { supabase },
) => {
  const year = Math.trunc(input.year);
  if (!Number.isInteger(year) || year < 2000 || year > 3000) {
    return { error: "`year` must be a sensible integer (e.g. 2026)." };
  }

  const month =
    input.month != null && input.month !== undefined
      ? Math.trunc(Number(input.month))
      : null;

  if (month != null && (month < 1 || month > 12)) {
    return { error: "`month` must be an integer between 1 and 12." };
  }

  const explicitIds = new Set<string>();
  if (input.customer_id) {
    const trimmed = input.customer_id.trim();
    if (trimmed) explicitIds.add(trimmed);
  }
  if (Array.isArray(input.customer_ids)) {
    for (const id of input.customer_ids) {
      if (typeof id !== "string") continue;
      const trimmed = id.trim();
      if (trimmed) explicitIds.add(trimmed);
    }
  }
  const includeInactive = input.include_inactive ?? false;
  const includePerCustomer =
    input.include_per_customer ?? explicitIds.size > 0;

  // -------------------------------------------------------------------------
  // 1. Resolve customer scope
  // -------------------------------------------------------------------------
  let scopedCustomerIds: string[] | null = null;

  if (explicitIds.size > 0) {
    scopedCustomerIds = Array.from(explicitIds);
  } else if (!includeInactive) {
    const { data, error } = await supabase
      .from("customers")
      .select("id")
      .eq("status", "active");
    if (error) {
      return { error: error.message };
    }
    scopedCustomerIds = (
      (data ?? []) as unknown as Array<{ id: string }>
    ).map((row) => row.id);

    // Access-restricted detection: the active-customer query returned zero
    // rows even though we asked for a global rollup. In a real Saldo Redo
    // database that's never legitimately empty — it means RLS gated the
    // SELECT and this account doesn't have the customers scope. Surface
    // explicitly so the model stops looping and tells the user.
    if (scopedCustomerIds.length === 0) {
      return {
        error:
          "Access restricted: this account doesn't have permission to view customer KPI data.",
        error_type: "access_restricted",
      };
    }
  }

  // -------------------------------------------------------------------------
  // 2. Pull KPI rows
  // -------------------------------------------------------------------------
  const allRows: KpiRow[] = [];

  const runKpiQuery = async (idChunk: string[] | null) => {
    let query = supabase
      .from("customer_kpis")
      .select(KPI_COLUMNS)
      .eq("period_type", "month")
      .eq("period_year", year);

    if (month != null) {
      query = query.eq("period_month", month);
    }
    if (idChunk) {
      query = query.in("customer_id", idChunk);
    }

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    allRows.push(...((data ?? []) as unknown as KpiRow[]));
  };

  try {
    if (scopedCustomerIds == null) {
      await runKpiQuery(null);
    } else if (scopedCustomerIds.length === 0) {
      // Nothing in scope — fall through with zeroed totals.
    } else {
      for (const chunk of chunkArray(scopedCustomerIds, CUSTOMER_ID_CHUNK)) {
        await runKpiQuery(chunk);
      }
    }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Failed to load KPIs.",
    };
  }

  // -------------------------------------------------------------------------
  // 3. Customer name lookup (only when per-customer detail is requested)
  // -------------------------------------------------------------------------
  const customerIdsToName = new Set<string>();
  if (includePerCustomer) {
    for (const row of allRows) customerIdsToName.add(row.customer_id);
    for (const id of explicitIds) customerIdsToName.add(id);
  }

  const customerInfo = new Map<
    string,
    { name: string; fortnox_customer_number: string | null }
  >();

  if (customerIdsToName.size > 0) {
    try {
      for (const chunk of chunkArray(
        Array.from(customerIdsToName),
        CUSTOMER_ID_CHUNK,
      )) {
        const { data, error } = await supabase
          .from("customers")
          .select("id, name, fortnox_customer_number")
          .in("id", chunk);
        if (error) throw new Error(error.message);
        const rows = (data ?? []) as unknown as CustomerNameRow[];
        for (const row of rows) {
          customerInfo.set(row.id, {
            name: row.name,
            fortnox_customer_number: row.fortnox_customer_number,
          });
        }
      }
    } catch (error) {
      // Name lookup is best-effort; if it fails we still return KPIs by id.
      console.error("getKpiSummary: customer name lookup failed", error);
    }
  }

  // -------------------------------------------------------------------------
  // 4. Aggregate (global + per-customer)
  // -------------------------------------------------------------------------
  const totals = ZERO_TOTALS();

  type ByMonthRow = {
    period_month: number;
    total_turnover: number;
    invoice_count: number;
    total_hours: number;
    contributing_customers: number;
  };
  const byMonth = new Map<number, ByMonthRow>();

  type CustomerBucket = {
    customer_id: string;
    name: string | null;
    fortnox_customer_number: string | null;
    totals: ReturnType<typeof ZERO_TOTALS>;
    by_month: Map<number, ByMonthRow>;
  };
  const byCustomer = new Map<string, CustomerBucket>();
  const customersContributing = new Set<string>();

  const ensureCustomerBucket = (customerId: string): CustomerBucket => {
    let bucket = byCustomer.get(customerId);
    if (!bucket) {
      const info = customerInfo.get(customerId);
      bucket = {
        customer_id: customerId,
        name: info?.name ?? null,
        fortnox_customer_number: info?.fortnox_customer_number ?? null,
        totals: ZERO_TOTALS(),
        by_month: new Map(),
      };
      byCustomer.set(customerId, bucket);
    }
    return bucket;
  };

  for (const row of allRows) {
    const turnover = Number(row.total_turnover ?? 0);
    const invoiceCount = Number(row.invoice_count ?? 0);
    const totalHours = Number(row.total_hours ?? 0);
    const customerHours = Number(row.customer_hours ?? 0);
    const absenceHours = Number(row.absence_hours ?? 0);
    const internalHours = Number(row.internal_hours ?? 0);
    const otherHours = Number(row.other_hours ?? 0);
    const contractValue = Number(row.contract_value ?? 0);

    totals.total_turnover += turnover;
    totals.invoice_count += invoiceCount;
    totals.total_hours += totalHours;
    totals.customer_hours += customerHours;
    totals.absence_hours += absenceHours;
    totals.internal_hours += internalHours;
    totals.other_hours += otherHours;
    totals.contract_value += contractValue;

    customersContributing.add(row.customer_id);

    const monthEntry = byMonth.get(row.period_month) ?? {
      period_month: row.period_month,
      total_turnover: 0,
      invoice_count: 0,
      total_hours: 0,
      contributing_customers: 0,
    };
    monthEntry.total_turnover += turnover;
    monthEntry.invoice_count += invoiceCount;
    monthEntry.total_hours += totalHours;
    monthEntry.contributing_customers += 1;
    byMonth.set(row.period_month, monthEntry);

    if (includePerCustomer) {
      const bucket = ensureCustomerBucket(row.customer_id);
      bucket.totals.total_turnover += turnover;
      bucket.totals.invoice_count += invoiceCount;
      bucket.totals.total_hours += totalHours;
      bucket.totals.customer_hours += customerHours;
      bucket.totals.absence_hours += absenceHours;
      bucket.totals.internal_hours += internalHours;
      bucket.totals.other_hours += otherHours;
      bucket.totals.contract_value += contractValue;

      const customerMonthEntry = bucket.by_month.get(row.period_month) ?? {
        period_month: row.period_month,
        total_turnover: 0,
        invoice_count: 0,
        total_hours: 0,
        contributing_customers: 1,
      };
      customerMonthEntry.total_turnover += turnover;
      customerMonthEntry.invoice_count += invoiceCount;
      customerMonthEntry.total_hours += totalHours;
      bucket.by_month.set(row.period_month, customerMonthEntry);
    }
  }

  // Ensure every explicitly-requested customer appears in by_customer, even
  // if they had no KPI rows for the period (caller asked about them — say so
  // explicitly rather than letting them silently drop out).
  if (includePerCustomer) {
    for (const id of explicitIds) {
      if (!byCustomer.has(id)) {
        ensureCustomerBucket(id);
      }
    }
  }

  // -------------------------------------------------------------------------
  // 5. Build response
  // -------------------------------------------------------------------------
  // When the caller asked for a single month, the by_month array is just one
  // row that duplicates `totals` — omit it to save tokens. Same logic for
  // each customer's nested by_month.
  const isSingleMonth = month != null;

  // Cap by_customer to top 30 (sorted desc by total_turnover) so a portfolio
  // of 200 customers doesn't balloon the tool-result JSON. The model still
  // gets the aggregate totals; if the user asks for a specific customer not
  // in the top 30 they can request that customer by id.
  const BY_CUSTOMER_LIMIT = 30;

  const response: Record<string, unknown> = {
    period: {
      year,
      month: month ?? null,
      type: month != null ? "month" : "year",
    },
    scope: {
      customer_ids:
        explicitIds.size > 0 ? Array.from(explicitIds) : null,
      include_inactive: includeInactive,
      customers_in_scope: scopedCustomerIds?.length ?? null,
      customers_contributing: customersContributing.size,
    },
    totals,
    source: "customer_kpis (precomputed rollup — matches reports dashboard)",
  };

  if (!isSingleMonth) {
    response.by_month = Array.from(byMonth.values()).sort(
      (a, b) => a.period_month - b.period_month,
    );
  }

  if (includePerCustomer) {
    const allCustomers = Array.from(byCustomer.values())
      .map((bucket) => ({
        customer_id: bucket.customer_id,
        name: bucket.name,
        fortnox_customer_number: bucket.fortnox_customer_number,
        totals: bucket.totals,
        // Per-customer by_month is omitted for single-month queries: the row
        // would just repeat the customer's totals for that month.
        ...(isSingleMonth
          ? {}
          : {
              by_month: Array.from(bucket.by_month.values()).sort(
                (a, b) => a.period_month - b.period_month,
              ),
            }),
      }))
      .sort((a, b) => b.totals.total_turnover - a.totals.total_turnover);

    const totalCustomers = allCustomers.length;
    response.by_customer = allCustomers.slice(0, BY_CUSTOMER_LIMIT);

    if (totalCustomers > BY_CUSTOMER_LIMIT) {
      response._compacted = [
        {
          field: "by_customer",
          total_count: totalCustomers,
          shown_count: BY_CUSTOMER_LIMIT,
          note: "Showing the top 30 customers by turnover. Call again with `customer_ids: [...]` for specific customers, or interpret these as the leaders.",
        },
      ];
    }
  }

  return response;
};
