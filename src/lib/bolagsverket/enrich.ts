// =====================================================================
// Bolagsverket enrichment writer
// =====================================================================
// Given one customer, look them up at Bolagsverket and write the result back
// to the customers row. SAFE BY DESIGN:
//   • Never overwrites the customer NAME.
//   • Only sets the effective org_number when the company is CONFIRMED
//     (Bolagsverket's name matches ours). On a mismatch it changes nothing
//     except raising bolagsverket_name_mismatch for review.
//   • Räkenskapsår (_bv) is written only on a confirmed match — we don't trust
//     a period pulled from a possibly-wrong company.
//
// Used by the per-customer refresh route now, and by the nightly batch later.

import type { SupabaseClient } from "@supabase/supabase-js"

import { getBolagsverketClient, normalizeOrgNumber } from "./index"

export type BolagsverketMatchStatus =
  | "confirmed"
  | "no_rakenskapsar"
  | "name_mismatch"
  | "not_found"
  | "no_orgnr"

export interface EnrichmentResult {
  customerId: string
  status: BolagsverketMatchStatus
  /** Canonical org number Bolagsverket returned (null if not found / no org). */
  bvOrgNumber: string | null
  /** Company name Bolagsverket returned (null if not found). */
  bvName: string | null
  /** Latest räkenskapsår end date from Bolagsverket (null if none). */
  rakenskapsarTom: string | null
}

// --- name matching ---------------------------------------------------
// Loose, and deliberately errs toward flagging: a false "mismatch" just asks a
// human to glance, whereas a false "match" could silently trust a wrong org.nr.

function normalizeName(n: string | null | undefined): string {
  return (n ?? "")
    .toLowerCase()
    .replace(/\b(ab|aktiebolag|hb|kb|ekonomisk förening|ek för|i konkurs)\b/g, "")
    .replace(/[^a-z0-9åäö]/g, "")
    .trim()
}

export function namesMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const na = normalizeName(a)
  const nb = normalizeName(b)
  if (!na || !nb) return false
  if (na === nb) return true
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na]
  return short.length >= 4 && long.includes(short)
}

// --- writer ----------------------------------------------------------

interface CustomerRow {
  id: string
  name: string | null
  org_number: string | null
}

/**
 * Look up one customer at Bolagsverket and persist the outcome.
 * `supabase` must be a service-role client (writes bypass RLS; callers are
 * responsible for their own authz — e.g. the admin-only refresh route).
 */
export async function enrichCustomerFromBolagsverket(
  supabase: SupabaseClient,
  customer: CustomerRow,
): Promise<EnrichmentResult> {
  const now = new Date().toISOString()
  const org = normalizeOrgNumber(customer.org_number ?? "")

  // No org number → can't look up (this API has no name search).
  if (!org) {
    await supabase
      .from("customers")
      .update({
        bolagsverket_match_status: "no_orgnr",
        bolagsverket_name_mismatch: false,
        bolagsverket_updated_at: now,
      })
      .eq("id", customer.id)
    return { customerId: customer.id, status: "no_orgnr", bvOrgNumber: null, bvName: null, rakenskapsarTom: null }
  }

  const result = await getBolagsverketClient().lookupByOrgNumber(org)

  // Not found (individual, foreign company, or bad org.nr).
  if (!result.ok) {
    await supabase
      .from("customers")
      .update({
        bolagsverket_match_status: "not_found",
        bolagsverket_name_mismatch: false,
        bolagsverket_updated_at: now,
      })
      .eq("id", customer.id)
    return { customerId: customer.id, status: "not_found", bvOrgNumber: null, bvName: null, rakenskapsarTom: null }
  }

  const company = result.company
  const latestTom = company.financialYears[0]?.to ?? null

  // Name mismatch → possible wrong org.nr. Record BV's data for reference and
  // RAISE THE FLAG, but do NOT touch the effective org_number / name /
  // räkenskapsår. A human resolves these.
  if (!namesMatch(customer.name, company.name)) {
    await supabase
      .from("customers")
      .update({
        org_number_bv: company.orgNumber,
        bolagsverket_match_status: "name_mismatch",
        bolagsverket_name_mismatch: true,
        bolagsverket_status: company.status,
        bolagsverket_registered_office: company.registeredOffice,
        bolagsverket_company_data: company.raw,
        bolagsverket_updated_at: now,
        // NOTE: no org_number / name / financial_year_*_bv writes here.
      })
      .eq("id", customer.id)
    return {
      customerId: customer.id,
      status: "name_mismatch",
      bvOrgNumber: company.orgNumber,
      bvName: company.name,
      rakenskapsarTom: latestTom,
    }
  }

  // Confirmed match. Bolagsverket is now the source of truth for this customer.
  const status: BolagsverketMatchStatus = latestTom ? "confirmed" : "no_rakenskapsar"
  await supabase
    .from("customers")
    .update({
      org_number: company.orgNumber, // canonical wins (usually identical)
      org_number_bv: company.orgNumber,
      bolagsverket_match_status: status,
      bolagsverket_name_mismatch: false,
      bolagsverket_status: company.status,
      bolagsverket_registered_office: company.registeredOffice,
      bolagsverket_company_data: company.raw,
      bolagsverket_updated_at: now,
      // Räkenskapsår: BV gives only the END date; _from stays NULL so the
      // start still falls back to SIE/manual via the generated column.
      financial_year_from_bv: company.financialYears[0]?.from ?? null,
      financial_year_to_bv: latestTom,
    })
    .eq("id", customer.id)

  return {
    customerId: customer.id,
    status,
    bvOrgNumber: company.orgNumber,
    bvName: company.name,
    rakenskapsarTom: latestTom,
  }
}
