import {
  accessRestricted,
  canAccessConsultant,
} from "./consultant-access";
import type { ToolHandler } from "./types";

export type GetCostCenterDetailsInput = {
  code: string;
  customer_limit?: number;
};

type CostCenterRow = {
  id: string;
  code: string;
  name: string | null;
  active: boolean;
};

type CustomerRow = {
  id: string;
  name: string;
  fortnox_customer_number: string | null;
  status: string | null;
  total_turnover: number | null;
};

type ProfileRow = {
  id: string;
  full_name: string | null;
  email: string;
  role: string | null;
  team_id: string | null;
};

/**
 * Detailed view of a single cost center: the centre record plus all customers
 * and consultants assigned to it. Customers can be paginated via
 * `customer_limit` (default 50); set higher when the caller is asking for the
 * full list. Consultants are returned in full — there are far fewer of them.
 */
export const getCostCenterDetails: ToolHandler<GetCostCenterDetailsInput> = async (
  input,
  { supabase, user },
) => {
  const code = input.code?.trim();
  if (!code) {
    return { error: "code is required." };
  }

  const customerLimit = Math.min(Math.max(input.customer_limit ?? 50, 1), 500);

  const [centerRes, customersRes, profilesRes] = await Promise.all([
    supabase
      .from("cost_centers")
      .select("id, code, name, active")
      .eq("code", code)
      .maybeSingle(),
    supabase
      .from("customers")
      .select("id, name, fortnox_customer_number, status, total_turnover")
      .eq("fortnox_cost_center", code)
      .order("name", { ascending: true })
      .limit(customerLimit),
    supabase
      .from("profiles")
      .select("id, full_name, email, role, team_id")
      .eq("fortnox_cost_center", code)
      .order("full_name", { ascending: true }),
  ]);

  if (centerRes.error || !centerRes.data) {
    return {
      error: centerRes.error?.message ?? `Cost center not found: ${code}`,
    };
  }

  const center = centerRes.data as unknown as CostCenterRow;
  const customers = (customersRes.data ?? []) as unknown as CustomerRow[];
  const consultants = (profilesRes.data ?? []) as unknown as ProfileRow[];

  // Role-based scoping: refuse if no consultant in this cost center is
  // visible to the caller. The cost center may exist and be active, but
  // it belongs to another team and we don't surface its customers /
  // consultants / KPIs. Mirrors the access bar on resolve_consultant +
  // get_consultant_customers so the model can't enumerate cost centers
  // to derive other consultants' turnover.
  const accessibleConsultants = consultants.filter((c) =>
    canAccessConsultant(user, { id: c.id, team_id: c.team_id }),
  );
  if (accessibleConsultants.length === 0 && consultants.length > 0) {
    return accessRestricted(
      "You don't have permission to view this cost center's customers, consultants, or KPIs.",
    );
  }

  // Edge case: cost center has zero consultants assigned. Allow the model
  // to see the bare center record (it's not consultant-personal data),
  // but don't leak customer-level turnover.
  if (consultants.length === 0) {
    return {
      cost_center: center,
      customer_count: 0,
      customers: [],
      consultant_count: 0,
      consultants: [],
      note: "Cost center exists but has no consultants assigned.",
    };
  }

  return {
    cost_center: center,
    customer_count: customers.length,
    customers,
    consultant_count: accessibleConsultants.length,
    consultants: accessibleConsultants,
  };
};
