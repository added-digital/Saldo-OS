import { chunkArray } from "@/lib/reports";

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
  contract_value: "Avtalsvärde (kr)",
  hours: "Timmar",
  invoice_count: "Antal fakturor",
};

export const getTopCustomers: ToolHandler<GetTopCustomersInput> = async (
  input,
  { supabase },
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
      .select("id, full_name, fortnox_cost_center")
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
      fortnox_cost_center: string | null;
    };
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
        });
      }
    }

    const { data, error, count } = await query;
    if (error) return { error: error.message };

    const ranked = ((data ?? []) as unknown as KpiRow[]).map((row, index) =>
      formatRow(row, index, metric),
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
      // total_count is the pool of customers with > 0 on this metric for the
      // period. Lets the model say "showing 10 of 47 customers with revenue
      // this period" rather than implying these are the ONLY customers.
      total_count: count ?? ranked.length,
      source: "customer_kpis (precomputed rollup — matches reports dashboard)",
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
    .sort((a, b) => b.ratio - a.ratio);

  const ranked = withRatio
    .slice(0, n)
    .map(({ row, ratio }, index) => formatRow(row, index, metric, ratio));

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
): Record<string, unknown> {
  // PostgREST may return the embedded join as an array of one (for !inner)
  // or a single object depending on the relationship cardinality detected.
  // Handle both shapes.
  const customer = Array.isArray(row.customers)
    ? row.customers[0] ?? null
    : row.customers;

  const turnover = Number(row.total_turnover ?? 0);
  const hours = Number(row.total_hours ?? 0);
  const contractValue = Number(row.contract_value ?? 0);
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
