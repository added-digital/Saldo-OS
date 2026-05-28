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
  // Fuzzy match confidence in [0, 1]. 1.0 means a substring match against
  // name, org_number, or fortnox_customer_number. Lower values come from
  // trigram word-similarity — useful for tolerating typos like
  // "kamecia bygg" → "Kamenica Bygg & Balkongteknik AB".
  score?: number;
};

type FuzzyRow = {
  id: string;
  name: string;
  org_number: string | null;
  fortnox_customer_number: string | null;
  status: string | null;
  score: number | null;
};

/**
 * Best-effort match against customers by name, org number, or Fortnox customer
 * number. Returns up to `limit` candidates so Claude can disambiguate (or pick
 * the only result outright). RLS on the customers table ensures the caller
 * only sees customers within their access scope.
 *
 * Uses the `search_customers_fuzzy` Postgres RPC for typo-tolerant matching
 * (trigram word_similarity). Falls back to plain substring ILIKE if the RPC
 * is not yet available (e.g. the migration hasn't been applied to the
 * current environment).
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

  // Ask the RPC for one extra row so we can tell the model when its slice
  // is partial. The RPC's own LIMIT enforces the upper bound on rows it
  // ranks; +1 is enough signal here.
  const rpcLimit = limit + 1;
  // Cast: the generated Supabase types haven't been regenerated since the
  // 00059_customers_fuzzy_search migration, so this RPC isn't in the
  // function registry yet. Re-run `supabase gen types` to remove the cast.
  const rpcResult = await (
    supabase.rpc as unknown as (
      fn: string,
      args: Record<string, unknown>,
    ) => Promise<{ data: FuzzyRow[] | null; error: { message: string } | null }>
  )("search_customers_fuzzy", { q: query, lim: rpcLimit });

  if (rpcResult.error) {
    // Most likely the migration hasn't been applied yet. Fall back to the
    // old substring query so the tool keeps working — just without typo
    // tolerance.
    return runSubstringFallback(supabase, query, limit, rpcResult.error.message);
  }

  const allRows = ((rpcResult.data ?? []) as unknown as FuzzyRow[]) ?? [];
  const sliced = allRows.slice(0, limit);
  const matches: CustomerMatch[] = sliced.map((row) => ({
    id: row.id,
    name: row.name,
    org_number: row.org_number,
    fortnox_customer_number: row.fortnox_customer_number,
    status: row.status,
    score: row.score ?? undefined,
  }));

  // The RPC was asked for `limit + 1`; if it returned more than `limit`,
  // we know the model is seeing a partial slice. We don't know the true
  // global total (no `count: "exact"` available on RPC calls without an
  // extra round-trip), so we report "at least N+1".
  const totalKnownGreaterThan = allRows.length > limit;
  const reportedTotal = totalKnownGreaterThan
    ? limit + 1
    : matches.length;

  return {
    query,
    match_count: matches.length,
    total_count: reportedTotal,
    matches,
    ...(totalKnownGreaterThan
      ? {
          _compacted: [
            {
              field: "matches",
              total_count: reportedTotal,
              shown_count: matches.length,
              note:
                "More matches exist — narrow the query or raise `limit` (max 20).",
            },
          ],
        }
      : {}),
  };
};

async function runSubstringFallback(
  supabase: Parameters<typeof resolveCustomer>[1]["supabase"],
  query: string,
  limit: number,
  rpcErrorMessage: string,
): Promise<ReturnType<typeof resolveCustomer> extends Promise<infer R> ? R : never> {
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
    return {
      error: `RPC failed (${rpcErrorMessage}); fallback also failed: ${error.message}`,
      matches: [],
    };
  }

  const rows = (data ?? []) as unknown as CustomerMatch[];
  const matches: CustomerMatch[] = rows.map((row) => ({
    id: row.id,
    name: row.name,
    org_number: row.org_number,
    fortnox_customer_number: row.fortnox_customer_number,
    status: row.status,
  }));

  const totalCount = count ?? matches.length;

  return {
    query,
    match_count: matches.length,
    total_count: totalCount,
    matches,
    note:
      "Fuzzy search unavailable in this environment — using substring fallback. Apply migration 00059_customers_fuzzy_search.sql to enable typo tolerance.",
    ...(totalCount > matches.length
      ? {
          _compacted: [
            {
              field: "matches",
              total_count: totalCount,
              shown_count: matches.length,
              note:
                "More matches exist — narrow the query or raise `limit` (max 20).",
            },
          ],
        }
      : {}),
  };
}
