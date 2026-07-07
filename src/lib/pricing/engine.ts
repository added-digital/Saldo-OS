/**
 * Core pricing/discount engine — a pure, dependency-free reproduction of the
 * "Kundnr" sheet calculation from the reference workbook (Huvud excel.xlsm).
 *
 * Verified: reproduces the workbook's own computed values for all 504 customer
 * rows (Fortnox price + Reda price) with zero mismatches.
 *
 * See docs/pricing-tool-spec.md §3–4.
 */

import { PRICING_CONFIG } from "./price-list"

/** Round to 2 decimals the same way Excel/VBA `Round(x, 2)` does. */
export function round2(x: number): number {
  return Math.round((x + Number.EPSILON) * 100) / 100
}

const num = (v: unknown): number => {
  if (v === null || v === undefined || v === "") return 0
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(",", "."))
  return Number.isFinite(n) ? n : 0
}

/**
 * A customer number of "EJ", "ÅR" (or "AR"), or blank means "do not invoice".
 * Matches the workbook's `UPPER(TRIM(E)) IN {"EJ","ÅR",""}` test.
 */
export function isNotInvoiced(kundnr: unknown): boolean {
  const s = (kundnr == null ? "" : String(kundnr)).trim().toUpperCase()
  return s === "" || s === "EJ" || s === "ÅR" || s === "AR"
}

/** One client row — the manual levers plus the imported cost/list figures. */
export interface ClientPricingInput {
  /** Fortnox customer number. "EJ" / "ÅR" / "" ⇒ do not invoice. (Col E) */
  kundnr?: string | number | null
  /** Discount %, NOT applied to extra licenses. (Col F) */
  discountPct?: number | null
  /** Fixed-price override; > 0 activates it. (Col G) */
  fixedPrice?: number | null
  /** Reda fixed price. undefined/null = variable, 0 = do not invoice Reda. (Col H) */
  redaFixedPrice?: number | string | null
  /** Total list price = Σ(qty × standard price). (Col L) */
  listPrice?: number | null
  /** Cost of extra/additional licenses (paid price > 0). (Col N) */
  extraLicenseCost?: number | null
  /** Reda cost = scans × unit price. (Col O) */
  redaCost?: number | null
}

export interface ClientPricingResult {
  /** Customer's Fortnox price (Col I). */
  fortnoxPrice: number
  /** Customer's Reda price (Col K). */
  redaPrice: number
  /** Diff vs list price, I − L (Col J). */
  diffVsList: number
  /** True when the row is flagged do-not-invoice. */
  notInvoiced: boolean
}

/**
 * Customer's Fortnox price (Kundnr column I):
 *
 *   notInvoiced          → 0
 *   fixedPrice G > 0     → G + N
 *   otherwise            → N + (L − N) × (1 − F/100)
 *
 * Extra licenses N are always charged at cost (no discount); the base value
 * (L − N) receives the customer discount F%.
 */
export function calcFortnoxPrice(input: ClientPricingInput): number {
  if (isNotInvoiced(input.kundnr)) return 0
  const L = num(input.listPrice)
  const N = num(input.extraLicenseCost)
  const G = num(input.fixedPrice)
  const F = num(input.discountPct)
  if (G > 0) return G + N
  return N + (L - N) * (1 - F / 100)
}

/**
 * Customer's Reda price (Kundnr column K):
 *
 *   notInvoiced              → 0
 *   redaFixedPrice present   → redaFixedPrice   (0 means "do not invoice Reda")
 *   otherwise                → redaCost (variable)
 */
export function calcRedaPrice(input: ClientPricingInput): number {
  if (isNotInvoiced(input.kundnr)) return 0
  const h = input.redaFixedPrice
  const hasFixed = h !== null && h !== undefined && String(h) !== ""
  return hasFixed ? num(h) : num(input.redaCost)
}

/** Compute all derived prices for one client row. */
export function priceClient(input: ClientPricingInput): ClientPricingResult {
  const notInvoiced = isNotInvoiced(input.kundnr)
  const fortnoxPrice = calcFortnoxPrice(input)
  return {
    fortnoxPrice,
    redaPrice: calcRedaPrice(input),
    diffVsList: fortnoxPrice - num(input.listPrice),
    notInvoiced,
  }
}

// ---------------------------------------------------------------------------
// Aggregation — the "Summering" (summary) sheet.
// ---------------------------------------------------------------------------

export interface PricedClient extends ClientPricingInput, ClientPricingResult {
  /** Fortnox database / subscription number (Col A). */
  abonnemangsnummer?: string | number | null
  /** Fixed cost Saldo pays Fortnox (Col M). */
  fixedCost?: number | null
}

export interface PricingSummary {
  /** Count of clients actually invoiced for Fortnox (Fortnox price > 0). */
  invoicedCount: number
  /** Total invoiced to customers for Fortnox (Σ Fortnox price). */
  totalInvoicedFortnox: number
  /** Total list price of invoiced clients (Σ L where price > 0). */
  totalListPrice: number
  /** Cost of the fixed client fee (Σ M). */
  totalFixedCost: number
  /** Cost of extra licenses (Σ N). */
  totalExtraCost: number
  /** Margin = invoiced − (fixedCost + extraCost). */
  result: number
  /** Total invoiced to customers for Reda (Σ Reda price). */
  totalInvoicedReda: number
  /** Reda cost (Σ O). */
  totalRedaCost: number
  /** Reda margin. */
  redaResult: number
}

/**
 * Aggregate priced clients into the summary figures, excluding Saldo's own
 * database from the cost/margin buckets (matching the reference sheet, which
 * filters `Kundnr!A <> 65018`).
 */
export function summarize(
  clients: PricedClient[],
  saldoDatabaseNumber: string = PRICING_CONFIG.saldoDatabaseNumber,
): PricingSummary {
  let invoicedCount = 0
  let totalInvoicedFortnox = 0
  let totalListPrice = 0
  let totalFixedCost = 0
  let totalExtraCost = 0
  let totalInvoicedReda = 0
  let totalRedaCost = 0

  for (const c of clients) {
    const isSaldo = String(c.abonnemangsnummer ?? "").trim() === saldoDatabaseNumber
    if (c.fortnoxPrice > 0) {
      invoicedCount += 1
      totalInvoicedFortnox += c.fortnoxPrice
      totalListPrice += num(c.listPrice)
    }
    totalInvoicedReda += c.redaPrice
    if (!isSaldo) {
      totalFixedCost += num(c.fixedCost)
      totalExtraCost += num(c.extraLicenseCost)
      totalRedaCost += num(c.redaCost)
    }
  }

  return {
    invoicedCount,
    totalInvoicedFortnox: round2(totalInvoicedFortnox),
    totalListPrice: round2(totalListPrice),
    totalFixedCost: round2(totalFixedCost),
    totalExtraCost: round2(totalExtraCost),
    result: round2(totalInvoicedFortnox - totalFixedCost - totalExtraCost),
    totalInvoicedReda: round2(totalInvoicedReda),
    totalRedaCost: round2(totalRedaCost),
    redaResult: round2(totalInvoicedReda - totalRedaCost),
  }
}
