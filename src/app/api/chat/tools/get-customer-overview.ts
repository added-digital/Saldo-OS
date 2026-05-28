import { annualizeContractTotal } from "@/lib/reports";

import { fetchAnnualizedContractValuesByCustomerId } from "./contract-values";
import type { ToolHandler } from "./types";

export type GetCustomerOverviewInput = {
  customer_id: string;
};

/**
 * Compact customer dossier. Returns the customer record, the latest available
 * monthly customer_kpi row, the count of active contracts, and a peek at
 * recent activities. Designed to be the "first call" for any customer-scoped
 * question — Claude can decide if it needs to drill in further.
 */
export const getCustomerOverview: ToolHandler<GetCustomerOverviewInput> = async (
  input,
  { supabase },
) => {
  const customerId = input.customer_id?.trim();
  if (!customerId) {
    return { error: "customer_id is required." };
  }

  const customerRes = await supabase
    .from("customers")
    .select(
      "id, name, org_number, fortnox_customer_number, status, industry, " +
        "office, start_date, total_turnover, invoice_count, total_hours, " +
        "contract_value, fortnox_active",
    )
    .eq("id", customerId)
    .maybeSingle();

  if (customerRes.error || !customerRes.data) {
    return {
      error: customerRes.error?.message ?? "Customer not found.",
    };
  }

  const customer = customerRes.data as unknown as {
    id: string;
    name: string;
    org_number: string | null;
    fortnox_customer_number: string | null;
    status: string | null;
    industry: string | null;
    office: string | null;
    start_date: string | null;
    total_turnover: number | null;
    invoice_count: number | null;
    total_hours: number | null;
    contract_value: number | null;
    fortnox_active: boolean | null;
  };
  const fortnoxCustomerNumber = customer.fortnox_customer_number;

  const [kpiRes, activitiesRes, contractsRes, contactLinksRes] =
    await Promise.all([
      supabase
        .from("customer_kpis")
        .select(
          "period_type, period_year, period_month, total_turnover, invoice_count, " +
            "total_hours, customer_hours, absence_hours, internal_hours, " +
            "other_hours, contract_value",
        )
        .eq("customer_id", customerId)
        .eq("period_type", "month")
        .order("period_year", { ascending: false })
        .order("period_month", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("customer_activities")
        .select("id, activity_type, date, description, created_at")
        .eq("customer_id", customerId)
        .order("date", { ascending: false })
        .limit(5),
      fortnoxCustomerNumber
        ? supabase
            .from("contract_accruals")
            .select("id, contract_number, total_ex_vat, period, end_date", {
              count: "exact",
            })
            .eq("is_active", true)
            .eq("fortnox_customer_number", fortnoxCustomerNumber)
        : Promise.resolve({ data: [], count: 0, error: null }),
      // Contacts via the link table. Order primary first so the model can
      // grab `primary_contact` from index 0 (with an explicit primary_contact
      // field also surfaced below for clarity).
      supabase
        .from("customer_contact_links")
        .select(
          "is_primary, relationship_label, " +
            "contact:customer_contacts ( " +
            "id, name, first_name, last_name, role, email, phone, linkedin " +
            ")",
        )
        .eq("customer_id", customerId)
        .order("is_primary", { ascending: false })
        .limit(10),
    ]);

  // Replace the rollup-sourced contract_value on `customer` (denormalized
  // column populated by the broken sync) with the annualized truth from
  // contract_accruals.
  const annualizedByCustomerId =
    await fetchAnnualizedContractValuesByCustomerId(supabase, [customerId]);
  const annualizedContractValue =
    annualizedByCustomerId.get(customerId) ?? 0;
  const customerWithTruth = {
    ...customer,
    contract_value: annualizedContractValue,
    contract_value_unit: "SEK/år (annualized from active contracts)",
  };

  // Same fix for the latest monthly KPI snapshot — the contract_value field
  // there comes from the same rollup. The other KPI fields (turnover,
  // hours, etc.) are flow metrics and stay as-is.
  const rawLatestKpi = kpiRes.data as
    | (Record<string, unknown> & { contract_value?: number | null })
    | null;
  const latestMonthlyKpi = rawLatestKpi
    ? {
        ...rawLatestKpi,
        contract_value: annualizedContractValue,
        contract_value_unit: "SEK/år (overlaid from contract_accruals)",
      }
    : null;

  // Annotate each contract sample row with its annualized value so the
  // model sees per-contract SEK/år alongside the raw total_ex_vat.
  type ContractSampleRow = {
    id: string;
    contract_number: string;
    total_ex_vat: number | null;
    period: string | null;
    end_date: string | null;
  };
  const contractsSample = (
    ((contractsRes.data ?? []) as unknown as ContractSampleRow[]).slice(0, 5)
  ).map((row) => ({
    ...row,
    annualized_value: annualizeContractTotal(row.total_ex_vat, row.period),
    annualized_value_unit: "SEK/år",
  }));

  // Contacts: flatten the link rows to plain contact records, carry the
  // is_primary flag and relationship_label through, and surface the first
  // primary as a dedicated field so the model can answer "vem ska jag
  // kontakta på [kund]" without re-scanning the array.
  type ContactRecord = {
    id: string;
    name: string;
    first_name: string | null;
    last_name: string | null;
    role: string | null;
    email: string | null;
    phone: string | null;
    linkedin: string | null;
  };
  type ContactLinkRow = {
    is_primary: boolean | null;
    relationship_label: string | null;
    contact: ContactRecord | ContactRecord[] | null;
  };

  const contacts = ((contactLinksRes.data ?? []) as unknown as ContactLinkRow[])
    .map((link) => {
      // PostgREST returns embedded resources as a single object for many-
      // to-one joins and as an array otherwise. Normalize to one record.
      const contactRecord = Array.isArray(link.contact)
        ? link.contact[0] ?? null
        : link.contact;
      if (!contactRecord) return null;
      return {
        ...contactRecord,
        is_primary: Boolean(link.is_primary),
        relationship_label: link.relationship_label,
      };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);

  const primaryContact = contacts.find((c) => c.is_primary) ?? null;

  return {
    customer: customerWithTruth,
    latest_monthly_kpi: latestMonthlyKpi,
    active_contract_count: contractsRes.count ?? (contractsRes.data?.length ?? 0),
    active_contracts_sample: contractsSample,
    recent_activities: activitiesRes.data ?? [],
    primary_contact: primaryContact,
    contacts,
  };
};
