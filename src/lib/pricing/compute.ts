/**
 * Orchestration: turn the three parsed inputs + saved per-client settings into
 * the final priced result set and reconciliation summary.
 *
 * Pure and side-effect free — the API route is responsible for reading files
 * into grids and loading/saving the DB config. See docs/pricing-tool-spec.md.
 */

import { priceClient, round2, type PricedClient } from "./engine"
import {
  buildClientLookups,
  mergeToClientCostRows,
  parseFortnoxLicenseGrid,
  parseKundlistaCsv,
  parseNvrGrid,
  parseRedaGrid,
  type Grid,
  type LicenseLine,
  type MergeResult,
} from "./parsers"

export type { LicenseLine } from "./parsers"
import { PRICING_CONFIG, STANDARD_PRICE_LIST, type PriceListEntry } from "./price-list"

/**
 * One entry of the synced Fortnox customer register (the `customers` table):
 * a Fortnox customer number and the company it belongs to.
 */
export interface FortnoxCustomerRef {
  fortnoxCustomerNumber: string
  name: string
  orgNumber: string
}

export interface BillToResolution {
  /** Company the kundnr actually invoices, or null when not resolvable. */
  billToName: string | null
  billToOrgNumber: string | null
  /** True when the kundnr's registered company differs from the row's company. */
  billToMismatch: boolean
  /** True when a kundnr is set (invoiceable) but not found in the register. */
  billToUnknown: boolean
}

const orgDigits = (s: string): string => (s ?? "").replace(/\D/g, "")

/**
 * Normalise a Fortnox customer number for matching: trim, and for purely numeric
 * numbers drop leading zeros so "0855" and "855" compare equal. Non-numeric
 * numbers are compared case-insensitively.
 */
const normCustomerNumber = (s: string | null | undefined): string => {
  const t = (s ?? "").trim()
  if (t === "") return ""
  return /^\d+$/.test(t) ? String(parseInt(t, 10)) : t.toLowerCase()
}

/** Build a lookup: normalised Fortnox customer number → register entry. */
export function buildCustomerRegister(
  customers: FortnoxCustomerRef[],
): Map<string, FortnoxCustomerRef> {
  const m = new Map<string, FortnoxCustomerRef>()
  for (const c of customers) {
    const key = normCustomerNumber(c.fortnoxCustomerNumber)
    if (key) m.set(key, c)
  }
  return m
}

/**
 * Resolve which company a row's kundnr will actually invoice and whether that
 * differs from the row's own company. Comparison is by org number (names vary).
 * Returns an all-empty result for non-invoiced rows or rows without a kundnr.
 */
export function resolveBillTo(
  rowOrgNumber: string,
  kundnr: string | null | undefined,
  notInvoiced: boolean,
  registerByNumber: Map<string, FortnoxCustomerRef>,
): BillToResolution {
  const empty: BillToResolution = {
    billToName: null,
    billToOrgNumber: null,
    billToMismatch: false,
    billToUnknown: false,
  }
  const key = normCustomerNumber(kundnr)
  if (notInvoiced || !key) return empty
  const ref = registerByNumber.get(key)
  if (!ref) return { ...empty, billToUnknown: true }
  const rowOrg = orgDigits(rowOrgNumber)
  const refOrg = orgDigits(ref.orgNumber)
  return {
    billToName: ref.name || null,
    billToOrgNumber: ref.orgNumber || null,
    billToMismatch: !!rowOrg && !!refOrg && rowOrg !== refOrg,
    billToUnknown: false,
  }
}

/** Saved per-client override (mirrors the `license_customer_config` table). */
export interface CustomerConfig {
  orgNumber: string
  /** Fortnox customer number. "EJ"/"ÅR"/empty ⇒ do not invoice. */
  fortnoxCustomerNumber?: string | null
  discountPercent?: number | null
  fixedPriceFortnox?: number | null
  fixedPriceReda?: number | null
  /** Fixed NVR/aktiebok price. null = per-shareholder; 0 = do not invoice NVR. */
  fixedPriceNvr?: number | null
  /** ISO timestamp the one-time NVR start fee was billed. null = not yet. */
  nvrStartFeeChargedAt?: string | null
  comment?: string | null
  status?: string | null
}

export interface PricedResultRow {
  databaseNumber: string
  orgNumber: string
  name: string
  /** Applied config. */
  fortnoxCustomerNumber: string | null
  discountPercent: number
  fixedPriceFortnox: number | null
  fixedPriceReda: number | null
  fixedPriceNvr: number | null
  comment: string | null
  status: string | null
  /** Imported cost/list figures. */
  listPrice: number
  fixedCost: number
  extraLicenseCost: number
  redaCost: number
  nvrShareholders: number
  hasAktiebok: boolean
  /** Computed. */
  fortnoxPrice: number
  redaPrice: number
  diffVsList: number
  nvrRecurring: number
  nvrPrice: number
  notInvoiced: boolean
  /** Which company the kundnr actually invoices (from the synced register). */
  billToName: string | null
  billToOrgNumber: string | null
  /** True when the kundnr's registered company differs from this row's company. */
  billToMismatch: boolean
  /** True when a kundnr is set but not found in the Fortnox customer register. */
  billToUnknown: boolean
  clientListOnly: boolean
  /** True when the company is only in the NVR file (aktiebok-only). */
  nvrOnly: boolean
  /** True when no saved config was found (needs review before invoicing). */
  missingConfig: boolean
  /** Individual Fortnox license lines this client carries (excludes base fee). */
  licenses: LicenseLine[]
}

export interface PricingComputation {
  period: string
  rows: PricedResultRow[]
  summary: ReturnType<typeof summarizeRows>
  diagnostics: {
    unknownArticles: MergeResult["unknownArticles"]
    redaUnmatched: MergeResult["redaUnmatched"]
    nvrUnmatched: MergeResult["nvrUnmatched"]
    fortnoxClientCount: number
    kundlistaCount: number
    mergedRowCount: number
    grandTotalPaid: number
    /** Extra-cost reconciliation: allocated vs the file's own summary total. */
    extraCostReconDiff: number
    /** Fixed-cost reconciliation. */
    fixedCostReconDiff: number
  }
}

/** The persisted, shareable snapshot of a computed result (no raw files). */
export interface StoredCalculation {
  period: string
  rows: PricedResultRow[]
  diagnostics: PricingComputation["diagnostics"]
}

export interface ComputeInputs {
  fortnoxGrid: Grid
  kundlistaCsv: string
  redaGrid?: Grid | null
  nvrGrid?: Grid | null
  priceList?: PriceListEntry[]
  customerConfigs?: CustomerConfig[]
  /** Synced Fortnox customer register, for kundnr → bill-to company resolution. */
  fortnoxCustomers?: FortnoxCustomerRef[]
  redaUnitPrice?: number
}

export function computePricing(inputs: ComputeInputs): PricingComputation {
  const priceList = inputs.priceList?.length ? inputs.priceList : STANDARD_PRICE_LIST
  const redaUnitPrice = inputs.redaUnitPrice ?? PRICING_CONFIG.redaUnitPrice

  const fortnox = parseFortnoxLicenseGrid(inputs.fortnoxGrid)
  const kundlista = parseKundlistaCsv(inputs.kundlistaCsv)
  const lookups = buildClientLookups(fortnox, kundlista)
  const reda = inputs.redaGrid
    ? parseRedaGrid(inputs.redaGrid, lookups.byOrg, lookups.byName)
    : null
  const nvr = inputs.nvrGrid
    ? parseNvrGrid(inputs.nvrGrid, lookups.byOrg, lookups.byName)
    : null

  const merged = mergeToClientCostRows(
    fortnox,
    kundlista,
    reda,
    nvr,
    priceList,
    redaUnitPrice,
  )

  // Index saved config by normalised org number.
  const configByOrg = new Map<string, CustomerConfig>()
  for (const c of inputs.customerConfigs ?? []) {
    const key = c.orgNumber.replace(/\D/g, "")
    if (key) configByOrg.set(key, c)
  }

  // Fortnox customer register, for resolving where each kundnr actually invoices.
  const customerRegister = buildCustomerRegister(inputs.fortnoxCustomers ?? [])

  const rows: PricedResultRow[] = merged.rows.map((r) => {
    const cfg = configByOrg.get(r.orgNumber.replace(/\D/g, ""))
    const discountPercent = cfg?.discountPercent ?? 0
    const fixedPriceFortnox = cfg?.fixedPriceFortnox ?? null
    const fixedPriceReda = cfg?.fixedPriceReda ?? null
    const fixedPriceNvr = cfg?.fixedPriceNvr ?? null
    const fortnoxCustomerNumber = cfg?.fortnoxCustomerNumber ?? null

    const priced = priceClient({
      kundnr: fortnoxCustomerNumber,
      discountPct: discountPercent,
      fixedPrice: fixedPriceFortnox,
      redaFixedPrice: fixedPriceReda,
      listPrice: r.listPrice,
      extraLicenseCost: r.extraLicenseCost,
      redaCost: r.redaCost,
      nvrShareholders: r.nvrShareholders,
      hasAktiebok: r.hasAktiebok,
      nvrFixedPrice: fixedPriceNvr,
    })

    const billTo = resolveBillTo(
      r.orgNumber,
      fortnoxCustomerNumber,
      priced.notInvoiced,
      customerRegister,
    )

    return {
      databaseNumber: r.databaseNumber,
      orgNumber: r.orgNumber,
      name: r.name,
      fortnoxCustomerNumber,
      discountPercent,
      fixedPriceFortnox,
      fixedPriceReda,
      fixedPriceNvr,
      comment: cfg?.comment ?? null,
      status: cfg?.status ?? null,
      listPrice: r.listPrice,
      fixedCost: r.fixedCost,
      extraLicenseCost: r.extraLicenseCost,
      redaCost: r.redaCost,
      nvrShareholders: r.nvrShareholders,
      hasAktiebok: r.hasAktiebok,
      fortnoxPrice: priced.fortnoxPrice,
      redaPrice: priced.redaPrice,
      diffVsList: priced.diffVsList,
      nvrRecurring: priced.nvrRecurring,
      nvrPrice: priced.nvrPrice,
      notInvoiced: priced.notInvoiced,
      ...billTo,
      clientListOnly: r.clientListOnly,
      nvrOnly: r.nvrOnly,
      missingConfig: !cfg,
      licenses: r.licenses,
    }
  })

  // Reconciliation diagnostics (period-independent correctness checks).
  const extraSummaryTotal = [...fortnox.articleTotals.values()]
    .filter((a) => a.articleNo !== fortnox.fixedArticleNo && a.totalCost > 0)
    .reduce((s, a) => s + a.totalCost, 0)
  const allocatedExtra = rows.reduce((s, r) => s + r.extraLicenseCost, 0)
  const allocatedFixed = rows.reduce((s, r) => s + r.fixedCost, 0)

  return {
    period: fortnox.period,
    rows,
    summary: summarizeRows(rows),
    diagnostics: {
      unknownArticles: merged.unknownArticles,
      redaUnmatched: merged.redaUnmatched,
      nvrUnmatched: merged.nvrUnmatched,
      fortnoxClientCount: fortnox.clients.size,
      kundlistaCount: kundlista.length,
      mergedRowCount: merged.rows.length,
      grandTotalPaid: fortnox.grandTotalPaid,
      extraCostReconDiff: round2(allocatedExtra - extraSummaryTotal),
      fixedCostReconDiff: round2(allocatedFixed - fortnox.fixedTotalPaid),
    },
  }
}

/** Summary over the priced rows (the "Summering" sheet), excluding Saldo. */
export function summarizeRows(
  rows: PricedResultRow[],
  saldoDatabaseNumber: string = PRICING_CONFIG.saldoDatabaseNumber,
) {
  let invoicedCount = 0
  let totalInvoicedFortnox = 0
  let totalListPrice = 0
  let totalFixedCost = 0
  let totalExtraCost = 0
  let totalInvoicedReda = 0
  let totalRedaCost = 0
  let totalInvoicedNvr = 0
  let totalNvrRecurring = 0
  let nvrShareholders = 0
  let aktiebokCount = 0

  for (const r of rows) {
    const isSaldo = r.databaseNumber === saldoDatabaseNumber
    if (r.fortnoxPrice > 0) {
      invoicedCount += 1
      totalInvoicedFortnox += r.fortnoxPrice
      totalListPrice += r.listPrice
    }
    totalInvoicedReda += r.redaPrice
    totalInvoicedNvr += r.nvrPrice
    totalNvrRecurring += r.nvrRecurring
    if (r.nvrPrice > 0) {
      aktiebokCount += 1
      nvrShareholders += r.nvrShareholders
    }
    if (!isSaldo) {
      totalFixedCost += r.fixedCost
      totalExtraCost += r.extraLicenseCost
      totalRedaCost += r.redaCost
    }
  }

  const result = totalInvoicedFortnox - totalFixedCost - totalExtraCost
  return {
    invoicedCount,
    totalInvoicedFortnox: round2(totalInvoicedFortnox),
    totalListPrice: round2(totalListPrice),
    totalFixedCost: round2(totalFixedCost),
    totalExtraCost: round2(totalExtraCost),
    result: round2(result),
    /** Blended discount vs list, informational. */
    marginPct:
      totalInvoicedFortnox > 0
        ? round2((result / totalInvoicedFortnox) * 100)
        : 0,
    totalInvoicedReda: round2(totalInvoicedReda),
    totalRedaCost: round2(totalRedaCost),
    redaResult: round2(totalInvoicedReda - totalRedaCost),
    // NVR / aktiebok (pure revenue — no cost basis in the source files).
    totalInvoicedNvr: round2(totalInvoicedNvr),
    totalNvrRecurring: round2(totalNvrRecurring),
    nvrShareholders,
    aktiebokCount,
  }
}
