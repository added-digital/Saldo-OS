import {
  accessRestricted,
  canAccessConsultant,
} from "./consultant-access";
import { fetchAnnualizedContractValuesByCustomerId } from "./contract-values";
import type { ToolHandler } from "./types";

export type GetConsultantCustomersInput = {
  consultant_id: string;
  active_only?: boolean;
  limit?: number;
};

type ProfileRow = {
  id: string;
  full_name: string | null;
  email: string;
  team_id: string | null;
  fortnox_cost_center: string | null;
};

type CustomerRow = {
  id: string;
  name: string;
  fortnox_customer_number: string | null;
  status: string | null;
  total_turnover: number | null;
  contract_value: number | null;
};

/**
 * Return all customers that share a consultant's Fortnox cost center — i.e.
 * the consultant's portfolio. Customers in this CRM aren't linked to managers
 * via a direct FK; the relationship runs through `fortnox_cost_center`
 * matching on both `profiles` and `customers`. If the consultant has no cost
 * center set, the result is an empty list with a note.
 */
export const getConsultantCustomers: ToolHandler<GetConsultantCustomersInput> = async (
  input,
  { supabase, user },
) => {
  const consultantId = input.consultant_id?.trim();
  if (!consultantId) {
    return { error: "consultant_id is required." };
  }

  const activeOnly = input.active_only ?? true;
  // Default 30 keeps the JSON small (this result is re-sent on every loop
  // iteration). Callers can override up to a hard ceiling of 200.
  const limit = Math.min(Math.max(input.limit ?? 30, 1), 200);

  const profileRes = await supabase
    .from("profiles")
    .select("id, full_name, email, team_id, fortnox_cost_center")
    .eq("id", consultantId)
    .maybeSingle();

  if (profileRes.error || !profileRes.data) {
    return {
      error: profileRes.error?.message ?? "Consultant not found.",
    };
  }

  const consultant = profileRes.data as unknown as ProfileRow;

  // Role-based scope: refuse outright if the caller isn't allowed to see
  // this consultant's portfolio. The error_type is recognized by the
  // system prompt — the model will tell the user they don't have access
  // rather than retrying or fabricating.
  if (!canAccessConsultant(user, consultant)) {
    return accessRestricted(
      "You don't have permission to view this consultant's customer portfolio.",
    );
  }

  const costCenter = consultant.fortnox_cost_center?.trim() ?? null;

  if (!costCenter) {
    return {
      consultant,
      cost_center: null,
      customer_count: 0,
      customers: [],
      note:
        "Consultant has no fortnox_cost_center set, so no portfolio can be " +
        "derived from cost center matching.",
    };
  }

  let customerQuery = supabase
    .from("customers")
    .select(
      "id, name, fortnox_customer_number, status, total_turnover, contract_value",
    )
    .eq("fortnox_cost_center", costCenter)
    .order("name", { ascending: true })
    .limit(limit);

  if (activeOnly) {
    customerQuery = customerQuery.eq("status", "active");
  }

  const { data, error } = await customerQuery;

  if (error) {
    return { error: error.message, customers: [] };
  }

  const customersRaw = (data ?? []) as unknown as CustomerRow[];

  // Overlay contract_value with the annualized truth from contract_accruals.
  // The denormalized `customers.contract_value` column is populated by the
  // same broken sync as customer_kpis — see the contract-value bug.
  const annualizedByCustomerId =
    await fetchAnnualizedContractValuesByCustomerId(
      supabase,
      customersRaw.map((c) => c.id),
    );
  const customers = customersRaw.map((c) => ({
    ...c,
    contract_value: annualizedByCustomerId.get(c.id) ?? 0,
    contract_value_unit: "SEK/år",
  }));

  // We fetched up to `limit` rows. If we got exactly that many, there may be
  // more — surface this with the same `_compacted` shape the route compactor
  // and other tools use so the model can say "showing first 30, ask for more
  // if needed".
  const hitLimit = customers.length === limit;

  return {
    consultant,
    cost_center: costCenter,
    customer_count: customers.length,
    active_only: activeOnly,
    customers,
    ...(hitLimit
      ? {
          _compacted: [
            {
              field: "customers",
              total_count: null,
              shown_count: customers.length,
              note: "Result reached the requested limit; there may be more — call again with a higher `limit` (max 200) if a full list is needed.",
            },
          ],
        }
      : {}),
  };
};
