import { chunkArray } from "@/lib/reports";

import { filterAccessibleConsultants } from "./consultant-access";
import { fetchAnnualizedContractValuesByCustomerId } from "./contract-values";
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
  // -------------------------------------------------------------------------
  let customerQuery = supabase
    .from("customers")
    .select("id, fortnox_cost_center, status")
    .not("fortnox_cost_center", "is", null);
  if (activeCustomersOnly) {
    customerQuery = customerQuery.eq("status", "active");
  }
  const customerRes = await customerQuery;
  if (customerRes.error) {
    return { error: customerRes.error.message };
  }
  const customers = (customerRes.data ?? []) as unknown as CustomerRow[];

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
  // -------------------------------------------------------------------------
  const kpiRows: KpiRow[] = [];
  try {
    for (const idChunk of chunkArray(inScopeCustomerIds, CUSTOMER_ID_CHUNK)) {
      let query = supabase
        .from("customer_kpis")
        .select(KPI_COLUMNS)
        .eq("period_type", "month")
        .eq("period_year", year)
        .in("customer_id", idChunk);
      if (month != null) {
        query = query.eq("period_month", month);
      }
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      kpiRows.push(...((data ?? []) as unknown as KpiRow[]));
    }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Failed to load KPIs.",
    };
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
  // -------------------------------------------------------------------------
  let consultantList = Array.from(buckets.values()).map((bucket) => ({
    consultant_id: bucket.consultant_id,
    name: bucket.name,
    email: bucket.email,
    role: bucket.role,
    team_id: bucket.team_id,
    fortnox_cost_center: bucket.fortnox_cost_center,
    shared_cost_center: bucket.shared_cost_center,
    customer_count: bucket.customer_ids.size,
    totals: bucket.totals,
  }));

  consultantList.sort((a, b) => {
    if (sortBy === "customer_count") {
      return b.customer_count - a.customer_count;
    }
    return b.totals[sortBy] - a.totals[sortBy];
  });

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
    totals: grandTotals,
    notes: [
      "When `shared_cost_center` is true on a consultant, multiple " +
        "consultants share that Fortnox cost center; their totals overlap " +
        "(the same KPI rows are attributed to each). Be explicit about this " +
        "in answers when summing across consultants.",
    ],
    source: "customer_kpis rollup for turnover/hours/invoice_count (matches reports dashboard); contract_value overlaid from contract_accruals (annualized, SEK/år).",
  };
};
