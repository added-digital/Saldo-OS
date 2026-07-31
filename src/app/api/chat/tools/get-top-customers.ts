import { annualizeContractTotal, chunkArray } from "@/lib/reports";

import {
  accessRestricted,
  canAccessConsultant,
} from "./consultant-access";
import {
  drainPages,
  fetchAnnualizedContractValuesByCustomerId,
} from "./contract-values";
import type { ToolHandler } from "./types";

/**
 * Pre-aggregated, pre-ranked top-N customer query.
 *
 * Built specifically to stop the context-window overflow that occurs when the
 * model tries to answer questions like "top 10 most profitable customers
 * 2026" by fetching the full customer list (~777 rows × all KPI fields) and
 * sorting in its head. That payload alone blows past 200k tokens.
 *
 * This tool does the work at the database level via ORDER BY ... LIMIT, so
 * the model receives at most `n` (default 10, max 50) compact rows
 * regardless of how many customers exist.
 *
 * Metrics:
 *   - `turnover`            — Total invoiced amount for the period. The right
 *                             default for both "mest lönsamma" (most
 *                             profitable, colloquial Swedish business usage)
 *                             and "högst omsättning" (highest turnover).
 *   - `turnover_per_hour`   — Effective hourly rate (turnover ÷ hours).
 *                             Actual profitability of the engagement when
 *                             the firm cares about margin, not absolute size.
 *   - `contract_value`      — Recurring contract value (årsavtal).
 *   - `hours`               — Total billed hours.
 *   - `invoice_count`       — Number of invoices.
 *
 * Scope:
 *   - Optional `consultant_id` to scope to one consultant's portfolio
 *     (matched via fortnox_cost_center, same logic as get_kpi_by_consultant).
 *   - Optional `month` for monthly ranking; omit for full-year.
 *
 * Reads from the same `customer_kpis` rollup as `/reports` and
 * `get_kpi_summary`, so numbers match the dashboard.
 */

export type TopCustomerMetric =
  | "turnover"
  | "turnover_per_hour"
  | "contract_value"
  | "hours"
  | "invoice_count";

export type GetTopCustomersInput = {
  metric?: TopCustomerMetric;
  year: number;
  month?: number | null;
  n?: number | null;
  consultant_id?: string | null;
  active_only?: boolean;
  /**
   * Optional threshold: only customers whose metric value is >= min_value
   * are included. Use this for threshold-shaped questions like "över 200
   * 000 kr", "more than X", "with at least X". Returns 0 results cleanly
   * rather than the top-N when no customers meet the threshold.
   */
  min_value?: number | null;
};

type CustomerJoinRow = {
  id: string;
  name: string;
  fortnox_customer_number: string | null;
  fortnox_cost_center: string | null;
  status: string | null;
};

type KpiRow = {
  customer_id: string;
  total_turnover: number | null;
  invoice_count: number | null;
  total_hours: number | null;
  contract_value: number | null;
  customers: CustomerJoinRow | CustomerJoinRow[] | null;
};

const DEFAULT_N = 10;
const MAX_N = 50;
const CUSTOMER_ID_CHUNK = 200;

/** Map metric name → the customer_kpis column it sorts by (or null for derived). */
const METRIC_COLUMN: Record<
  TopCustomerMetric,
  keyof Omit<KpiRow, "customer_id" | "customers"> | null
> = {
  turnover: "total_turnover",
  contract_value: "contract_value",
  hours: "total_hours",
  invoice_count: "invoice_count",
  // Derived — computed in memory after fetching all eligible rows.
  turnover_per_hour: null,
};

/** Human-readable labels the model can echo back. */
const METRIC_LABEL: Record<TopCustomerMetric, string> = {
  turnover: "Omsättning (kr)",
  turnover_per_hour: "Omsättning per timme (kr/h)",
  contract_value: "Avtalsvärde (kr/år)",
  hours: "Timmar",
  invoice_count: "Antal fakturor",
};

export const getTopCustomers: ToolHandler<GetTopCustomersInput> = async (
  input,
  { supabase, user },
) => {
  // ---------------------------------------------------------------------------
  // Validate inputs.
  // ---------------------------------------------------------------------------
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

  const metric: TopCustomerMetric = input.metric ?? "turnover";
  if (!(metric in METRIC_COLUMN)) {
    return {
      error: `Unknown metric '${metric}'. Allowed: ${Object.keys(METRIC_COLUMN).join(", ")}.`,
    };
  }

  const nRaw = input.n;
  const n =
    typeof nRaw === "number" && Number.isInteger(nRaw) && nRaw > 0
      ? Math.min(nRaw, MAX_N)
      : DEFAULT_N;

  const activeOnly = input.active_only ?? true;
  const consultantId = input.consultant_id?.trim() || null;

  // Optional threshold — must be a non-negative finite number when present.
  const minValueRaw = input.min_value;
  const minValue =
    typeof minValueRaw === "number" &&
    Number.isFinite(minValueRaw) &&
    minValueRaw > 0
      ? minValueRaw
      : null;

  // ---------------------------------------------------------------------------
  // Optional consultant scope. We resolve the consultant's cost center and
  // pull the customer IDs assigned to it. Multiple consultants can share a
  // cost center — same semantics as get_kpi_by_consultant.
  // ---------------------------------------------------------------------------
  let consultantCustomerIds: string[] | null = null;
  let consultantName: string | null = null;
  let consultantCostCenter: string | null = null;

  if (consultantId) {
    const profileRes = await supabase
      .from("profiles")
      .select("id, full_name, team_id, fortnox_cost_center")
      .eq("id", consultantId)
      .maybeSingle();

    if (profileRes.error || !profileRes.data) {
      return {
        error:
          profileRes.error?.message ??
          `Consultant ${consultantId} not found. Call resolve_consultant first.`,
      };
    }

    const profile = profileRes.data as unknown as {
      id: string;
      full_name: string | null;
      team_id: string | null;
      fortnox_cost_center: string | null;
    };

    // Role-based scope: refuse if the caller can't see this consultant.
    // get_top_customers with a consultant_id is functionally "show me this
    // consultant's customer ranking" — the same access bar as
    // get_consultant_customers.
    if (!canAccessConsultant(user, profile)) {
      return accessRestricted(
        "You don't have permission to view this consultant's customer ranking.",
      );
    }

    consultantName = profile.full_name;
    consultantCostCenter = profile.fortnox_cost_center ?? null;

    if (!consultantCostCenter) {
      // Consultant exists but isn't linked to any cost center → no
      // customers attributable to them. Return empty cleanly rather than
      // a confusing zero-row list.
      return {
        metric,
        metric_label: METRIC_LABEL[metric],
        period: {
          year,
          month: month ?? null,
          type: month != null ? "month" : "year",
        },
        scope: {
          consultant_id: consultantId,
          consultant_name: consultantName,
          consultant_cost_center: null,
          active_only: activeOnly,
        },
        n,
        ranked: [],
        total_count: 0,
        source:
          "customer_kpis (precomputed rollup — matches reports dashboard)",
        notes: [
          "Consultant has no fortnox_cost_center set, so no customers can be attributed.",
        ],
      };
    }

    let custQuery = supabase
      .from("customers")
      .select("id")
      .eq("fortnox_cost_center", consultantCostCenter);
    if (activeOnly) custQuery = custQuery.eq("status", "active");

    const custRes = await custQuery;
    if (custRes.error) return { error: custRes.error.message };

    consultantCustomerIds = (
      (custRes.data ?? []) as unknown as Array<{ id: string }>
    ).map((r) => r.id);

    if (consultantCustomerIds.length === 0) {
      return {
        metric,
        metric_label: METRIC_LABEL[metric],
        period: {
          year,
          month: month ?? null,
          type: month != null ? "month" : "year",
        },
        scope: {
          consultant_id: consultantId,
          consultant_name: consultantName,
          consultant_cost_center: consultantCostCenter,
          active_only: activeOnly,
        },
        n,
        ranked: [],
        total_count: 0,
        source:
          "customer_kpis (precomputed rollup — matches reports dashboard)",
      };
    }
  }

  // ---------------------------------------------------------------------------
  // contract_value path — bypass customer_kpis entirely.
  //
  // contract_value is a STOCK metric (current annual commitment), not a flow
  // metric, so it doesn't naturally fit a per-month rollup. The
  // `customer_kpis.contract_value` field has been observed to disagree with
  // the truth from `contract_accruals` by an order of magnitude on real data
  // (top customer reported as 183 666 kr/år when the raw-derived annualized
  // value is 1 288 866 kr/år). Until the sync is repaired we read directly
  // from `contract_accruals` and annualize on the fly — the same path the
  // dashboard's `/reports` page uses. That makes "kunder med avtalsvärde
  // över X kr" answer correctly.
  // ---------------------------------------------------------------------------
  if (metric === "contract_value") {
    return runContractValuePath({
      supabase,
      n,
      minValue,
      activeOnly,
      consultantCustomerIds,
      consultantId,
      consultantName,
      consultantCostCenter,
      year,
      month,
    });
  }

  // ---------------------------------------------------------------------------
  // Build the customer_kpis query.
  //
  // Period encoding in customer_kpis:
  //   - period_type='year', period_month=0   → full-year rollup
  //   - period_type='month', period_month=N  → monthly
  //
  // We join customers!inner so the model gets readable names back, and so
  // active_only filtering can happen as part of the join (Supabase's PostgREST
  // applies eq() filters across the embedded resource).
  // ---------------------------------------------------------------------------
  const periodType = month != null ? "month" : "year";
  const periodMonth = month ?? 0;

  // For simple metrics we ORDER BY ... LIMIT at the DB. For
  // turnover_per_hour we have to fetch + compute, but we can still narrow
  // the candidate pool to customers with non-trivial hours and turnover —
  // the top of the ratio is almost always among the top-of-turnover rows.
  const orderColumn = METRIC_COLUMN[metric];
  const isDerived = orderColumn == null;

  // Embedded join so we get the customer name in one round-trip. Casting at
  // the call site because the generated Database type narrows joined rows
  // to `never` in this codebase (see types.ts comment).
  const selectClause =
    "customer_id, total_turnover, invoice_count, total_hours, contract_value, " +
    "customers!inner(id, name, fortnox_customer_number, fortnox_cost_center, status)";

  // ---------------------------------------------------------------------------
  // Fast path — single SQL query, ORDER BY ... LIMIT, DB returns just N rows.
  // ---------------------------------------------------------------------------
  if (!isDerived) {
    let query = supabase
      .from("customer_kpis")
      .select(selectClause, { count: "exact" })
      .eq("period_type", periodType)
      .eq("period_year", year)
      .eq("period_month", periodMonth)
      // Reject zero/null on the metric so the "top N" list is meaningful.
      // Customers with no activity for the period shouldn't appear above
      // active ones just because of stable sort order.
      .gt(orderColumn, 0)
      .order(orderColumn, { ascending: false, nullsFirst: false })
      .limit(n);

    // Threshold filter — only customers whose metric value is at least
    // `min_value` qualify. Applied at the database level so we don't waste a
    // round-trip on rows that won't pass.
    if (minValue != null) {
      query = query.gte(orderColumn, minValue);
    }

    if (activeOnly) {
      // PostgREST filter on the embedded resource — only customers with
      // status='active' qualify.
      query = query.eq("customers.status", "active");
    }

    if (consultantCustomerIds && consultantCustomerIds.length > 0) {
      // Chunk safety: PostgREST allows large IN() lists, but if a
      // consultant ever has >200 customers we'd push close to URL limits.
      // 200 is a soft cap — way above realistic consultant portfolios.
      if (consultantCustomerIds.length <= 1000) {
        query = query.in("customer_id", consultantCustomerIds);
      } else {
        // Extremely unlikely path; fall through to derived-metric handling
        // which can chunk the IN() filter safely.
        return runDerivedPath({
          supabase,
          metric: "turnover",
          year,
          periodType,
          periodMonth,
          n,
          activeOnly,
          consultantCustomerIds,
          consultantId,
          consultantName,
          consultantCostCenter,
          minValue,
        });
      }
    }

    const { data, error, count } = await query;
    if (error) return { error: error.message };

    const rows = (data ?? []) as unknown as KpiRow[];

    // Overlay supporting.contract_value with the annualized truth from
    // contract_accruals. The rollup value in customer_kpis is unreliable;
    // since the ranking metric here isn't contract_value, we don't reorder,
    // but we do want the supporting numbers shown alongside to be honest.
    const annualizedByCustomerId =
      await fetchAnnualizedContractValuesByCustomerId(
        supabase,
        rows.map((row) => row.customer_id),
      );

    const ranked = rows.map((row, index) =>
      formatRow(
        row,
        index,
        metric,
        undefined,
        annualizedByCustomerId.get(row.customer_id) ?? 0,
      ),
    );

    // Precomputed sum of the ranked slice so the model doesn't tally row
    // values by hand. Only meaningful for additive metrics (turnover,
    // hours, invoice_count); semantically wrong for derived ratios.
    const totalValueInRanked = ranked.reduce(
      (sum, row) =>
        sum + Number((row as { value?: number }).value ?? 0),
      0,
    );

    return {
      metric,
      metric_label: METRIC_LABEL[metric],
      period: {
        year,
        month: month ?? null,
        type: periodType,
      },
      scope: {
        consultant_id: consultantId,
        consultant_name: consultantName,
        consultant_cost_center: consultantCostCenter,
        active_only: activeOnly,
      },
      n,
      ranked,
      total_value_in_ranked: totalValueInRanked,
      // total_count is the pool of customers with > 0 on this metric for the
      // period. Lets the model say "showing 10 of 47 customers with revenue
      // this period" rather than implying these are the ONLY customers.
      total_count: count ?? ranked.length,
      source:
        "customer_kpis rollup for the ranking metric; supporting.contract_value overlaid from contract_accruals (annualized).",
    };
  }

  // ---------------------------------------------------------------------------
  // Derived metric path (turnover_per_hour). Pull the eligible KPI rows
  // (with non-zero hours AND non-zero turnover) and compute the ratio in
  // memory. We don't pull 777 rows × all columns — we filter to non-zero
  // activity AND scope down by consultant if set, so the row count is
  // typically <200.
  // ---------------------------------------------------------------------------
  return runDerivedPath({
    supabase,
    metric,
    year,
    periodType,
    periodMonth,
    n,
    activeOnly,
    consultantCustomerIds,
    consultantId,
    consultantName,
    consultantCostCenter,
    minValue,
  });
};

// ---------------------------------------------------------------------------
// Derived-metric helper
// ---------------------------------------------------------------------------

interface DerivedPathInput {
  supabase: Parameters<ToolHandler<GetTopCustomersInput>>[1]["supabase"];
  metric: TopCustomerMetric;
  year: number;
  periodType: "year" | "month";
  periodMonth: number;
  n: number;
  activeOnly: boolean;
  consultantCustomerIds: string[] | null;
  consultantId: string | null;
  consultantName: string | null;
  consultantCostCenter: string | null;
  minValue: number | null;
}

async function runDerivedPath(opts: DerivedPathInput) {
  const {
    supabase,
    metric,
    year,
    periodType,
    periodMonth,
    n,
    activeOnly,
    consultantCustomerIds,
    consultantId,
    consultantName,
    consultantCostCenter,
    minValue,
  } = opts;

  const selectClause =
    "customer_id, total_turnover, invoice_count, total_hours, contract_value, " +
    "customers!inner(id, name, fortnox_customer_number, fortnox_cost_center, status)";

  // We have to fetch every candidate to compute the ratio. Filter as
  // aggressively as we can at the DB:
  //   - non-zero hours (ratio is undefined otherwise)
  //   - non-zero turnover (ratio is zero, never top-N)
  //   - active customer (when activeOnly)
  //   - consultant scope (when set)
  const baseQuery = () => {
    let q = supabase
      .from("customer_kpis")
      .select(selectClause, { count: "exact" })
      .eq("period_type", periodType)
      .eq("period_year", year)
      .eq("period_month", periodMonth)
      .gt("total_hours", 0)
      .gt("total_turnover", 0);
    if (activeOnly) q = q.eq("customers.status", "active");
    return q;
  };

  let rows: KpiRow[] = [];
  let total = 0;

  if (consultantCustomerIds && consultantCustomerIds.length > 0) {
    // Chunk IN() to avoid URL bloat.
    for (const idChunk of chunkArray(
      consultantCustomerIds,
      CUSTOMER_ID_CHUNK,
    )) {
      const { data, error, count } = await baseQuery().in(
        "customer_id",
        idChunk,
      );
      if (error) return { error: error.message };
      rows.push(...((data ?? []) as unknown as KpiRow[]));
      // Each chunk's `count` is the chunk-scoped total; sum across chunks
      // to get the full pool size.
      total += count ?? 0;
    }
  } else {
    const { data, error, count } = await baseQuery();
    if (error) return { error: error.message };
    rows = (data ?? []) as unknown as KpiRow[];
    total = count ?? rows.length;
  }

  // Compute ratio, sort, slice.
  const withRatio = rows
    .map((row) => {
      const hours = Number(row.total_hours ?? 0);
      const turnover = Number(row.total_turnover ?? 0);
      const ratio = hours > 0 ? turnover / hours : 0;
      return { row, ratio };
    })
    .filter((r) => Number.isFinite(r.ratio) && r.ratio > 0)
    // Apply min_value AFTER the ratio is computed — the derived metric
    // doesn't exist as a column so we can't push the filter to the DB.
    .filter((r) => (minValue == null ? true : r.ratio >= minValue))
    .sort((a, b) => b.ratio - a.ratio);

  const topRatios = withRatio.slice(0, n);

  // Overlay supporting.contract_value with annualized truth — same reason
  // as the fast path: the ranking metric isn't contract_value, but the
  // supporting number shown should still be honest.
  const annualizedByCustomerId =
    await fetchAnnualizedContractValuesByCustomerId(
      supabase,
      topRatios.map(({ row }) => row.customer_id),
    );

  const ranked = topRatios.map(({ row, ratio }, index) =>
    formatRow(
      row,
      index,
      metric,
      ratio,
      annualizedByCustomerId.get(row.customer_id) ?? 0,
    ),
  );

  // Precomputed sum of the ranked slice — only meaningful for additive
  // metrics. Summing turnover_per_hour ratios is nonsense, so we skip it
  // there. The model should reach for `total_value_in_ranked` instead of
  // summing rows itself when it's present.
  const isAdditive = metric !== "turnover_per_hour";
  const totalValueInRanked = isAdditive
    ? ranked.reduce(
        (sum, row) =>
          sum + Number((row as { value?: number }).value ?? 0),
        0,
      )
    : null;

  return {
    metric,
    metric_label: METRIC_LABEL[metric],
    period: {
      year,
      month: periodType === "month" ? periodMonth : null,
      type: periodType,
    },
    scope: {
      consultant_id: consultantId,
      consultant_name: consultantName,
      consultant_cost_center: consultantCostCenter,
      active_only: activeOnly,
    },
    n,
    ranked,
    ...(totalValueInRanked != null
      ? { total_value_in_ranked: totalValueInRanked }
      : {}),
    total_count: total,
    source: "customer_kpis (precomputed rollup — matches reports dashboard)",
    notes:
      metric === "turnover_per_hour"
        ? [
            "Ratio computed as total_turnover ÷ total_hours per customer. " +
              "Customers with zero hours are excluded (ratio undefined).",
          ]
        : undefined,
  };
}

// ---------------------------------------------------------------------------
// Row formatter — flat shape, single value field so the model has one
// thing to read back ("rank N: Customer X — 1 234 567 kr").
// ---------------------------------------------------------------------------

function formatRow(
  row: KpiRow,
  index: number,
  metric: TopCustomerMetric,
  derivedValue?: number,
  /**
   * When provided, overrides the rollup's `contract_value` field with the
   * annualized truth (computed from contract_accruals). Pass when the
   * ranking metric isn't contract_value but we still want the supporting
   * column to reflect annualized SEK/år.
   */
  annualizedContractValueOverride?: number,
): Record<string, unknown> {
  // PostgREST may return the embedded join as an array of one (for !inner)
  // or a single object depending on the relationship cardinality detected.
  // Handle both shapes.
  const customer = Array.isArray(row.customers)
    ? row.customers[0] ?? null
    : row.customers;

  const turnover = Number(row.total_turnover ?? 0);
  const hours = Number(row.total_hours ?? 0);
  const contractValue =
    annualizedContractValueOverride != null
      ? annualizedContractValueOverride
      : Number(row.contract_value ?? 0);
  const invoiceCount = Number(row.invoice_count ?? 0);

  let value: number;
  switch (metric) {
    case "turnover":
      value = turnover;
      break;
    case "hours":
      value = hours;
      break;
    case "contract_value":
      value = contractValue;
      break;
    case "invoice_count":
      value = invoiceCount;
      break;
    case "turnover_per_hour":
      value = derivedValue ?? (hours > 0 ? turnover / hours : 0);
      break;
    default: {
      const _exhaustive: never = metric;
      void _exhaustive;
      value = 0;
    }
  }

  return {
    rank: index + 1,
    customer_id: row.customer_id,
    customer_name: customer?.name ?? null,
    fortnox_customer_number: customer?.fortnox_customer_number ?? null,
    fortnox_cost_center: customer?.fortnox_cost_center ?? null,
    value,
    // Also include the other supporting numbers so the model can speak
    // about the customer without needing a follow-up call. Cheap — five
    // floats × N rows.
    supporting: {
      total_turnover: turnover,
      total_hours: hours,
      contract_value: contractValue,
      invoice_count: invoiceCount,
      turnover_per_hour: hours > 0 ? turnover / hours : null,
    },
  };
}

// ---------------------------------------------------------------------------
// contract_value helper — reads `contract_accruals` directly and annualizes.
//
// Mirrors what the dashboard's `/reports` page does for its KPI card
// (annualizeContractTotal of total_ex_vat over period, filtered by
// is_active=true, summed per customer). Bypasses the broken customer_kpis
// rollup until the sync is repaired.
// ---------------------------------------------------------------------------

type CustomerScopeRow = {
  id: string;
  name: string;
  fortnox_customer_number: string | null;
  fortnox_cost_center: string | null;
  status: string | null;
};

type ContractAccrualRow = {
  fortnox_customer_number: string | null;
  total_ex_vat: number | null;
  period: string | null;
};

interface ContractValuePathInput {
  supabase: Parameters<ToolHandler<GetTopCustomersInput>>[1]["supabase"];
  n: number;
  minValue: number | null;
  activeOnly: boolean;
  consultantCustomerIds: string[] | null;
  consultantId: string | null;
  consultantName: string | null;
  consultantCostCenter: string | null;
  year: number;
  month: number | null;
}

async function runContractValuePath(opts: ContractValuePathInput) {
  const {
    supabase,
    n,
    minValue,
    activeOnly,
    consultantCustomerIds,
    consultantId,
    consultantName,
    consultantCostCenter,
    year,
    month,
  } = opts;

  // ---------------------------------------------------------------------------
  // Step 1 — resolve the customer scope (active filter + consultant scope).
  //
  // Paginated: real installations have >1000 active customers, which
  // PostgREST silently caps. Without drainPages the rest of the function
  // would only see the first 1000, hiding large-contract customers and
  // making the top-N ranking nonsensical.
  // ---------------------------------------------------------------------------
  const customersResult = await drainPages<CustomerScopeRow>(() => {
    let q = supabase
      .from("customers")
      .select("id, name, fortnox_customer_number, fortnox_cost_center, status");
    if (activeOnly) q = q.eq("status", "active");
    if (consultantCustomerIds && consultantCustomerIds.length > 0) {
      q = q.in("id", consultantCustomerIds);
    }
    return q;
  });

  if (customersResult.error) {
    return { error: customersResult.error };
  }

  const customers = customersResult.rows;
  const fortnoxNumbers = customers
    .map((c) => c.fortnox_customer_number)
    .filter((v): v is string => Boolean(v));

  const emptyResult = {
    metric: "contract_value" as const,
    metric_label: METRIC_LABEL.contract_value,
    period: {
      year,
      month: month ?? null,
      type: month != null ? "month" : "year",
    },
    scope: {
      consultant_id: consultantId,
      consultant_name: consultantName,
      consultant_cost_center: consultantCostCenter,
      active_only: activeOnly,
      min_value: minValue,
    },
    n,
    ranked: [] as Record<string, unknown>[],
    total_count: 0,
    source:
      "contract_accruals (live, sum of annualized active contracts per customer)",
    notes: [
      "contract_value is computed live from contract_accruals: SUM of " +
        "annualizeContractTotal(total_ex_vat, period) across is_active=true " +
        "contracts per customer. Period codes: '1' → ×12 (monthly), '3' → ×4 " +
        "(quarterly), else ×1 (annual).",
    ],
  };

  if (fortnoxNumbers.length === 0) return emptyResult;

  // ---------------------------------------------------------------------------
  // Step 2 — fetch active contract accruals for the scoped customers and sum
  // the annualized value per customer.
  //
  // Paginated AND chunked. The chunk size is small (100 customers per IN
  // list) AND each chunk is drained for all pages, because a chunk that
  // looks small can easily produce >1000 contract rows (5-10 contracts per
  // customer is common). Without pagination, multi-contract customers had
  // their totals silently truncated, sending them to the bottom of the
  // ranking and letting single-contract customers bubble into the top-N.
  // ---------------------------------------------------------------------------
  const sumsByFortnox = new Map<string, number>();
  for (const chunk of chunkArray(fortnoxNumbers, 100)) {
    const { rows, error } = await drainPages<ContractAccrualRow>(() =>
      supabase
        .from("contract_accruals")
        .select("fortnox_customer_number, total_ex_vat, period")
        .in("fortnox_customer_number", chunk)
        .eq("is_active", true),
    );
    if (error) return { error };

    for (const row of rows) {
      if (!row.fortnox_customer_number) continue;
      const annualized = annualizeContractTotal(row.total_ex_vat, row.period);
      const prev = sumsByFortnox.get(row.fortnox_customer_number) ?? 0;
      sumsByFortnox.set(row.fortnox_customer_number, prev + annualized);
    }
  }

  // ---------------------------------------------------------------------------
  // Step 3 — build the ranked list. Filter by min_value, sort, slice.
  // ---------------------------------------------------------------------------
  const allRanked = customers
    .map((c) => ({
      customer: c,
      annualizedContractValue: c.fortnox_customer_number
        ? sumsByFortnox.get(c.fortnox_customer_number) ?? 0
        : 0,
    }))
    .filter((entry) => entry.annualizedContractValue > 0);

  const filtered =
    minValue != null
      ? allRanked.filter(
          (entry) => entry.annualizedContractValue >= minValue,
        )
      : allRanked;

  filtered.sort(
    (a, b) => b.annualizedContractValue - a.annualizedContractValue,
  );

  const ranked = filtered.slice(0, n).map((entry, index) => ({
    rank: index + 1,
    customer_id: entry.customer.id,
    customer_name: entry.customer.name,
    fortnox_customer_number: entry.customer.fortnox_customer_number,
    fortnox_cost_center: entry.customer.fortnox_cost_center,
    value: entry.annualizedContractValue,
    // Same supporting shape as formatRow, but turnover/hours/invoice_count
    // aren't queried here — null signals "not loaded in this call" rather
    // than zero.
    supporting: {
      total_turnover: null,
      total_hours: null,
      contract_value: entry.annualizedContractValue,
      invoice_count: null,
      turnover_per_hour: null,
    },
  }));

  // Precomputed totals so the model doesn't sum the ranked rows in its
  // head. `total_value_in_ranked` is the sum of the slice the model sees;
  // `total_value_full_match_set` is the sum across the entire matched pool
  // (pre-slice), useful for "what's our total ARR for customers over X kr?"
  // questions where N caps the visible rows but the user wants the total
  // matched.
  const totalValueInRanked = ranked.reduce(
    (sum, row) => sum + (row.value ?? 0),
    0,
  );
  const totalValueFullMatchSet = filtered.reduce(
    (sum, entry) => sum + entry.annualizedContractValue,
    0,
  );

  return {
    ...emptyResult,
    ranked,
    total_value_in_ranked: totalValueInRanked,
    total_value_full_match_set: totalValueFullMatchSet,
    total_value_unit: "SEK/år",
    // total_count is the pool of customers with > 0 (and >= min_value if set)
    // contract value in scope. Lets the model say "13 of 68 customers
    // matched, showing 10".
    total_count: filtered.length,
  };
}
