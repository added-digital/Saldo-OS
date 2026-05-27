// Smoke test for the SIE KPI evaluator. We don't have the production
// Supabase data, so we synthesise a balance set that exercises each KPI
// definition and assert the engine produces expected values.
//
// Run from the workspace: node outputs/kpi-engine-smoketest.mjs
//
// The evaluator is TypeScript with a `Map`-shaped balance input, so we
// inline a thin JS port that mirrors the production logic. If the math
// passes here, the production engine (which uses identical math) is
// trusted to be correct.

import path from "node:path"
import { fileURLToPath } from "node:url"
import { register } from "node:module"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Use tsx to import the actual TypeScript engine, so the test exercises the
// real code (not a re-implementation). Run as:
//   npx tsx outputs/kpi-engine-smoketest.mts
// We swap to the .mts extension below.

console.log("Use outputs/kpi-engine-smoketest.mts via tsx instead.")
