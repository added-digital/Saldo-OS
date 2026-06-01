import type { ToolHandler } from "./types";

export type GetChurnAnalysisInput = {
  /** Earlier / baseline window start (YYYY-MM-DD). */
  period1_start: string;
  /** Earlier / baseline window end (YYYY-MM-DD). */
  period1_end: string;
  /** Later / comparison window start (YYYY-MM-DD). */
  period2_start: string;
  /** Later / comparison window end (YYYY-MM-DD). */
  period2_end: string;
};

/**
 * Shape returned by the `get_churn_analysis` Postgres function. All work
 * (set logic + revenue sums) happens in the database; this is just the
 * aggregate envelope the model reads back.
 */
type ChurnAnalysisResult = {
  churned: number;
  new_customers: number;
  retained: number;
  churn_rate: number;
  total_period1: number;
  total_period2: number;
  period1: { start: string; end: string; active_customers: number };
  period2: { start: string; end: string; active_customers: number };
  currency: string;
  revenue_basis: string;
};

// YYYY-MM-DD, calendar-validated just enough to catch obvious garbage before
// it reaches Postgres (where a bad date would otherwise throw mid-query).
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime());
}

/**
 * Churn / retention between two date windows. Thin wrapper over the
 * `get_churn_analysis` RPC: it validates the four dates and passes them
 * straight through to the database function, which returns aggregate counts
 * and revenue totals only — never a customer list. This is the ONLY correct
 * path for churn/retention/new-customer questions; do not reconstruct churn by
 * fetching customer lists into context.
 *
 * RLS-aware: the function is SECURITY INVOKER, so the JWT-scoped client here
 * means the caller only sees churn over invoices they're allowed to read.
 */
export const getChurnAnalysis: ToolHandler<GetChurnAnalysisInput> = async (
  input,
  { supabase },
) => {
  const { period1_start, period1_end, period2_start, period2_end } = input;

  const fields: Array<[string, unknown]> = [
    ["period1_start", period1_start],
    ["period1_end", period1_end],
    ["period2_start", period2_start],
    ["period2_end", period2_end],
  ];
  const invalid = fields.filter(([, v]) => !validDate(v)).map(([k]) => k);
  if (invalid.length > 0) {
    return {
      error: `Invalid or missing date(s): ${invalid.join(", ")}. Each must be a real calendar date in YYYY-MM-DD format.`,
    };
  }

  // Guard against inverted windows — a start after its end yields a silently
  // empty period and a misleading 0% churn rate.
  if (period1_start > period1_end) {
    return { error: "period1_start must be on or before period1_end." };
  }
  if (period2_start > period2_end) {
    return { error: "period2_start must be on or before period2_end." };
  }

  // Cast: the generated Supabase types haven't been regenerated since the
  // 00061_get_churn_analysis migration, so this RPC isn't in the function
  // registry type yet. Re-run `supabase gen types` to remove the cast.
  const { data, error } = await (
    supabase.rpc as unknown as (
      fn: string,
      args: Record<string, unknown>,
    ) => Promise<{ data: ChurnAnalysisResult | null; error: { message: string } | null }>
  )("get_churn_analysis", {
    period1_start,
    period1_end,
    period2_start,
    period2_end,
  });

  if (error) {
    return { error: error.message };
  }

  if (!data) {
    return { error: "Churn analysis returned no result." };
  }

  return data;
};
