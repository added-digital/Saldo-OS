// Smoke test for the SIE KPI evaluator.
//
// Builds a small synthetic balance set, runs evaluateKpisFromBalances, and
// asserts that each KPI produces the expected number. Tests the math, not
// the database I/O.
//
// Run: npx tsx outputs/kpi-engine-smoketest.mts

import {
  evaluateKpisFromBalances,
} from "../src/lib/fortnox-sie/kpi-engine"

function approx(a: number | null, b: number, eps = 0.01): boolean {
  if (a == null) return false
  return Math.abs(a - b) < eps
}

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg)
    process.exitCode = 1
  } else {
    console.log("ok:", msg)
  }
}

// ---------------------------------------------------------------------------
// Synthetic ledger: a tiny but realistic Swedish company.
//
// Balance sheet (UB, end of year):
//   1000 Inventories             —     (asset, sits inside 1400-1499)
//   1500 Customer receivables   500    (asset, 1400-1999 outside inventory)
//   1900 Cash                   200    (asset, 1400-1999)
//   1100 Buildings              300    (asset, 1000-1999 but outside 1400-1999)
//   2010 Equity                −400   (credit-balanced; |equity|=400)
//   2500 Tax debt               −200   (liability, inside 2400-2999)
//
//   Total assets = 1000 (1100=300 + 1500=500 + 1900=200)
//   Current assets (1400-1999) = 700  (1500+1900)
//   Inventory (1400-1499) = 0
//   Current liabilities (2400-2999) = -200 (so negated = 200)
//   Equity (2000-2099) = -400 (so negated = 400)
//
// Income statement (PSALDO summed across months):
//   3000 Sales            −1000   (credit-balanced; revenue = 1000)
//   4000 COGS               400   (debit-balanced; cogs = 400)
//   5000 Office              100  (opex 5-7)
//   7000 Salaries            300  (opex 5-7)
//
//   Revenue = 1000
//   Gross profit = 1000 - 400 = 600
//   Gross margin = 60%
//   EBIT = 1000 - 400 - 100 - 300 = 200
//
// Expected KPIs:
//   revenue            = 1000
//   gross_margin_pct   = 60%
//   ebit               = 200
//   kassalikviditet    = (700 - 0) / 200 × 100 = 350%
//   soliditet          = 400 / 1000 × 100 = 40%

// IB balances aren't used for these test KPIs except by kassalikviditet
// (which reads IB). We use the same numbers for IB and UB so we don't
// double-spec; production data would differ between the two.
const ib = new Map<string, number>([
  ["1100", 300],
  ["1500", 500],
  ["1900", 200],
  ["2010", -400],
  ["2500", -200],
])
const ub = new Map(ib)

// PSALDO: monthly amounts. We put it all in one month for simplicity; the
// engine sums across months so this is mathematically equivalent.
const psaldo = new Map<string, Map<string, number>>([
  ["3000", new Map([["202601", -1000]])],
  ["4000", new Map([["202601", 400]])],
  ["5000", new Map([["202601", 100]])],
  ["7000", new Map([["202601", 300]])],
])

const result = evaluateKpisFromBalances({
  customerId: "test-customer",
  financialYearFrom: "2026-01-01",
  balances: { ib, ub, psaldo, monthsCovered: ["202601"] },
})

const yearByKey: Record<string, (typeof result.kpis)[number]> = {}
for (const k of result.kpis) {
  if (k.period === "YEAR") yearByKey[k.kpiKey] = k
}

assert(approx(yearByKey.revenue?.value ?? null, 1000), `revenue=${yearByKey.revenue?.value}, expected 1000`)
assert(approx(yearByKey.gross_margin_pct?.value ?? null, 60), `gross_margin_pct=${yearByKey.gross_margin_pct?.value}, expected 60`)
assert(approx(yearByKey.ebit?.value ?? null, 200), `ebit=${yearByKey.ebit?.value}, expected 200`)
assert(approx(yearByKey.kassalikviditet?.value ?? null, 350), `kassalikviditet=${yearByKey.kassalikviditet?.value}, expected 350`)
assert(approx(yearByKey.soliditet?.value ?? null, 40), `soliditet=${yearByKey.soliditet?.value}, expected 40`)

// Flag rules:
//   gross_margin_pct target gte 0 → 60 ≥ 0 → not flagged
//   ebit target gte 0 → 200 ≥ 0 → not flagged
//   kassalikviditet target gte 100 → 350 ≥ 100 → not flagged
//   soliditet target gte 30 → 40 ≥ 30 → not flagged
assert(yearByKey.gross_margin_pct?.flagged === false, "gross_margin_pct should not be flagged")
assert(yearByKey.ebit?.flagged === false, "ebit should not be flagged")
assert(yearByKey.kassalikviditet?.flagged === false, "kassalikviditet should not be flagged")
assert(yearByKey.soliditet?.flagged === false, "soliditet should not be flagged")

// Per-month rows exist for every flow KPI and only for them.
const monthRows = result.kpis.filter((k) => k.period === "202601")
const monthKpiKeys = new Set(monthRows.map((k) => k.kpiKey))
assert(monthKpiKeys.has("revenue"), "monthly revenue row exists")
assert(monthKpiKeys.has("ebit"), "monthly ebit row exists")
assert(monthKpiKeys.has("gross_margin_pct"), "monthly gross_margin_pct row exists")
assert(!monthKpiKeys.has("kassalikviditet"), "monthly kassalikviditet row should NOT exist (stock KPI)")
assert(!monthKpiKeys.has("soliditet"), "monthly soliditet row should NOT exist (stock KPI)")

// Negative-margin test — flip COGS so gross margin goes negative.
const psaldoLoss = new Map<string, Map<string, number>>([
  ["3000", new Map([["202601", -1000]])],
  ["4000", new Map([["202601", 1500]])],
])
const lossResult = evaluateKpisFromBalances({
  customerId: "test-customer-loss",
  financialYearFrom: "2026-01-01",
  balances: { ib, ub, psaldo: psaldoLoss, monthsCovered: ["202601"] },
})
const lossYear: Record<string, (typeof lossResult.kpis)[number]> = {}
for (const k of lossResult.kpis) if (k.period === "YEAR") lossYear[k.kpiKey] = k

assert(approx(lossYear.gross_margin_pct?.value ?? null, -50), `loss gross_margin_pct=${lossYear.gross_margin_pct?.value}, expected -50`)
assert(lossYear.gross_margin_pct?.flagged === true, "negative gross margin should be flagged")
assert(lossYear.ebit?.flagged === true, "EBIT loss should be flagged")

// Zero-revenue test — divide-by-zero should return null, not NaN/Infinity.
const psaldoZero = new Map<string, Map<string, number>>([
  ["4000", new Map([["202601", 100]])],
])
const zeroResult = evaluateKpisFromBalances({
  customerId: "test-customer-zero",
  financialYearFrom: "2026-01-01",
  balances: { ib, ub, psaldo: psaldoZero, monthsCovered: ["202601"] },
})
const zeroYear: Record<string, (typeof zeroResult.kpis)[number]> = {}
for (const k of zeroResult.kpis) if (k.period === "YEAR") zeroYear[k.kpiKey] = k

assert(zeroYear.gross_margin_pct?.value == null, "zero revenue → gross_margin_pct should be null, not Infinity/NaN")
assert(zeroYear.gross_margin_pct?.flagged === false, "null value should not be flagged (avoids false positives)")

if (process.exitCode) {
  console.error("\n❌ One or more assertions failed.")
} else {
  console.log("\n✅ All KPI engine assertions passed.")
}
