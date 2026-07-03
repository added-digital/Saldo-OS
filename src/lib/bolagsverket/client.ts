// =====================================================================
// Bolagsverket — client implementations
// =====================================================================
// Two implementations of BolagsverketClient:
//   • LiveBolagsverketClient — talks to the real API (endpoint paths are
//     TODO-flagged; confirm them against the devportal OpenAPI once creds
//     are in, then map the raw payload in the two `map*` helpers).
//   • StubBolagsverketClient — deterministic mock, so sync + the card
//     "refresh" action can be built and tested before live access exists.
//
// Nothing outside this folder should import these directly — use the factory
// in ./index.ts (getBolagsverketClient) so live/stub selection stays in one
// place.

import { getAccessToken } from "./auth"
import type {
  BolagsverketClient,
  BolagsverketCompany,
  BolagsverketLookupResult,
} from "./types"

const API_BASE =
  process.env.BOLAGSVERKET_API_BASE ?? "https://api.bolagsverket.se"

/** Strip everything but digits so "556012-5790" and "5560125790" both work. */
export function normalizeOrgNumber(orgNumber: string): string {
  return orgNumber.replace(/\D/g, "")
}

// ---------------------------------------------------------------------
// Live client
// ---------------------------------------------------------------------
export class LiveBolagsverketClient implements BolagsverketClient {
  private async request<T>(path: string): Promise<{ status: number; body: T | null }> {
    const token = await getAccessToken()
    const response = await fetch(`${API_BASE}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    })

    if (response.status === 404) {
      return { status: 404, body: null }
    }
    if (response.status === 429) {
      throw new Error("Rate limited by Bolagsverket (60/min). Retry after backoff.")
    }
    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Bolagsverket API error (${response.status}): ${text}`)
    }

    return { status: response.status, body: (await response.json()) as T }
  }

  async lookupByOrgNumber(orgNumber: string): Promise<BolagsverketLookupResult> {
    const org = normalizeOrgNumber(orgNumber)

    // TODO(creds): confirm exact paths against the devportal OpenAPI for the
    // "Värdefulla Datamängder" API (ff8f9a91-1fdd-4705-8836-c1906581162f).
    // Expected shape: one call for company base data, one for the document
    // list (annual reports per accounting period). Endpoints below are
    // placeholders to be verified — not yet live-tested.
    const base = await this.request<Record<string, unknown>>(
      `/vardefulla-datamangder/v1/organisationer/${org}`,
    )
    if (base.status === 404 || base.body === null) {
      return { ok: false, reason: "not_found" }
    }

    const documents = await this.request<Record<string, unknown>>(
      `/vardefulla-datamangder/v1/organisationer/${org}/dokument`,
    )

    const company = mapCompany(org, base.body, documents.body ?? {})
    return { ok: true, company }
  }
}

/**
 * Map raw Bolagsverket payloads to our normalised BolagsverketCompany.
 * Field paths are TODO until we see a real response; kept isolated here so
 * confirming them later is a one-file change.
 */
function mapCompany(
  org: string,
  base: Record<string, unknown>,
  documents: Record<string, unknown>,
): BolagsverketCompany {
  // TODO(creds): map real fields once a sample payload is available.
  return {
    orgNumber: org,
    name: null,
    legalForm: null,
    registeredOffice: null,
    status: null,
    financialYears: mapFinancialYears(documents),
    raw: { base, documents },
  }
}

function mapFinancialYears(
  _documents: Record<string, unknown>,
): BolagsverketCompany["financialYears"] {
  // TODO(creds): derive accounting periods (räkenskapsperiod) from the
  // document list. Newest first.
  return []
}

// ---------------------------------------------------------------------
// Stub client — deterministic mock for building/testing without live access
// ---------------------------------------------------------------------
export class StubBolagsverketClient implements BolagsverketClient {
  async lookupByOrgNumber(orgNumber: string): Promise<BolagsverketLookupResult> {
    const org = normalizeOrgNumber(orgNumber)
    if (!org || org === "0000000000") {
      return { ok: false, reason: "not_found" }
    }
    return {
      ok: true,
      company: {
        orgNumber: org,
        name: "Stub Företag AB",
        legalForm: "Aktiebolag",
        registeredOffice: "Stockholm",
        status: "aktivt",
        financialYears: [
          { from: "2024-07-01", to: "2025-06-30", annualReportRegistered: true },
          { from: "2023-07-01", to: "2024-06-30", annualReportRegistered: true },
        ],
        raw: { stub: true, orgNumber: org },
      },
    }
  }
}
