import { filterAccessibleConsultants } from "./consultant-access";
import type { ToolHandler } from "./types";

export type ResolveConsultantInput = {
  query: string;
  limit?: number;
};

type ConsultantMatch = {
  id: string;
  full_name: string | null;
  email: string;
  role: string | null;
  team_id: string | null;
  fortnox_cost_center: string | null;
  is_active: boolean;
};

/**
 * Best-effort match against profiles (consultants/employees) by full name or
 * email. Returns up to `limit` candidates so Claude can disambiguate before
 * calling tools that need a specific consultant_id (UUID). Includes the
 * consultant's fortnox_cost_center so callers can chain into
 * get_consultant_customers without re-fetching.
 */
export const resolveConsultant: ToolHandler<ResolveConsultantInput> = async (
  input,
  { supabase, user },
) => {
  const query = input.query.trim();
  if (!query) {
    return { matches: [], note: "Empty query." };
  }

  const limit = Math.min(Math.max(input.limit ?? 5, 1), 20);
  const escaped = query.replace(/[%_]/g, (match) => `\\${match}`);
  const pattern = `%${escaped}%`;

  const { data, error, count } = await supabase
    .from("profiles")
    .select(
      "id, full_name, email, role, team_id, fortnox_cost_center, is_active",
      { count: "exact" },
    )
    .or([`full_name.ilike.${pattern}`, `email.ilike.${pattern}`].join(","))
    .order("full_name", { ascending: true })
    .limit(limit);

  if (error) {
    return { error: error.message, matches: [] };
  }

  const rawMatches = (data ?? []) as unknown as ConsultantMatch[];
  // Apply role-based scoping: a user only sees themselves, a team_lead
  // sees same-team consultants (plus self), admins see everyone.
  const matches = filterAccessibleConsultants(user, rawMatches);
  // When the ILIKE found a name but the access filter dropped it, surface
  // the COUNT (not the names) so the model can tell the user that the
  // consultant exists but is outside their scope — rather than the
  // misleading "I can't find that person." We do not expose ids, names,
  // or emails of the filtered consultants.
  const accessFilteredCount = rawMatches.length - matches.length;
  // We've only filtered what we fetched. If the DB had more rows beyond
  // the fetch limit, we can't know how many of THOSE are in-scope without
  // re-querying with a team filter — so we report the observed in-scope
  // count and hint that more may exist when the fetch saturated.
  const fetchedHitLimit =
    rawMatches.length === limit && (count ?? 0) > limit;

  return {
    query,
    match_count: matches.length,
    total_count: matches.length,
    matches,
    ...(accessFilteredCount > 0
      ? {
          access_filtered_count: accessFilteredCount,
          access_filtered_note:
            "One or more consultants matched the search but are outside your access scope. They exist; you don't have permission to view their data.",
        }
      : {}),
    ...(fetchedHitLimit
      ? {
          _compacted: [
            {
              field: "matches",
              total_count: null,
              shown_count: matches.length,
              note: "Result was capped at the fetch limit; more in-scope matches may exist. Narrow the query or raise `limit` (max 20).",
            },
          ],
        }
      : {}),
  };
};
