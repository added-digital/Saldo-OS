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
import type { BolagsverketFinancialYear } from "./types"

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
  /**
   * Number of bokslut cards auto-advanced to "Registrerad hos Bolagsverket"
   * because Bolagsverket reports a registered annual report for their fiscal
   * year. 0 unless the customer matched confirmed and had catching-up cards.
   */
  cardsMarkedRegistered: number
}

// --- name matching ---------------------------------------------------
// Token-based and ORDER-INDEPENDENT so "TL Bergstedts fond" matches
// "BERGSTEDTS FOND, T L". We drop legal-form words and single letters
// (initials), then require a strong overlap of the remaining significant
// words. Crucially, if EITHER name has no comparable tokens (e.g. Bolagsverket
// returned no company name for a foundation), we do NOT flag — a blank name is
// not evidence of a wrong org number.

// Legal forms + filler that shouldn't drive a match/mismatch decision.
const STOPWORDS = new Set([
  "ab", "aktiebolag", "hb", "kb", "kommanditbolag", "ekonomisk", "förening",
  "ek", "för", "i", "konkurs", "the", "och",
])

function nameTokens(n: string | null | undefined): string[] {
  return (n ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9åäö\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t))
}

export function namesMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const ta = nameTokens(a)
  const tb = nameTokens(b)
  // Can't compare (one side blank) → don't flag.
  if (ta.length === 0 || tb.length === 0) return true

  const setA = new Set(ta)
  const setB = new Set(tb)
  const [small, large] = setA.size <= setB.size ? [setA, setB] : [setB, setA]
  let overlap = 0
  for (const tok of small) if (large.has(tok)) overlap += 1
  // Match when at least 60% of the shorter name's significant words appear in
  // the other — enough for word-order/abbreviation differences, but "TG3 Tech"
  // vs "Fastighets Stentulpanen Stockholm" (0% overlap) still flags.
  return overlap / small.size >= 0.6
}

// --- annual-report → board sync --------------------------------------
// Bolagsverket's /dokumentlista returns one entry per REGISTERED annual report,
// so a fiscal-year end appearing there means "årsredovisning inlämnad och
// registrerad". We reflect that on the bokslut board by auto-advancing the
// matching card to the terminal "Registrerad hos Bolagsverket" stage.
//
// Rules (agreed with the team):
//   • Forward-only. A card moves only when its current bokslut stage sits
//     BEFORE "registrerad_bolagsverket" (or it has no stage yet). We never drag
//     a card backwards.
//   • Parked cards ("Ej aktuell") are left untouched — that's a human decision.
//   • Only ever called on a CONFIRMED name match, so we don't act on a possibly
//     wrong org number.
// The engagement trigger stamps the change + logs it to the activity feed with
// a null actor (system), and it fires only on a real change, so re-running the
// refresh is idempotent — no duplicate moves or log spam.

async function syncRegisteredAnnualReports(
  supabase: SupabaseClient,
  customerId: string,
  financialYears: BolagsverketFinancialYear[],
): Promise<number> {
  const registeredEnds = Array.from(
    new Set(
      financialYears
        .filter((fy) => fy.annualReportRegistered)
        .map((fy) => fy.to),
    ),
  )
  if (registeredEnds.length === 0) return 0

  // Full bokslut stage order, so we can compare sort positions.
  const { data: statusesData } = await supabase
    .from("engagement_statuses")
    .select("id, key, sort_order, is_parked")
    .eq("workflow", "bokslut")
  const statuses = (statusesData ?? []) as Array<{
    id: string
    key: string
    sort_order: number
    is_parked: boolean
  }>
  const registered = statuses.find((s) => s.key === "registrerad_bolagsverket")
  if (!registered) return 0
  const byId = new Map(statuses.map((s) => [s.id, s]))

  // Candidate cards: this customer, fiscal year Bolagsverket reports registered.
  const { data: engData } = await supabase
    .from("engagements")
    .select("id, bokslut_status_id, annual_report_registered_bv_at")
    .eq("customer_id", customerId)
    .in("fiscal_year_end", registeredEnds)
  const engagements = (engData ?? []) as Array<{
    id: string
    bokslut_status_id: string | null
    annual_report_registered_bv_at: string | null
  }>

  const now = new Date().toISOString()
  let confirmed = 0
  for (const e of engagements) {
    const current = e.bokslut_status_id
      ? byId.get(e.bokslut_status_id)
      : undefined
    if (current?.is_parked) continue // leave "Ej aktuell" alone

    const update: {
      bokslut_status_id?: string
      annual_report_registered_bv_at?: string
    } = {}

    // Stamp the BV confirmation (drives the card's verified badge) once. Applies
    // even to cards already sitting in "Registrerad" via a manual move — that's
    // exactly the case we want to turn into a trusted, confirmed one.
    const newlyConfirmed = !e.annual_report_registered_bv_at
    if (newlyConfirmed) update.annual_report_registered_bv_at = now

    // Forward-only auto-advance. Manual moves are never overridden backwards.
    if (!current || current.sort_order < registered.sort_order) {
      update.bokslut_status_id = registered.id
    }

    if (Object.keys(update).length === 0) continue
    const { error } = await supabase
      .from("engagements")
      .update(update)
      .eq("id", e.id)
    if (!error && newlyConfirmed) confirmed += 1
  }
  return confirmed
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
    return { customerId: customer.id, status: "no_orgnr", bvOrgNumber: null, bvName: null, rakenskapsarTom: null, cardsMarkedRegistered: 0 }
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
    return { customerId: customer.id, status: "not_found", bvOrgNumber: null, bvName: null, rakenskapsarTom: null, cardsMarkedRegistered: 0 }
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
      cardsMarkedRegistered: 0,
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

  // Confirmed match → trust the filed-report data. Auto-advance any bokslut
  // card whose fiscal year Bolagsverket now reports as registered.
  const cardsMarkedRegistered = await syncRegisteredAnnualReports(
    supabase,
    customer.id,
    company.financialYears,
  )

  return {
    customerId: customer.id,
    status,
    bvOrgNumber: company.orgNumber,
    bvName: company.name,
    rakenskapsarTom: latestTom,
    cardsMarkedRegistered,
  }
}
