/**
 * Verification harness for the pricing engine.
 *
 * Runs the engine against every customer row exported from the reference
 * workbook (Huvud excel.xlsm) and asserts the computed Fortnox price and Reda
 * price match the workbook's own cached values.
 *
 * Run:  npx tsx src/lib/pricing/verify.ts
 */

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { calcFortnoxPrice, calcRedaPrice, round2 } from "./engine"

interface Fixture {
  name: string
  custNo: string | number | null
  discountPct: number | null
  fixedPrice: number | null
  redaFixed: number | string | null
  fortnoxPrice: number | null
  redaPrice: number | null
  listPrice: number | null
  extraCost: number | null
  redaCost: number | null
}

const here = dirname(fileURLToPath(import.meta.url))
const rows: Fixture[] = JSON.parse(
  readFileSync(join(here, "__fixtures__", "kundnr-reference.json"), "utf8"),
)

const n = (v: unknown) => (typeof v === "number" ? v : Number(v) || 0)
let okI = 0
let okK = 0
const bad: unknown[] = []

for (const r of rows) {
  const input = {
    kundnr: r.custNo,
    discountPct: r.discountPct,
    fixedPrice: r.fixedPrice,
    redaFixedPrice: r.redaFixed,
    listPrice: r.listPrice,
    extraLicenseCost: r.extraCost,
    redaCost: r.redaCost,
  }
  const ci = calcFortnoxPrice(input)
  const ck = calcRedaPrice(input)
  if (Math.abs(ci - n(r.fortnoxPrice)) < 0.02) okI++
  else bad.push({ name: r.name, col: "I", exp: r.fortnoxPrice, got: round2(ci) })
  if (Math.abs(ck - n(r.redaPrice)) < 0.02) okK++
  else bad.push({ name: r.name, col: "K", exp: r.redaPrice, got: round2(ck) })
}

console.log(`rows: ${rows.length}`)
console.log(`Fortnox price  match: ${okI}  mismatch: ${rows.length - okI}`)
console.log(`Reda price     match: ${okK}  mismatch: ${rows.length - okK}`)

if (bad.length) {
  console.error("MISMATCHES:", JSON.stringify(bad.slice(0, 20), null, 2))
  process.exit(1)
}
console.log("*** ALL ROWS MATCH ***")
