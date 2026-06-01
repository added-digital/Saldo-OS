import type { ToolHandler } from "./types";

export type GetChurnedCustomersInput = {
  /** Earlier / baseline window start (YYYY-MM-DD). */
  period1_start: string;
  /** Earlier / baseline window end (YYYY-MM-DD). */
  period1_end: string;
  /** Later / comparison window start (YYYY-MM-DD). */
  period2_start: string;
  /** Later / comparison window end (YYYY-MM-DD). */
  period2_end: string;
};

/** One row as returned by the `get_churned_customers` Postgres function. */
type ChurnedCustomerRow = {
  customer_name: string;
  total_revenue_period1: number;
  last_invoice_date: string | null;
};

// The DB function caps its result at this many rows (ORDER BY revenue DESC).
const ROW_CAP = 200;

// YYYY-MM-DD, calendar-validated just enough to catch obvious garbage before
// it reaches Postgres (where a bad date would otherwise throw mid-query).
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime());
}

/**
 * Drill-down companion to get_churn_analysis. Returns the ACTUAL list of
 * churned customers (had revenue in period1 but not period2) — name, their
 * period1 ex-VAT revenue, and their last invoice date within period1 — instead
 * of just the count. Same windows, same churn definition, same RLS scope.
 *
 * Use the SAME four dates here as the get_churn_analysis call that produced the
 * count, so the list reconciles with the headline number.
 */
export const getChurnedCustomers: ToolHandler<GetChurnedCustomersInput> = async (
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
  // empty period and a misleading churned list.
  if (period1_start > period1_end) {
    return { error: "period1_start must be on or before period1_end." };
  }
  if (period2_start > period2_end) {
    return { error: "period2_start must be on or before period2_end." };
  }

  // Cast: the generated Supabase types haven't been regenerated since the
  // 00062_get_churned_customers migration, so this RPC isn't in the function
  // registry type yet. Re-run `supabase gen types` to remove the cast.
  const { data, error } = await (
    supabase.rpc as unknown as (
      fn: string,
      args: Record<string, unknown>,
    ) => Promise<{
      data: ChurnedCustomerRow[] | null;
      error: { message: string } | null;
    }>
  )("get_churned_customers", {
    period1_start,
    period1_end,
    period2_start,
    period2_end,
  });

  if (error) {
    return { error: error.message };
  }

  const customers = (data ?? []) as ChurnedCustomerRow[];
  const capped = customers.length >= ROW_CAP;

  return {
    period1: { start: period1_start, end: period1_end },
    period2: { start: period2_start, end: period2_end },
    count: customers.length,
    currency: "SEK",
    revenue_basis: "ex_vat",
    revenue_window: "period1",
    churned_customers: customers,
    ...(capped
      ? {
          _compacted: [
            {
              field: "churned_customers",
              shown_count: customers.length,
              note: `List capped at ${ROW_CAP} churned customers (highest period1 revenue first); more may exist. Use get_churn_analysis for the exact total churned count.`,
            },
          ],
        }
      : {}),
  };
};
