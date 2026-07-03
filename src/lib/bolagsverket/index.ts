// =====================================================================
// Bolagsverket — public entry point
// =====================================================================
// Import from "@/lib/bolagsverket" everywhere. The factory decides live vs
// stub so that choice lives in exactly one place.
//
// Selection:
//   • BOLAGSVERKET_USE_STUB=true            -> always stub
//   • otherwise, if credentials are present -> live
//   • otherwise                             -> stub (safe default until the
//                                              decrypted zip creds are set)

import { LiveBolagsverketClient, StubBolagsverketClient } from "./client"
import type { BolagsverketClient } from "./types"

export * from "./types"
export { normalizeOrgNumber } from "./client"

export function getBolagsverketClient(): BolagsverketClient {
  const forceStub = process.env.BOLAGSVERKET_USE_STUB === "true"
  const hasCreds =
    !!process.env.BOLAGSVERKET_CLIENT_ID &&
    !!process.env.BOLAGSVERKET_CLIENT_SECRET

  if (forceStub || !hasCreds) {
    return new StubBolagsverketClient()
  }
  return new LiveBolagsverketClient()
}
