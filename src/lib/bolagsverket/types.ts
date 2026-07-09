// =====================================================================
// Bolagsverket — Värdefulla Datamängder (HVD) API: domain types
// =====================================================================
// This API is ORG-NUMBER-KEYED: you submit an organisationsnummer and get
// company base data + a list of filed documents (annual reports) presented
// per accounting period (räkenskapsperiod). It does NOT do name -> org.nr
// search (that lives in SCB's register behind a separate agreement).
//
// Types below are our OWN normalised shape, deliberately decoupled from the
// raw API payload so the rest of the app never depends on Bolagsverket's
// wire format. The client maps raw -> these.

/** A single accounting period (räkenskapsår) as reported by Bolagsverket. */
export interface BolagsverketFinancialYear {
  /** Period start (räkenskapsår från). ISO date, e.g. "2024-07-01". */
  from: string | null
  /** Period end (räkenskapsår till). ISO date, e.g. "2025-06-30". */
  to: string
  /** True when an annual report (bokslut) is registered for this period. */
  annualReportRegistered: boolean
}

/** Registered postal address as reported by Bolagsverket. */
export interface BolagsverketAddress {
  /** Street / utdelningsadress, e.g. "Storgatan 1". */
  street: string | null
  /** Postal code, e.g. "111 22". */
  postalCode: string | null
  /** City / postort, e.g. "Stockholm". */
  city: string | null
}

/** Normalised company snapshot from Bolagsverket for one org number. */
export interface BolagsverketCompany {
  /** Canonical org number as Bolagsverket holds it (source of truth). */
  orgNumber: string
  /** Registered company name. */
  name: string | null
  /** Legal form, e.g. "Aktiebolag". */
  legalForm: string | null
  /** Registered office / säte (kommun). */
  registeredOffice: string | null
  /** Registered postal address (NULL when the dataset has none). */
  address: BolagsverketAddress | null
  /** Registration status, e.g. active vs. deregistered. */
  status: string | null
  /**
   * Accounting periods, newest first. The latest is the effective
   * räkenskapsår we push onto the customer card.
   */
  financialYears: BolagsverketFinancialYear[]
  /** Raw payload, retained verbatim in customers.bolagsverket_company_data. */
  raw: Record<string, unknown>
}

/** Result of a lookup — distinguishes "not found" from a hard error. */
export type BolagsverketLookupResult =
  | { ok: true; company: BolagsverketCompany }
  | { ok: false; reason: "not_found" }

/**
 * API-agnostic client contract. Both the live client and the stub implement
 * this, so downstream code (sync, card refresh action) can be built and
 * tested before real credentials exist. Name-search is intentionally absent
 * — this API can't do it. Add a separate SearchProvider later if SCB access
 * is arranged.
 */
export interface BolagsverketClient {
  /**
   * Look up one company by org number. Normalises the org number before
   * calling (strips spaces/hyphens). Returns not_found for unknown numbers.
   */
  lookupByOrgNumber(orgNumber: string): Promise<BolagsverketLookupResult>
}
