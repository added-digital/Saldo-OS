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

// Confirmed base + paths (from the Bolagsverket API collection):
//   Base:  https://gw.api.bolagsverket.se/vardefulla-datamangder/v1
//   GET  /isalive                 — health / token check
//   POST /organisationer          — company base data (org.nr in body)
//   POST /dokumentlista           — filed annual reports (org.nr in body)
//   GET  /dokument/:dokumentId    — download one annual report (unused here)
const API_BASE =
  process.env.BOLAGSVERKET_API_BASE ??
  "https://gw.api.bolagsverket.se/vardefulla-datamangder/v1"

/** Strip everything but digits so "556012-5790" and "5560125790" both work. */
export function normalizeOrgNumber(orgNumber: string): string {
  return orgNumber.replace(/\D/g, "")
}

// ---------------------------------------------------------------------
// Live client
// ---------------------------------------------------------------------
export class LiveBolagsverketClient implements BolagsverketClient {
  /** Low-level request. `body` (if given) is JSON-POSTed; otherwise GET. */
  private async request<T>(
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: T | null }> {
    const token = await getAccessToken()
    const response = await fetch(`${API_BASE}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })

    if (response.status === 404 || response.status === 400) {
      // 404 = unknown org. 400 = Bolagsverket rejected the identifier, e.g. a
      // personnummer / sole trader (enskild firma) that isn't a company
      // ("personnummer anges med 12 siffror"). Neither has company data for us,
      // so treat both as a soft "no result" rather than a hard error.
      return { status: response.status, body: null }
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

  /**
   * GET /isalive — health probe. Note: under the granted scope this endpoint
   * returns 403 ("scope validation failed") even though /organisationer works,
   * so treat a throw/non-2xx as "unknown", not a hard outage. Not used in the
   * main flow.
   */
  async isAlive(): Promise<boolean> {
    try {
      const res = await this.request<unknown>("/isalive")
      return res.status >= 200 && res.status < 300
    } catch {
      return false
    }
  }

  async lookupByOrgNumber(orgNumber: string): Promise<BolagsverketLookupResult> {
    const org = normalizeOrgNumber(orgNumber)

    // Both endpoints take the org number in the POST body under
    // `identitetsbeteckning` (confirmed against the live API).
    const base = await this.request<OrganisationerResponse>(
      "/organisationer",
      requestBody(org),
    )
    // Unknown org → 404, or 200 with an empty `organisationer` array.
    if (base.status === 404 || !base.body?.organisationer?.length) {
      return { ok: false, reason: "not_found" }
    }

    const documents = await this.request<DokumentlistaResponse>(
      "/dokumentlista",
      requestBody(org),
    )

    const company = mapCompany(org, base.body, documents.body ?? { dokument: [] })
    return { ok: true, company }
  }
}

/** Request body for /organisationer and /dokumentlista (org.nr goes here). */
function requestBody(org: string): Record<string, unknown> {
  return { identitetsbeteckning: org }
}

// ---------------------------------------------------------------------
// Raw API response shapes (only the fields we read)
// ---------------------------------------------------------------------
interface RawOrganisation {
  organisationsidentitet?: { identitetsbeteckning?: string }
  organisationsnamn?: {
    organisationsnamnLista?: Array<{
      namn?: string
      organisationsnamntyp?: { kod?: string }
    }>
  }
  organisationsform?: { kod?: string; klartext?: string }
  juridiskForm?: { kod?: string; klartext?: string }
  postadressOrganisation?: {
    postadress?: {
      utdelningsadress?: string
      // The API has used both spellings across versions; read either.
      postnummer?: string
      postNummer?: string
      postort?: string
    }
  }
  verksamOrganisation?: { kod?: string }
  avregistreradOrganisation?: unknown
  organisationsdatum?: { registreringsdatum?: string }
}
interface OrganisationerResponse {
  organisationer?: RawOrganisation[]
}

interface RawDokument {
  dokumentId?: string
  rapporteringsperiodFrom?: string
  rapporteringsperiodTom?: string
  registreringstidpunkt?: string
}
interface DokumentlistaResponse {
  dokument?: RawDokument[]
}

/** Map the raw /organisationer + /dokumentlista payloads to our normalised shape. */
function mapCompany(
  org: string,
  base: OrganisationerResponse,
  documents: DokumentlistaResponse,
): BolagsverketCompany {
  const o = base.organisationer?.[0]

  // Prefer the registered company name (FORETAGSNAMN); fall back to the first.
  const namnLista = o?.organisationsnamn?.organisationsnamnLista ?? []
  const nameEntry =
    namnLista.find((n) => n.organisationsnamntyp?.kod === "FORETAGSNAMN") ??
    namnLista[0]

  // Active unless explicitly deregistered; verksamOrganisation.kod "JA" = yes.
  const deregistered = o?.avregistreradOrganisation != null
  const status = deregistered
    ? "avregistrerad"
    : o?.verksamOrganisation?.kod === "JA"
      ? "aktiv"
      : (o?.verksamOrganisation?.kod ?? null)

  const postadress = o?.postadressOrganisation?.postadress
  const address =
    postadress?.utdelningsadress || postadress?.postort
      ? {
          street: postadress?.utdelningsadress ?? null,
          postalCode: postadress?.postnummer ?? postadress?.postNummer ?? null,
          city: postadress?.postort ?? null,
        }
      : null

  return {
    // Canonical org number as Bolagsverket holds it (source of truth).
    orgNumber: o?.organisationsidentitet?.identitetsbeteckning ?? org,
    name: nameEntry?.namn ?? null,
    legalForm: o?.organisationsform?.klartext ?? o?.juridiskForm?.klartext ?? null,
    // No dedicated "säte" field in this dataset; postort is the best proxy.
    registeredOffice: o?.postadressOrganisation?.postadress?.postort ?? null,
    address,
    status,
    financialYears: mapFinancialYears(documents),
    raw: { organisation: o ?? null, dokumentlista: documents.dokument ?? [] },
  }
}

/**
 * Derive räkenskapsår (accounting periods) from the filed annual reports.
 * Each document in /dokumentlista is a registered annual report, so its
 * presence means a report IS registered for that period. Bolagsverket only
 * provides the period END (`rapporteringsperiodTom`), matching how the app
 * already stores räkenskapsår (end-only). Newest first.
 */
function mapFinancialYears(
  documents: DokumentlistaResponse,
): BolagsverketCompany["financialYears"] {
  return (documents.dokument ?? [])
    .map((d) =>
      d.rapporteringsperiodTom
        ? {
            from: d.rapporteringsperiodFrom ?? null,
            to: d.rapporteringsperiodTom,
            annualReportRegistered: true,
          }
        : null,
    )
    .filter((x): x is BolagsverketCompany["financialYears"][number] => x !== null)
    .sort((a, b) => (a.to < b.to ? 1 : a.to > b.to ? -1 : 0))
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
        address: {
          street: "Stubbgatan 1",
          postalCode: "111 22",
          city: "Stockholm",
        },
        status: "aktivt",
        financialYears: [
          // Bolagsverket provides only the period END date (like the real API).
          { from: null, to: "2025-12-31", annualReportRegistered: true },
          { from: null, to: "2024-12-31", annualReportRegistered: true },
        ],
        raw: { stub: true, orgNumber: org },
      },
    }
  }
}
