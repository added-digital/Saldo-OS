import { filterAccessibleConsultants } from "./consultant-access";
import type { ToolHandler } from "./types";

/**
 * Per-consultant PERSONAL hours from `manager_time_kpis`.
 *
 * This is the counterpart to get_kpi_by_consultant. The two share a
 * naming scheme on purpose:
 *
 *   get_kpi_by_consultant         → PORTFOLIO data (customers under the
 *                                   consultant's cost center). Revenue +
 *                                   contracts + the hours that customers
 *                                   accrued, regardless of who logged them.
 *
 *   get_consultant_personal_hours → PERSONAL data (the hours each
 *                                   consultant has actually reported in
 *                                   Fortnox during the period). Revenue is
 *                                   intentionally NOT here — we don't have
 *                                   per-consultant revenue attribution.
 *
 * Storage: `manager_time_kpis` is keyed by
 * (manager_profile_id, customer_manager_profile_id, period_year, period_month)
 * — i.e. one bucket per "Klara's hours on customers owned by Anna in March".
 * For the per-consultant total we sum across all customer-manager buckets
 * for the requested period.
 *
 * Use this for questions like:
 *   - "Hur många timmar har Klara jobbat hittills?"
 *   - "Top 10 by personal hours this year"
 *   - "Compare Klara's logged hours to Derya's"
 *
 * Do NOT use for revenue rankings — fall back to get_kpi_by_consultant for
 * those, but call out that the figure is portfolio, not personal output.
 */

export type GetConsultantPersonalHoursInput = {
  year: number;
  month?: number | null;
  active_consultants_only?: boolean;
  limit?: number | null;
  sort_by?:
    | "total_hours"
    | "customer_hours"
    | "absence_hours"
    | "internal_hours"
    | "other_hours";
  /**
   * Optional restriction to specific consultants. When omitted, the tool
   * returns every consultant the caller can see. Pass an array of profile
   * UUIDs (from resolve_consultant).
   */
  consultant_ids?: string[];
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

type ManagerKpiRow = {
  manager_profile_id: string;
  period_year: number;
  period_month: number;
  total_hours: number | string | null;
  customer_hours: number | string | null;
  absence_hours: number | string | null;
  internal_hours: number | string | null;
  other_hours: number | string | null;
};

const HOUR_COLUMNS =
  "manager_profile_id, period_year, period_month, total_hours, " +
  "customer_hours, absence_hours, internal_hours, other_hours";

const ZERO_HOURS = () => ({
  total_hours: 0,
  customer_hours: 0,
  absence_hours: 0,
  internal_hours: 0,
  other_hours: 0,
});

function toNumber(value: number | string | null | undefined): number {
  if (value == null) return 0;
  const n = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(n) ? n : 0;
}

export const getConsultantPersonalHours: ToolHandler<
  GetConsultantPersonalHoursInput
> = async (input, { supabase, user }) => {
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
  const sortBy = input.sort_by ?? "total_hours";

  const DEFAULT_LIMIT = 30;
  const MAX_LIMIT = 200;
  const limitRaw = input.limit;
  const limit =
    typeof limitRaw === "number" && Number.isInteger(limitRaw) && limitRaw > 0
      ? Math.min(limitRaw, MAX_LIMIT)
      : DEFAULT_LIMIT;

  // -------------------------------------------------------------------------
  // 1. Load consultants in scope (mirrors get_kpi_by_consultant).
  // -------------------------------------------------------------------------
  let profileQuery = supabase
    .from("profiles")
    .select(
      "id, full_name, email, role, team_id, fortnox_cost_center, is_active",
    );
  if (activeConsultantsOnly) {
    profileQuery = profileQuery.eq("is_active", true);
  }
  if (input.consultant_ids && input.consultant_ids.length > 0) {
    profileQuery = profileQuery.in("id", input.consultant_ids);
  }
  const profileRes = await profileQuery;
  if (profileRes.error) {
    return { error: profileRes.error.message };
  }
  const rawProfiles = (profileRes.data ?? []) as unknown as ProfileRow[];
  const profiles = filterAccessibleConsultants(user, rawProfiles);
  const accessFilteredCount = rawProfiles.length - profiles.length;

  if (profiles.length === 0) {
    return {
      data_scope: "personal" as const,
      data_scope_note:
        "PERSONAL hours from manager_time_kpis — what each consultant " +
        "actually reported in Fortnox during the period.",
      period: { year, month: month ?? null, type: month != null ? "month" : "year" },
      scope: {
        active_consultants_only: activeConsultantsOnly,
        limit,
        sort_by: sortBy,
        consultants_in_scope: 0,
        ...(accessFilteredCount > 0
          ? {
              access_filtered_count: accessFilteredCount,
              access_filtered_note:
                "There are additional consultants in the firm that are outside your access scope.",
            }
          : {}),
      },
      consultants: [],
      totals: ZERO_HOURS(),
    };
  }

  const profileById = new Map<string, ProfileRow>();
  for (const p of profiles) profileById.set(p.id, p);

  // -------------------------------------------------------------------------
  // 2. Load manager_time_kpis rows for the period.
  //
  // RLS already scopes by `has_scope('customers')`; the per-row filter just
  // narrows to in-scope consultants so the in-memory aggregation stays tight.
  // -------------------------------------------------------------------------
  let kpiQuery = supabase
    .from("manager_time_kpis")
    .select(HOUR_COLUMNS)
    .eq("period_year", year)
    .in(
      "manager_profile_id",
      Array.from(profileById.keys()),
    );
  if (month != null) kpiQuery = kpiQuery.eq("period_month", month);

  const kpiRes = await kpiQuery;
  if (kpiRes.error) {
    return { error: kpiRes.error.message };
  }
  const rows = (kpiRes.data ?? []) as unknown as ManagerKpiRow[];

  // -------------------------------------------------------------------------
  // 3. Aggregate per consultant. Sum every customer-manager bucket so the
  // result is "Klara's total hours in March" regardless of which customer-
  // manager's customers she logged against.
  // -------------------------------------------------------------------------
  type Bucket = {
    consultant_id: string;
    name: string | null;
    email: string;
    role: string | null;
    team_id: string | null;
    fortnox_cost_center: string | null;
    totals: ReturnType<typeof ZERO_HOURS>;
  };

  const buckets = new Map<string, Bucket>();
  for (const profile of profiles) {
    buckets.set(profile.id, {
      consultant_id: profile.id,
      name: profile.full_name,
      email: profile.email,
      role: profile.role,
      team_id: profile.team_id,
      fortnox_cost_center: profile.fortnox_cost_center,
      totals: ZERO_HOURS(),
    });
  }

  const grandTotals = ZERO_HOURS();

  for (const row of rows) {
    const bucket = buckets.get(row.manager_profile_id);
    if (!bucket) continue;
    const total = toNumber(row.total_hours);
    const customer = toNumber(row.customer_hours);
    const absence = toNumber(row.absence_hours);
    const internal = toNumber(row.internal_hours);
    const other = toNumber(row.other_hours);

    bucket.totals.total_hours += total;
    bucket.totals.customer_hours += customer;
    bucket.totals.absence_hours += absence;
    bucket.totals.internal_hours += internal;
    bucket.totals.other_hours += other;

    grandTotals.total_hours += total;
    grandTotals.customer_hours += customer;
    grandTotals.absence_hours += absence;
    grandTotals.internal_hours += internal;
    grandTotals.other_hours += other;
  }

  let consultantList = Array.from(buckets.values());
  consultantList.sort((a, b) => b.totals[sortBy] - a.totals[sortBy]);

  const totalConsultants = consultantList.length;
  if (consultantList.length > limit) {
    consultantList = consultantList.slice(0, limit);
  }

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
    data_scope: "personal" as const,
    data_scope_note:
      "PERSONAL hours — what each consultant actually reported in Fortnox " +
      "during the period. NOT a sum of their portfolio. Revenue is not " +
      "available here (no per-consultant revenue attribution exists). For " +
      "portfolio numbers (turnover, contract value, etc.) use " +
      "get_kpi_by_consultant.",
    period: {
      year,
      month: month ?? null,
      type: month != null ? "month" : "year",
    },
    scope: {
      active_consultants_only: activeConsultantsOnly,
      limit,
      sort_by: sortBy,
      consultants_in_scope: profiles.length,
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
      "data_scope=personal — hours come from manager_time_kpis (per-" +
        "consultant time reports). When answering, label these as 'personal' " +
        "/ 'rapporterade timmar', not portfolio hours.",
      "Hour buckets: customer_hours = billable customer time, " +
        "absence_hours = vacation/sick/parental, internal_hours = time " +
        "logged against the firm's own internal customer, other_hours = " +
        "everything else.",
    ],
    source:
      "manager_time_kpis (nightly sync from Fortnox time reports). Same source the per-manager rollup uses on the reports dashboard.",
  };
};
