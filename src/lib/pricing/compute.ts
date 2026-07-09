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
  type MergeResult,
} from "./parsers"
import { PRICING_CONFIG, STANDARD_PRICE_LIST, type PriceListEntry } from "./price-list"

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
  clientListOnly: boolean
  /** True when the company is only in the NVR file (aktiebok-only). */
  nvrOnly: boolean
  /** True when no saved config was found (needs review before invoicing). */
  missingConfig: boolean
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

export interface ComputeInputs {
  fortnoxGrid: Grid
  kundlistaCsv: string
  redaGrid?: Grid | null
  nvrGrid?: Grid | null
  priceList?: PriceListEntry[]
  customerConfigs?: CustomerConfig[]
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
      clientListOnly: r.clientListOnly,
      nvrOnly: r.nvrOnly,
      missingConfig: !cfg,
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
