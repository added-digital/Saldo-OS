import type { ToolHandler } from "./types";

export type ResolveCustomerInput = {
  query: string;
  limit?: number;
};

type CustomerMatch = {
  id: string;
  name: string;
  org_number: string | null;
  fortnox_customer_number: string | null;
  status: string | null;
};

/**
 * Best-effort match against customers by name, org number, or Fortnox customer
 * number. Returns up to `limit` candidates so Claude can disambiguate (or pick
 * the only result outright). RLS on the customers table ensures the caller
 * only sees customers within their access scope.
 */
export const resolveCustomer: ToolHandler<ResolveCustomerInput> = async (
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
    .from("customers")
    .select("id, name, org_number, fortnox_customer_number, status", {
      count: "exact",
    })
    .or(
      [
        `name.ilike.${pattern}`,
        `org_number.ilike.${pattern}`,
        `fortnox_customer_number.ilike.${pattern}`,
      ].join(","),
    )
    .order("name", { ascending: true })
    .limit(limit);

  if (error) {
    return { error: error.message, matches: [] };
  }

  const rows = (data ?? []) as unknown as CustomerMatch[];
  const matches: CustomerMatch[] = rows.map((row) => ({
    id: row.id,
    name: row.name,
    org_number: row.org_number,
    fortnox_customer_number: row.fortnox_customer_number,
    status: row.status,
  }));

  // total_count is the full match count ignoring `limit`. Lets the model
  // tell the user "found 47 matches, showing 5" and ask whether to narrow
  // the query, rather than silently presenting a slice as the whole truth.
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
