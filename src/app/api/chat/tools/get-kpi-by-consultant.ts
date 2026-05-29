import { chunkArray } from "@/lib/reports";

import { filterAccessibleConsultants } from "./consultant-access";
import {
  drainPages,
  fetchAnnualizedContractValuesByCustomerId,
} from "./contract-values";
import type { ToolHandler } from "./types";

export type GetKpiByConsultantInput = {
  year: number;
  month?: number | null;
  active_consultants_only?: boolean;
  active_customers_only?: boolean;
  limit?: number | null;
  sort_by?:
    | "total_turnover"
    | "invoice_count"
    | "total_hours"
    | "customer_hours"
    | "contract_value"
    | "customer_count";
};

type ProfileRow = {
  id: string;
  full_name: string | null;
  email: string;
  role: string | null;
  team_id: string | null;
  fortnox_cost_center: string | null;
  is_active: boolean;
};

type CustomerRow = {
  id: string;
  fortnox_cost_center: string | null;
  status: string | null;
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
 * Aggregates KPI numbers per consultant for a given period. The
 * customer↔consultant link runs through `fortnox_cost_center` matching, so:
 *
 *   1. Fetch active profiles whose `fortnox_cost_center` is set (the
 *      consultants we can attribute to). Build a cost_center -> consultant
 *      map. Multiple consultants may share a cost center; we attribute the
 *      cost center's KPI to each of them, but flag `shared_cost_center=true`
 *      so the caller knows the totals overlap.
 *   2. Fetch active customers, group their ids by cost center.
 *   3. Pull customer_kpis for every customer in scope for the requested
 *      period (period_type='month'), chunked by 200 ids per query.
 *   4. Sum per consultant via the cost center mapping. Sort by `sort_by`,
 *      slice to `limit`.
 *
 * Use this for questions like "which consultant invoiced most last quarter"
 * or "rank consultants by hours this year". For a single consultant's
 * portfolio, prefer get_consultant_customers + get_kpi_summary(customer_ids).
 */
export const getKpiByConsultant: ToolHandler<GetKpiByConsultantInput> = async (
  input,
  { supabase, user },
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

  const activeConsultantsOnly = input.active_consultants_only ?? true;
  const activeCustomersOnly = input.active_customers_only ?? true;
  const sortBy = input.sort_by ?? "total_turnover";
  // Default to top 30 — enough to answer almost every ranking question
  // ("which consultants are top performers", "compare team turnover") while
  // keeping the JSON payload (which is re-sent on every tool-loop iteration)
  // small. Callers can override up to a hard ceiling of 200.
  const DEFAULT_LIMIT = 30;
  const MAX_LIMIT = 200;
  const limitRaw = input.limit;
  const limit =
    typeof limitRaw === "number" && Number.isInteger(limitRaw) && limitRaw > 0
      ? Math.min(limitRaw, MAX_LIMIT)
      : DEFAULT_LIMIT;

  // -------------------------------------------------------------------------
  // 1. Consultants
  // -------------------------------------------------------------------------
  let profileQuery = supabase
    .from("profiles")
    .select(
      "id, full_name, email, role, team_id, fortnox_cost_center, is_active",
    )
    .not("fortnox_cost_center", "is", null);
  if (activeConsultantsOnly) {
    profileQuery = profileQuery.eq("is_active", true);
  }
  const profileRes = await profileQuery;
  if (profileRes.error) {
    return { error: profileRes.error.message };
  }
  // Apply role-based scoping at the source: a `user` only sees themselves,
  // a `team_lead` sees same-team consultants (+ self), admins see all.
  // Filtering here cascades through the rest of the function naturally —
  // costCenterToConsultants only carries in-scope consultants, KPI buckets
  // are only built for them, and the response can't leak others' data.
  const rawProfiles = (profileRes.data ?? []) as unknown as ProfileRow[];
  const profiles = filterAccessibleConsultants(user, rawProfiles);
  // How many consultants exist in the firm but are hidden from the caller
  // by role-based scoping. Surface only the count (not names) so the
  // model can tell the user "you see N of M consultants" or similar
  // instead of pretending the others don't exist.
  const accessFilteredCount = rawProfiles.length - profiles.length;

  const costCenterToConsultants = new Map<string, ProfileRow[]>();
  for (const profile of profiles) {
    const code = profile.fortnox_cost_center?.trim();
    if (!code) continue;
    const list = costCenterToConsultants.get(code) ?? [];
    list.push(profile);
    costCenterToConsultants.set(code, list);
  }

  // -------------------------------------------------------------------------
  // 2. Customers
  //
  // Paginated: real installations have >1000 active customers; without
  // drainPages, customer_to_cost_center mapping would silently lose
  // everyone past the 1000-row cap, dropping their KPI contribution from
  // the consultant aggregation downstream.
  // -------------------------------------------------------------------------
  const customersResult = await drainPages<CustomerRow>(() => {
    let q = supabase
      .from("customers")
      .select("id, fortnox_cost_center, status")
      .not("fortnox_cost_center", "is", null);
    if (activeCustomersOnly) q = q.eq("status", "active");
    return q;
  });
  if (customersResult.error) {
    return { error: customersResult.error };
  }
  const customers = customersResult.rows;

  // Access-restricted detection. profiles.length > 0 means the caller can
  // read the profiles table (always returns rows for any authenticated
  // user). But if customers.length is 0 in the same call, that's a strong
  // signal that RLS gated the customers SELECT — the caller doesn't have
  // the `customers` scope. We surface this as an explicit error_type so the
  // model can stop and tell the user gracefully instead of looping trying
  // to find data via other tools.
  if (profiles.length > 0 && customers.length === 0) {
    return {
      error:
        "Access restricted: this account doesn't have permission to view consultant performance data.",
      error_type: "access_restricted",
    };
  }

  const customerToCostCenter = new Map<string, string>();
  const costCenterToCustomerIds = new Map<string, string[]>();
  for (const customer of customers) {
    const code = customer.fortnox_cost_center?.trim();
    if (!code) continue;
    customerToCostCenter.set(customer.id, code);
    const list = costCenterToCustomerIds.get(code) ?? [];
    list.push(customer.id);
    costCenterToCustomerIds.set(code, list);
  }

  // Drop cost centers that have no consultants — KPIs there don't belong to
  // anyone in our list and would just be noise.
  const inScopeCustomerIds: string[] = [];
  for (const [code, ids] of costCenterToCustomerIds.entries()) {
    if (costCenterToConsultants.has(code)) {
      inScopeCustomerIds.push(...ids);
    }
  }

  if (inScopeCustomerIds.length === 0) {
    return {
      period: { year, month: month ?? null, type: month != null ? "month" : "year" },
      scope: {
        active_consultants_only: activeConsultantsOnly,
        active_customers_only: activeCustomersOnly,
        limit,
        sort_by: sortBy,
        consultants_in_scope: profiles.length,
        customers_in_scope: 0,
      },
      consultants: [],
      totals: ZERO_TOTALS(),
      source:
        "customer_kpis rollup for turnover/hours/invoice_count (matches reports dashboard); contract_value overlaid from contract_accruals (annualized, SEK/år).",
    };
  }

  // -------------------------------------------------------------------------
  // 3. KPIs
  //
  // Paginated. 200 customer_ids per chunk × 12 monthly rows = 2400 rows
  // late in the year, blowing past PostgREST's 1000-row cap. Without
  // drainPages, KPI rows for some customers get silently dropped — which
  // makes the per-consultant aggregation undercount by ~50% for affected
  // consultants. (This was the bug that made Hanna Dahl's chat number
  // come back as ~half her true revenue.)
  // -------------------------------------------------------------------------
  const kpiRows: KpiRow[] = [];
  try {
    for (const idChunk of chunkArray(inScopeCustomerIds, CUSTOMER_ID_CHUNK)) {
      const { rows, error } = await drainPages<KpiRow>(() => {
        let q = supabase
          .from("customer_kpis")
          .select(KPI_COLUMNS)
          .eq("period_type", "month")
          .eq("period_year", year)
          .in("customer_id", idChunk);
        if (month != null) q = q.eq("period_month", month);
        return q;
      });
      if (error) throw new Error(error);
      kpiRows.push(...rows);
    }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Failed to load KPIs.",
    };
  }

  // -------------------------------------------------------------------------
  // 3b. Current-month invoice overlay
  //
  // customer_kpis is finalized after a month closes — the current calendar
  // month's row is stale-or-missing relative to what's actually been
  // invoiced. Replace it with the live aggregation from `invoices` so the
  // per-consultant numbers match what the reports dashboard shows. Mirrors
  // the same overlay in get_kpi_summary.
  // -------------------------------------------------------------------------
  {
    const today = new Date();
    const currentYear = today.getFullYear();
    const currentMonth = today.getMonth() + 1;
    const requestingCurrentMonth =
      year === currentYear &&
      (month == null || month === currentMonth);

    if (requestingCurrentMonth && inScopeCustomerIds.length > 0) {
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

      try {
        for (const chunk of chunkArray(inScopeCustomerIds, CUSTOMER_ID_CHUNK)) {
          const { rows, error } = await drainPages<InvoiceRow>(() =>
            supabase
              .from("invoices")
              .select("customer_id, total_ex_vat")
              .gte("invoice_date", monthStart)
              .lte("invoice_date", monthEnd)
              .in("customer_id", chunk),
          );
          if (error) throw new Error(error);
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
        }

        // Map current-month kpiRows by customer_id so we can overwrite
        // turnover/invoice_count in place.
        const currentMonthRowsByCustomer = new Map<string, KpiRow>();
        for (const row of kpiRows) {
          if (
            row.period_year === currentYear &&
            row.period_month === currentMonth
          ) {
            currentMonthRowsByCustomer.set(row.customer_id, row);
          }
        }

        // Override existing rows + synthesize missing ones.
        for (const [customerId, data] of invoicesByCustomer) {
          const existing = currentMonthRowsByCustomer.get(customerId);
          if (existing) {
            existing.total_turnover = data.turnover;
            existing.invoice_count = data.invoiceCount;
          } else {
            kpiRows.push({
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

        // Customers with a stale current-month rollup but no invoices →
        // zero them out so they don't contribute spurious turnover.
        for (const [customerId, row] of currentMonthRowsByCustomer) {
          if (!invoicesByCustomer.has(customerId)) {
            row.total_turnover = 0;
            row.invoice_count = 0;
          }
        }
      } catch (error) {
        console.error(
          "getKpiByConsultant: current-month invoice overlay failed",
          error,
        );
        // Best-effort: leave the rollup as-is rather than fail the whole call.
      }
    }
  }

  // -------------------------------------------------------------------------
  // 4. Aggregate per consultant
  // -------------------------------------------------------------------------
  type ConsultantBucket = {
    consultant_id: string;
    name: string | null;
    email: string;
    role: string | null;
    team_id: string | null;
    fortnox_cost_center: string;
    shared_cost_center: boolean;
    customer_ids: Set<string>;
    totals: ReturnType<typeof ZERO_TOTALS>;
  };

  const buckets = new Map<string, ConsultantBucket>();
  const ensureBucket = (profile: ProfileRow): ConsultantBucket => {
    let bucket = buckets.get(profile.id);
    if (!bucket) {
      const sharing =
        (costCenterToConsultants.get(profile.fortnox_cost_center ?? "")?.length ??
          1) > 1;
      bucket = {
        consultant_id: profile.id,
        name: profile.full_name,
        email: profile.email,
        role: profile.role,
        team_id: profile.team_id,
        fortnox_cost_center: profile.fortnox_cost_center ?? "",
        shared_cost_center: sharing,
        customer_ids: new Set(),
        totals: ZERO_TOTALS(),
      };
      buckets.set(profile.id, bucket);
    }
    return bucket;
  };
  // Seed buckets for every consultant in scope so zero-activity ones still
  // appear in the response.
  for (const profile of profiles) {
    if (profile.fortnox_cost_center) ensureBucket(profile);
  }

  const grandTotals = ZERO_TOTALS();

  for (const row of kpiRows) {
    const code = customerToCostCenter.get(row.customer_id);
    if (!code) continue;
    const consultants = costCenterToConsultants.get(code);
    if (!consultants || consultants.length === 0) continue;

    const turnover = Number(row.total_turnover ?? 0);
    const invoiceCount = Number(row.invoice_count ?? 0);
    const totalHours = Number(row.total_hours ?? 0);
    const customerHours = Number(row.customer_hours ?? 0);
    const absenceHours = Number(row.absence_hours ?? 0);
    const internalHours = Number(row.internal_hours ?? 0);
    const otherHours = Number(row.other_hours ?? 0);
    const contractValue = Number(row.contract_value ?? 0);

    grandTotals.total_turnover += turnover;
    grandTotals.invoice_count += invoiceCount;
    grandTotals.total_hours += totalHours;
    grandTotals.customer_hours += customerHours;
    grandTotals.absence_hours += absenceHours;
    grandTotals.internal_hours += internalHours;
    grandTotals.other_hours += otherHours;
    grandTotals.contract_value += contractValue;

    for (const consultant of consultants) {
      const bucket = ensureBucket(consultant);
      bucket.customer_ids.add(row.customer_id);
      bucket.totals.total_turnover += turnover;
      bucket.totals.invoice_count += invoiceCount;
      bucket.totals.total_hours += totalHours;
      bucket.totals.customer_hours += customerHours;
      bucket.totals.absence_hours += absenceHours;
      bucket.totals.internal_hours += internalHours;
      bucket.totals.other_hours += otherHours;
      bucket.totals.contract_value += contractValue;
    }
  }

  // -------------------------------------------------------------------------
  // 4b. Override contract_value with annualized truth from contract_accruals.
  //
  // The customer_kpis.contract_value rollup is unreliable (see the
  // contract-value bug investigation). Recompute it from the source of
  // truth, scoped to the consultants' own customer portfolios.
  // -------------------------------------------------------------------------
  {
    const annualizedByCustomerId =
      await fetchAnnualizedContractValuesByCustomerId(
        supabase,
        inScopeCustomerIds,
      );

    grandTotals.contract_value = 0;
    for (const bucket of buckets.values()) {
      bucket.totals.contract_value = 0;
    }

    for (const customerId of inScopeCustomerIds) {
      const annualized = annualizedByCustomerId.get(customerId) ?? 0;
      if (annualized === 0) continue;

      grandTotals.contract_value += annualized;

      const code = customerToCostCenter.get(customerId);
      if (!code) continue;
      const consultantsForCode = costCenterToConsultants.get(code);
      if (!consultantsForCode) continue;
      for (const consultant of consultantsForCode) {
        const bucket = buckets.get(consultant.id);
        if (bucket) {
          bucket.totals.contract_value += annualized;
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // 5. Build, sort, slice
  //
  // Hour fields are renamed in the OUTPUT (total_hours → portfolio_total_hours,
  // customer_hours → portfolio_customer_hours) so the AI cannot accidentally
  // emit a bare "Timmar" column header — the only natural translation is
  // "Portfölj-timmar". Sort still operates on internal field names; we map
  // the AI-facing enum to internal names before sorting.
  // -------------------------------------------------------------------------
  const renamePortfolioTotals = (t: ReturnType<typeof ZERO_TOTALS>) => ({
    total_turnover: t.total_turnover,
    invoice_count: t.invoice_count,
    portfolio_total_hours: t.total_hours,
    portfolio_customer_hours: t.customer_hours,
    portfolio_absence_hours: t.absence_hours,
    portfolio_internal_hours: t.internal_hours,
    portfolio_other_hours: t.other_hours,
    contract_value: t.contract_value,
  });

  let consultantList = Array.from(buckets.values()).map((bucket) => ({
    consultant_id: bucket.consultant_id,
    name: bucket.name,
    email: bucket.email,
    role: bucket.role,
    team_id: bucket.team_id,
    fortnox_cost_center: bucket.fortnox_cost_center,
    shared_cost_center: bucket.shared_cost_center,
    customer_count: bucket.customer_ids.size,
    totals: renamePortfolioTotals(bucket.totals),
    // Keep raw internal totals on a non-output key so the sort comparator
    // can still reach them after the rename. Stripped before final response.
    _internal_totals: bucket.totals,
  }));

  consultantList.sort((a, b) => {
    if (sortBy === "customer_count") {
      return b.customer_count - a.customer_count;
    }
    return b._internal_totals[sortBy] - a._internal_totals[sortBy];
  });

  // Drop the internal-only sort helper now that ordering is fixed.
  consultantList = consultantList.map(({ _internal_totals: _, ...rest }) => rest) as typeof consultantList;

  const totalConsultants = consultantList.length;
  if (consultantList.length > limit) {
    consultantList = consultantList.slice(0, limit);
  }

  // Mirror the `_compacted` shape used by the route-level compactor so the
  // model has one consistent signal that "this list is a slice of a bigger
  // ranking" regardless of where the truncation happened.
  const compactedNotes =
    totalConsultants > consultantList.length
      ? [
          {
            field: "consultants",
            total_count: totalConsultants,
            shown_count: consultantList.length,
          },
        ]
      : undefined;

  return {
    data_scope: "portfolio" as const,
    data_scope_note:
      "PORTFOLIO-scoped via Fortnox cost center. Each consultant's row sums " +
      "every customer assigned to their cost center.\n\n" +
      "Field-by-field interpretation — read carefully, this is where the AI " +
      "tends to over-caveat:\n" +
      "  • total_turnover, invoice_count, contract_value → These ARE the " +
      "    consultant's production. In a customer-manager model, the " +
      "    consultant owns the customer relationship, so the customers' " +
      "    invoiced revenue IS the consultant's revenue. There is no " +
      "    separate per-consultant revenue source in the data model. " +
      "    Label simply as 'omsättning' / 'avtalsvärde' (you can add " +
      "    'portfolio' for context). DO NOT say things like 'this is not " +
      "    their personal production' — that's misleading. Their portfolio " +
      "    revenue IS their production.\n" +
      "  • total_hours, customer_hours → These are hours LOGGED ON THE " +
      "    CONSULTANT'S CUSTOMERS by anyone in the firm, NOT the " +
      "    consultant's own time reports. Hours is the ONE field where " +
      "    portfolio and personal genuinely differ. If the user asks how " +
      "    many hours the consultant has worked, call " +
      "    get_consultant_personal_hours instead — that reads " +
      "    manager_time_kpis (their actual Fortnox time reports).",
    period: {
      year,
      month: month ?? null,
      type: month != null ? "month" : "year",
    },
    scope: {
      active_consultants_only: activeConsultantsOnly,
      active_customers_only: activeCustomersOnly,
      limit,
      sort_by: sortBy,
      consultants_in_scope: profiles.length,
      customers_in_scope: inScopeCustomerIds.length,
      ...(accessFilteredCount > 0
        ? {
            access_filtered_count: accessFilteredCount,
            access_filtered_note:
              "There are additional consultants in the firm that are outside your access scope. The numbers above only cover the consultants you can see.",
          }
        : {}),
    },
    consultants: consultantList,
    ...(compactedNotes ? { _compacted: compactedNotes } : {}),
    totals: renamePortfolioTotals(grandTotals),
    notes: [
      "Revenue fields (total_turnover, invoice_count, contract_value) ARE " +
        "the consultant's production via customer-manager ownership. Don't " +
        "caveat them as 'not personal' — there is no other revenue source.",
      "Hour fields are PREFIXED 'portfolio_' (portfolio_total_hours, " +
        "portfolio_customer_hours, …) because they represent time logged on " +
        "the consultant's customers BY ANYONE, not the consultant's own " +
        "Fortnox time reports. In tables/columns these MUST be labelled " +
        "'Portfölj-timmar' / 'Portfolio hours' / 'Kundtid' — never a bare " +
        "'Timmar' or 'Hours'. For the consultant's own logged time, call " +
        "get_consultant_personal_hours.",
      "When `shared_cost_center` is true on a consultant, multiple " +
        "consultants share that Fortnox cost center; their totals overlap " +
        "(the same KPI rows are attributed to each). Be explicit about this " +
        "in answers when summing across consultants.",
    ],
    source: "customer_kpis rollup for turnover/hours/invoice_count (matches reports dashboard); contract_value overlaid from contract_accruals (annualized, SEK/år).",
  };
};
