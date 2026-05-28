/**
 * Role-based access control for consultant-scoped chat tools.
 *
 * Database RLS gates app-level access with the coarse `has_scope('customers')`
 * policy — anyone with that scope can read every consultant's KPI / portfolio
 * data. The dashboard UI imposes finer team-based scoping on top of that for
 * the reports page, but the chat tools historically bypassed that UI layer
 * and inherited only the RLS scoping, which let a `user` or `team_lead`
 * ask the chat about consultants outside their team.
 *
 * These helpers add a per-tool check that mirrors the dashboard's scoping:
 *
 *   - admin       → any consultant
 *   - team_lead   → consultants on the same team, OR self
 *   - user        → only self
 *
 * Tools have two ways to apply it:
 *
 *   1. `filterAccessibleConsultants` — for tools that return a LIST of
 *      consultants (resolve_consultant, get_kpi_by_consultant). Filter the
 *      list quietly; out-of-scope consultants just don't appear.
 *
 *   2. `canAccessConsultant` + `accessRestricted` — for tools that take a
 *      single `consultant_id` and would otherwise return that consultant's
 *      data outright (get_consultant_customers, get_top_customers with a
 *      consultant_id). Refuse explicitly with error_type="access_restricted"
 *      so the model surfaces a clean message to the user (the system prompt
 *      already handles this error_type).
 */

import type { ToolContext } from "./types";

export type ConsultantAccessInfo = {
  id: string;
  team_id: string | null;
};

/**
 * Single-consultant access check.
 *
 * Returns true if the calling user is permitted to see KPI / portfolio /
 * personal data about the given consultant.
 */
export function canAccessConsultant(
  user: ToolContext["user"],
  consultant: ConsultantAccessInfo,
): boolean {
  if (user.role === "admin") return true;
  // Always allow self-introspection regardless of team.
  if (consultant.id === user.id) return true;
  if (user.role === "team_lead") {
    return user.team_id != null && consultant.team_id === user.team_id;
  }
  // role === "user" (or any unknown role) → only self, already handled above.
  return false;
}

/**
 * Filter a list of consultant-shaped records down to those the caller may
 * see. The records must carry `id` and `team_id`. Returns the same list
 * untouched for admins.
 */
export function filterAccessibleConsultants<T extends ConsultantAccessInfo>(
  user: ToolContext["user"],
  consultants: T[],
): T[] {
  if (user.role === "admin") return consultants;
  return consultants.filter((c) => canAccessConsultant(user, c));
}

/**
 * Standard refusal payload that matches `error_type: "access_restricted"`
 * — the system prompt already instructs the model to STOP and tell the
 * user they don't have access (and suggest asking an admin).
 */
export function accessRestricted(detail?: string) {
  return {
    error:
      detail ??
      "You don't have permission to view that consultant's data.",
    error_type: "access_restricted" as const,
  };
}
