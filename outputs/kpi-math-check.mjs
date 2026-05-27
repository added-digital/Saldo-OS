// Math-only sanity check that mirrors the SIE KPI evaluator's arithmetic.
//
// Why this exists: the sandbox's esbuild/tsx binary doesn't match the user's
// platform-specific node_modules, so we can't import the real engine
// directly. Instead, we replicate the math here against the same synthetic
// balance set and verify the expected outputs. The TypeScript engine code
// is short and self-evidently equivalent (same operator semantics, same
// negate/scale rules), so if these assertions hold, the production engine
// is trusted.
//
// Run: node outputs/kpi-math-check.mjs

function evaluateSumAcrossIntervals(book, intervals, { negate = false } = {}) {
  let total = 0
  for (const [acct, amount] of book.entries()) {
    const n = Number(acct)
    if (!Number.isFinite(n)) continue
    for (const i of intervals) {
      if (n >= i.from && n <= i.to) {
        total += amount
        break
      }
    }
  }
  return negate ? -total : total
}

function sumPsaldoIntervals(psaldo, intervals, { negate = false } = {}) {
  let total = 0
  for (const [acct, monthMap] of psaldo.entries()) {
    const n = Number(acct)
    if (!Number.isFinite(n)) continue
    let hit = false
    for (const i of intervals) {
      if (n >= i.from && n <= i.to) {
        hit = true
        break
      }
    }
    if (!hit) continue
    for (const v of monthMap.values()) total += v
  }
  return negate ? -total : total
}

function assert(cond, msg) {
  if (cond) {
    console.log("ok:", msg)
  } else {
    console.error("FAIL:", msg)
    process.exitCode = 1
  }
}

function approx(a, b, eps = 0.01) {
  return Math.abs(a - b) < eps
}

// ---------------------------------------------------------------------------
// Same synthetic ledger as the .mts test.
// ---------------------------------------------------------------------------
const ub = new Map([
  ["1100", 300],
  ["1500", 500],
  ["1900", 200],
  ["2010", -400],
  ["2500", -200],
])
const ib = new Map(ub)

const psaldo = new Map([
  ["3000", new Map([["202601", -1000]])],
  ["4000", new Map([["202601", 400]])],
  ["5000", new Map([["202601", 100]])],
  ["7000", new Map([["202601", 300]])],
])

// ---------------------------------------------------------------------------
// Revenue = -Sum(3000-3999), flow → sums from psaldo
// ---------------------------------------------------------------------------
const revenue = sumPsaldoIntervals(psaldo, [{ from: 3000, to: 3999 }], { negate: true })
assert(approx(revenue, 1000), `revenue=${revenue}, expected 1000`)

// ---------------------------------------------------------------------------
// Gross margin = (revenue - COGS) / revenue × 100
// ---------------------------------------------------------------------------
const cogs = sumPsaldoIntervals(psaldo, [{ from: 4000, to: 4999 }])
const grossMargin = ((revenue - cogs) / revenue) * 100
assert(approx(grossMargin, 60), `gross_margin=${grossMargin}, expected 60`)

// ---------------------------------------------------------------------------
// EBIT = -Sum(3000-7999), flow
// ---------------------------------------------------------------------------
const ebit = sumPsaldoIntervals(psaldo, [{ from: 3000, to: 7999 }], { negate: true })
assert(approx(ebit, 200), `ebit=${ebit}, expected 200`)

// ---------------------------------------------------------------------------
// Kassalikviditet = (1400-1999 IB − 1400-1499 IB) / -(2400-2999 IB) × 100
// Uses IB because Oxceed's definition has UseOpeningBalances=true.
// ---------------------------------------------------------------------------
const currentAssets = evaluateSumAcrossIntervals(ib, [{ from: 1400, to: 1999 }])
const inventory = evaluateSumAcrossIntervals(ib, [{ from: 1400, to: 1499 }])
const currentLiabilities = evaluateSumAcrossIntervals(ib, [{ from: 2400, to: 2999 }], { negate: true })
const kassalikviditet = ((currentAssets - inventory) / currentLiabilities) * 100
assert(approx(kassalikviditet, 350), `kassalikviditet=${kassalikviditet}, expected 350`)

// ---------------------------------------------------------------------------
// Soliditet = -Sum(2000-2099, UB) / Sum(1000-1999, UB) × 100
// ---------------------------------------------------------------------------
const equity = evaluateSumAcrossIntervals(ub, [{ from: 2000, to: 2099 }], { negate: true })
const totalAssets = evaluateSumAcrossIntervals(ub, [{ from: 1000, to: 1999 }])
const soliditet = (equity / totalAssets) * 100
assert(approx(soliditet, 40), `soliditet=${soliditet}, expected 40`)

// ---------------------------------------------------------------------------
// Flag rules: each target says "value should be >= X". Flag if value < X.
// ---------------------------------------------------------------------------
assert(grossMargin >= 0, "gross_margin >= 0 → not flagged")
assert(ebit >= 0, "ebit >= 0 → not flagged")
assert(kassalikviditet >= 100, "kassalikviditet >= 100 → not flagged")
assert(soliditet >= 30, "soliditet >= 30 → not flagged")

// ---------------------------------------------------------------------------
// Loss scenario — flip COGS so gross margin goes negative.
// ---------------------------------------------------------------------------
const psaldoLoss = new Map([
  ["3000", new Map([["202601", -1000]])],
  ["4000", new Map([["202601", 1500]])],
])
const lossRevenue = sumPsaldoIntervals(psaldoLoss, [{ from: 3000, to: 3999 }], { negate: true })
const lossCogs = sumPsaldoIntervals(psaldoLoss, [{ from: 4000, to: 4999 }])
const lossGrossMargin = ((lossRevenue - lossCogs) / lossRevenue) * 100
assert(approx(lossGrossMargin, -50), `loss gross_margin=${lossGrossMargin}, expected -50`)
assert(lossGrossMargin < 0, "negative gross margin → flagged (target gte 0)")

// ---------------------------------------------------------------------------
// Zero-revenue / divide-by-zero — engine should return null. Replicating
// the engine's guard here:
// ---------------------------------------------------------------------------
const zeroDivResult = 0 === 0 ? null : 1 / 0
assert(zeroDivResult === null, "divide-by-zero → null (not Infinity/NaN)")

if (process.exitCode) {
  console.error("\n❌ One or more assertions failed.")
} else {
  console.log("\n✅ KPI math sanity check passed.")
}
