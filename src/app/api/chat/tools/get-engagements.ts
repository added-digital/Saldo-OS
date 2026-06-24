import type { ToolHandler } from "./types";

export type GetEngagementsInput = {
  workflow?: "bokslut" | "ink2";
  consultant?: string;
  group?: string;
  fiscal_year?: string;
  status?: string;
  only_overdue?: boolean;
  include_cleared?: boolean;
  limit?: number;
};

type BoardRow = {
  customer_name: string;
  org_number: string | null;
  fiscal_year_end: string;
  consultant_name: string | null;
  co_consultant_name: string | null;
  group_name: string | null;
  bokslut_status_label: string | null;
  ink2_status_label: string | null;
  deadline: string | null;
  is_overdue: boolean;
  bokslut_cleared_at: string | null;
  ink2_cleared_at: string | null;
};

const norm = (s?: string | null) => (s ?? "").toLowerCase().trim();

/**
 * Query the year-end close (Bokslut) board. Reads the engagement_board view —
 * which is RLS-scoped (has_scope('customers')) and runs as the calling user, so
 * the tool only ever sees engagements the user is allowed to. Aggregates server
 * side and returns counts + a capped sample so the model pays few tokens.
 */
export const getEngagements: ToolHandler<GetEngagementsInput> = async (
  input,
  { supabase },
) => {
  const workflow = input.workflow === "ink2" ? "ink2" : "bokslut";
  const includeCleared = input.include_cleared ?? false;
  const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);

  const clearedField = workflow === "ink2" ? "ink2_cleared_at" : "bokslut_cleared_at";
  let query = supabase
    .from("engagement_board")
    .select(
      "customer_name, org_number, fiscal_year_end, consultant_name, co_consultant_name, group_name, bokslut_status_label, ink2_status_label, deadline, is_overdue, bokslut_cleared_at, ink2_cleared_at",
    );
  if (!includeCleared) query = query.is(clearedField, null);

  const { data, error } = await query.limit(5000);
  if (error) return { error: error.message };

  let rows = (data ?? []) as unknown as BoardRow[];
  const statusOf = (r: BoardRow) =>
    workflow === "bokslut" ? r.bokslut_status_label : r.ink2_status_label;

  if (input.consultant) {
    const q = norm(input.consultant);
    rows = rows.filter(
      (r) => norm(r.consultant_name).includes(q) || norm(r.co_consultant_name).includes(q),
    );
  }
  if (input.group) {
    const q = norm(input.group);
    rows = rows.filter((r) => norm(r.group_name).includes(q));
  }
  if (input.fiscal_year) {
    const q = input.fiscal_year.trim();
    rows = rows.filter((r) => (r.fiscal_year_end ?? "").startsWith(q));
  }
  if (input.status) {
    const q = norm(input.status);
    rows = rows.filter((r) => norm(statusOf(r)).includes(q));
  }
  if (input.only_overdue) {
    rows = rows.filter((r) => r.is_overdue);
  }

  // Status breakdown for the active workflow ("No status" for unset).
  const breakdown = new Map<string, number>();
  for (const r of rows) {
    const label = statusOf(r) ?? "No status";
    breakdown.set(label, (breakdown.get(label) ?? 0) + 1);
  }

  const overdueCount = rows.filter((r) => r.is_overdue).length;
  const sample = rows.slice(0, limit).map((r) => ({
    customer: r.customer_name,
    org_number: r.org_number,
    fiscal_year_end: r.fiscal_year_end,
    status: statusOf(r),
    consultant: r.consultant_name,
    co_consultant: r.co_consultant_name,
    group: r.group_name,
    deadline: r.deadline,
    overdue: r.is_overdue,
  }));

  return {
    workflow,
    total: rows.length,
    overdue_count: overdueCount,
    status_breakdown: Array.from(breakdown, ([status, count]) => ({ status, count })).sort(
      (a, b) => b.count - a.count,
    ),
    showing: sample.length,
    engagements: sample,
    note:
      rows.length > sample.length
        ? `Showing ${sample.length} of ${rows.length}. Narrow with filters or raise limit (max 100).`
        : undefined,
  };
};
