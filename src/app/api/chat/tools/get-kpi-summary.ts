import { annualizeContractTotal, chunkArray } from "@/lib/reports";

import { drainPages } from "./contract-values";
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
    // Paginated: real tenants have >1000 active customers and PostgREST
    // would silently cap. Truncating the scope here cascades into every
    // downstream KPI aggregate.
    const { rows, error } = await drainPages<{ id: string }>(() =>
      supabase.from("customers").select("id").eq("status", "active"),
    );
    if (error) {
      return { error };
    }
    scopedCustomerIds = rows.map((row) => row.id);

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

  // Paginated: 200 customer_ids per chunk × 12 monthly rows per customer
  // can produce 2400 rows once the year fills out, blowing past PostgREST's
  // 1000-row cap. Without drainPages we silently lose rows late in the year.
  const runKpiQuery = async (idChunk: string[] | null) => {
    const { rows, error } = await drainPages<KpiRow>(() => {
      let q = supabase
        .from("customer_kpis")
        .select(KPI_COLUMNS)
        .eq("period_type", "month")
        .eq("period_year", year);
      if (month != null) q = q.eq("period_month", month);
      if (idChunk) q = q.in("customer_id", idChunk);
      return q;
    });
    if (error) throw new Error(error);
    allRows.push(...rows);
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
  // 2b. Current-month invoice overlay
  //
  // customer_kpis is finalized after a month closes — the sync writes its
  // monthly rollup for month M sometime after M ends. For the current
  // calendar month the rollup is either missing or stale, so turnover and
  // invoice_count read from it under-count what's actually been invoiced.
  // The dashboard reads `customer_kpis` too, but reports' include-current-
  // month toggle is paired with a fresher snapshot elsewhere in the
  // dashboard pipeline. To match what the user sees on reports, we
  // overlay the current month from the `invoices` table directly.
  //
  // Only applied when the requested period includes the current month.
  // Other months (historical, or explicitly-requested non-current month)
  // stay on the customer_kpis rollup. Hours and contract_value are NOT
  // overlaid (they have their own truth sources).
  // -------------------------------------------------------------------------
  {
    const today = new Date();
    const currentYear = today.getFullYear();
    const currentMonth = today.getMonth() + 1;
    const requestingCurrentMonth =
      year === currentYear &&
      (month == null || month === currentMonth);

    if (
      requestingCurrentMonth &&
      (scopedCustomerIds == null || scopedCustomerIds.length > 0)
    ) {
      const monthStart = `${currentYear}-${String(currentMonth).padStart(2, "0")}-01`;
      const monthEndDate = new Date(currentYear, currentMonth, 0);
      const monthEnd = `${currentYear}-${String(currentMonth).padStart(2, "0")}-${String(monthEndDate.getDate()).padStart(2, "0")}`;

      type InvoiceRow = {
        customer_id: string | null;
        total_ex_vat: number | null;
      };

      const invoicesByCustomer = new Map<
        string,
        { turnover: number; invoiceCount: number }
      >();

      const consumeInvoices = (rows: InvoiceRow[]) => {
        for (const row of rows) {
          if (!row.customer_id) continue;
          const prev = invoicesByCustomer.get(row.customer_id) ?? {
            turnover: 0,
            invoiceCount: 0,
          };
          prev.turnover += Number(row.total_ex_vat ?? 0);
          prev.invoiceCount += 1;
          invoicesByCustomer.set(row.customer_id, prev);
        }
      };

      try {
        if (scopedCustomerIds == null) {
          const { rows, error } = await drainPages<InvoiceRow>(() =>
            supabase
              .from("invoices")
              .select("customer_id, total_ex_vat")
              .gte("invoice_date", monthStart)
              .lte("invoice_date", monthEnd),
          );
          if (error) throw new Error(error);
          consumeInvoices(rows);
        } else {
          for (const chunk of chunkArray(
            scopedCustomerIds,
            CUSTOMER_ID_CHUNK,
          )) {
            const { rows, error } = await drainPages<InvoiceRow>(() =>
              supabase
                .from("invoices")
                .select("customer_id, total_ex_vat")
                .gte("invoice_date", monthStart)
                .lte("invoice_date", monthEnd)
                .in("customer_id", chunk),
            );
            if (error) throw new Error(error);
            consumeInvoices(rows);
          }
        }

        // Map current-month customer_kpis rows by customer_id so we can
        // overwrite their turnover/invoice_count in place.
        const currentMonthRowsByCustomer = new Map<string, KpiRow>();
        for (const row of allRows) {
          if (
            row.period_year === currentYear &&
            row.period_month === currentMonth
          ) {
            currentMonthRowsByCustomer.set(row.customer_id, row);
          }
        }

        // For each customer that has invoices this month, override the
        // (stale) customer_kpis values with the live aggregation.
        for (const [customerId, data] of invoicesByCustomer) {
          const existing = currentMonthRowsByCustomer.get(customerId);
          if (existing) {
            existing.total_turnover = data.turnover;
            existing.invoice_count = data.invoiceCount;
          } else {
            // Customer has invoices this month but no customer_kpis row
            // yet (sync hasn't written it). Synthesize a row so the
            // downstream aggregation picks it up.
            allRows.push({
              customer_id: customerId,
              period_year: currentYear,
              period_month: currentMonth,
              total_turnover: data.turnover,
              invoice_count: data.invoiceCount,
              total_hours: null,
              customer_hours: null,
              absence_hours: null,
              internal_hours: null,
              other_hours: null,
              contract_value: null,
            });
          }
        }

        // Customers that had a current-month customer_kpis row but NO
        // invoices this month should have their turnover/invoice_count
        // zeroed — the rollup may carry stale residue from a partial sync.
        for (const [customerId, row] of currentMonthRowsByCustomer) {
          if (!invoicesByCustomer.has(customerId)) {
            row.total_turnover = 0;
            row.invoice_count = 0;
          }
        }
      } catch (error) {
        console.error(
          "getKpiSummary: current-month invoice overlay failed",
          error,
        );
        // Best-effort: leave customer_kpis values as-is. The model will
        // still get a roughly-right answer based on the rollup.
      }
    }
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
  // 4b. Override contract_value with the truth from contract_accruals.
  //
  // The customer_kpis.contract_value rollup is known to misrepresent the
  // annualized contract commitment for many customers (top customer reported
  // as 183 666 kr/år when the raw-derived value is 1 288 866). Until the
  // sync is fixed we recompute contract_value here the same way the reports
  // dashboard does: SUM(annualizeContractTotal(total_ex_vat, period)) across
  // is_active=true rows in contract_accruals, scoped to the in-scope
  // customers.
  // -------------------------------------------------------------------------
  {
    // a) Collect (customer_id, fortnox_customer_number) for everyone in
    //    scope. When we have per-customer buckets that's already in
    //    customerInfo; otherwise we fetch the mapping for scopedCustomerIds
    //    (or all relevant customers when the caller asked for a global
    //    rollup including inactive customers).
    type CustomerKey = { id: string; fortnox_customer_number: string | null };
    const customersInScope = new Map<string, CustomerKey>();

    if (includePerCustomer) {
      for (const [id, bucket] of byCustomer) {
        customersInScope.set(id, {
          id,
          fortnox_customer_number: bucket.fortnox_customer_number,
        });
      }
    }

    // For ids we don't already have fortnox numbers for (the !includePerCustomer
    // path, or buckets created with no customerInfo entry), fetch them.
    let idsNeedingFortnoxLookup: string[];
    if (includePerCustomer) {
      idsNeedingFortnoxLookup = Array.from(customersInScope.values())
        .filter((c) => !c.fortnox_customer_number)
        .map((c) => c.id);
    } else if (scopedCustomerIds && scopedCustomerIds.length > 0) {
      idsNeedingFortnoxLookup = scopedCustomerIds;
    } else if (scopedCustomerIds == null) {
      // Caller asked for a global rollup including inactive customers — we
      // need every customer's fortnox number. Paginated because a tenant
      // with >1000 customers would otherwise be silently truncated, which
      // cascades into a wrong contract_value override.
      const { rows, error } = await drainPages<{
        id: string;
        fortnox_customer_number: string | null;
      }>(() =>
        supabase.from("customers").select("id, fortnox_customer_number"),
      );
      if (error) {
        // Best-effort: leave contract_value as-is (rollup value) and move
        // on rather than fail the whole call.
        console.error(
          "getKpiSummary: failed to load customers for contract_value override",
          error,
        );
        idsNeedingFortnoxLookup = [];
      } else {
        for (const row of rows) {
          customersInScope.set(row.id, {
            id: row.id,
            fortnox_customer_number: row.fortnox_customer_number,
          });
        }
        idsNeedingFortnoxLookup = [];
      }
    } else {
      idsNeedingFortnoxLookup = [];
    }

    if (idsNeedingFortnoxLookup.length > 0) {
      try {
        for (const chunk of chunkArray(
          idsNeedingFortnoxLookup,
          CUSTOMER_ID_CHUNK,
        )) {
          const { data, error } = await supabase
            .from("customers")
            .select("id, fortnox_customer_number")
            .in("id", chunk);
          if (error) throw new Error(error.message);
          for (const row of (data ?? []) as unknown as Array<{
            id: string;
            fortnox_customer_number: string | null;
          }>) {
            customersInScope.set(row.id, {
              id: row.id,
              fortnox_customer_number: row.fortnox_customer_number,
            });
          }
        }
      } catch (error) {
        console.error(
          "getKpiSummary: fortnox_customer_number lookup failed",
          error,
        );
      }
    }

    // b) Sum annualized active contracts per fortnox_customer_number.
    const fortnoxNumbers = Array.from(customersInScope.values())
      .map((c) => c.fortnox_customer_number)
      .filter((n): n is string => Boolean(n));

    const annualizedByFortnox = new Map<string, number>();
    if (fortnoxNumbers.length > 0) {
      try {
        // Chunked AND paginated. With 5-10 contracts per customer typical,
        // a chunk of 100 customers can produce >1000 contract rows, and
        // PostgREST's default cap would silently lose contracts —
        // undercounting some customers and corrupting the contract_value
        // override for the whole response.
        for (const chunk of chunkArray(fortnoxNumbers, 100)) {
          const { rows, error } = await drainPages<{
            fortnox_customer_number: string | null;
            total_ex_vat: number | null;
            period: string | null;
          }>(() =>
            supabase
              .from("contract_accruals")
              .select("fortnox_customer_number, total_ex_vat, period")
              .in("fortnox_customer_number", chunk)
              .eq("is_active", true),
          );
          if (error) throw new Error(error);
          for (const row of rows) {
            if (!row.fortnox_customer_number) continue;
            const annualized = annualizeContractTotal(
              row.total_ex_vat,
              row.period,
            );
            const prev =
              annualizedByFortnox.get(row.fortnox_customer_number) ?? 0;
            annualizedByFortnox.set(
              row.fortnox_customer_number,
              prev + annualized,
            );
          }
        }
      } catch (error) {
        console.error(
          "getKpiSummary: contract_accruals lookup failed",
          error,
        );
      }
    }

    // c) Overwrite global and per-customer contract_value with the truth.
    let globalAnnualized = 0;
    for (const [customerId, info] of customersInScope) {
      const annualized = info.fortnox_customer_number
        ? annualizedByFortnox.get(info.fortnox_customer_number) ?? 0
        : 0;
      globalAnnualized += annualized;
      const bucket = byCustomer.get(customerId);
      if (bucket) {
        bucket.totals.contract_value = annualized;
      }
    }
    totals.contract_value = globalAnnualized;
  }

  // -------------------------------------------------------------------------
  // 5. Build response
  // -------------------------------------------------------------------------
  // When the caller asked for a single month, the by_month array is just one
  // row that duplicates `totals` — omit it to save tokens. Same logic for
  // each customer's nested by_month.
  const isSingleMonth = month != null;

  // Cap by_customer so a portfolio of hundreds of customers doesn't balloon
  // the tool-result JSON.
  //
  // The slice is built as a UNION of top-N across each meaningful ranking
  // metric (turnover, contract value, hours, invoice count), not "top N by
  // turnover" alone. Sorting by turnover only made the leaders of any other
  // metric invisible: a customer with 1.2M SEK in contract value but mid
  // turnover would silently fall off the list, and the model — looking at
  // the 30 it received — would confidently report a max well below the real
  // one. (See the contract-value bug investigation for the smoking gun.)
  const BY_CUSTOMER_LIMIT = 30;
  // Top-N per metric — 4 metrics × 10 = 40 candidates max, typically 20-30
  // after deduplication. Final list is then capped at BY_CUSTOMER_LIMIT.
  const TOP_PER_METRIC = 10;
  const RANKING_METRICS = [
    "total_turnover",
    "contract_value",
    "total_hours",
    "invoice_count",
  ] as const;

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
    source:
      "customer_kpis rollup for turnover/hours/invoice_count (matches " +
      "reports dashboard). contract_value is overridden live from " +
      "contract_accruals (sum of annualized active contracts per customer) " +
      "because the rollup's contract_value field is currently unreliable.",
  };

  if (!isSingleMonth) {
    response.by_month = Array.from(byMonth.values()).sort(
      (a, b) => a.period_month - b.period_month,
    );
  }

  if (includePerCustomer) {
    const allCustomers = Array.from(byCustomer.values()).map((bucket) => ({
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
    }));

    // Build the slice as the union of top-N across each ranking metric so
    // questions about any metric (not just turnover) see the actual leaders.
    // Explicitly-requested customers are always included regardless of rank.
    const includedIds = new Set<string>();
    for (const id of explicitIds) includedIds.add(id);

    for (const metric of RANKING_METRICS) {
      const ranked = [...allCustomers].sort((a, b) => {
        const av =
          (a.totals as unknown as Record<string, number>)[metric] ?? 0;
        const bv =
          (b.totals as unknown as Record<string, number>)[metric] ?? 0;
        return bv - av;
      });
      for (const customer of ranked.slice(0, TOP_PER_METRIC)) {
        includedIds.add(customer.customer_id);
      }
    }

    // Filter to the union, sort by turnover desc for stable presentation,
    // then cap. The cap should rarely bite — the union typically holds
    // 20-30 customers — but it protects against pathological cases where
    // every metric points at disjoint customers.
    const totalCustomers = allCustomers.length;
    const selected = allCustomers
      .filter((customer) => includedIds.has(customer.customer_id))
      .sort((a, b) => b.totals.total_turnover - a.totals.total_turnover);

    response.by_customer = selected.slice(0, BY_CUSTOMER_LIMIT);

    const shownCount = (response.by_customer as unknown[]).length;
    if (totalCustomers > shownCount) {
      response._compacted = [
        {
          field: "by_customer",
          total_count: totalCustomers,
          shown_count: shownCount,
          note:
            "Showing the union of top-" +
            String(TOP_PER_METRIC) +
            " customers across turnover, contract_value, total_hours, and invoice_count (deduped, capped at " +
            String(BY_CUSTOMER_LIMIT) +
            "). This means you can safely rank or threshold-filter this slice by ANY of those four metrics — the leaders of each are present. For customers outside this slice, call `get_top_customers` with the specific metric, or call back with `customer_ids: [...]`.",
        },
      ];
    }
  }

  return response;
};
