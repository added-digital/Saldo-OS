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
  { supabase },
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

  const matches = (data ?? []) as unknown as ConsultantMatch[];
  // Total ignoring `limit` so the model knows when its slice is partial.
  const totalCount = count ?? matches.length;

  return {
    query,
    match_count: matches.length,
    total_count: totalCount,
    matches,
    ...(totalCount > matches.length
      ? {
          _compacted: [
            {
              field: "matches",
              total_count: totalCount,
              shown_count: matches.length,
              note: "More matches exist — narrow the query or raise `limit` (max 20).",
            },
          ],
        }
      : {}),
  };
};
