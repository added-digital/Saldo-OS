import type { NextRequest } from "next/server"

type NightlySyncStep =
  | "customers"
  | "invoices"
  | "time-reports"
  | "contracts"
  | "articles"
  | "generate-kpis"
  | "sie"
  | "sie-kpis"

// Keep in sync with enqueue_nightly_sync_chain() in
// supabase/migrations/00060_nightly_chain_with_sie.sql. The SQL function is
// what actually runs in production (pg_cron); this array exists for the
// alternate /api/sync/nightly fallback path and for any UI code that wants
// to know the canonical chain order.
//
// SIE steps run last so a per-customer SIE failure never blocks the
// firm-wide steps that the rest of the app depends on.
const NIGHTLY_SYNC_STEPS: NightlySyncStep[] = [
  "customers",
  "invoices",
  "time-reports",
  "contracts",
  "articles",
  "generate-kpis",
  "sie",
  "sie-kpis",
]

const STEP_LABELS: Record<NightlySyncStep, string> = {
  customers: "Customers",
  invoices: "Invoices",
  "time-reports": "Time Reports",
  contracts: "Contracts",
  articles: "Articles",
  "generate-kpis": "Generate KPIs",
  sie: "SIE Bookkeeping",
  "sie-kpis": "SIE Nyckeltal",
}

function getStockholmClock(now: Date) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Stockholm",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })

  const parts = formatter.formatToParts(now)
  const year = parts.find((part) => part.type === "year")?.value ?? "0000"
  const month = parts.find((part) => part.type === "month")?.value ?? "01"
  const day = parts.find((part) => part.type === "day")?.value ?? "01"
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0")

  return {
    date: `${year}-${month}-${day}`,
    hour,
  }
}

function getNightlyChainId(now: Date): string {
  const stockholm = getStockholmClock(now)
  return `nightly-sync-${stockholm.date}`
}

function shouldStartNightlyChain(now: Date): boolean {
  const stockholm = getStockholmClock(now)
  return stockholm.hour >= 1
}

function isCronAuthorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET?.trim()
  if (!secret) {
    return process.env.NODE_ENV !== "production"
  }

  return request.headers.get("authorization") === `Bearer ${secret}`
}

export {
  NIGHTLY_SYNC_STEPS,
  STEP_LABELS,
  getNightlyChainId,
  shouldStartNightlyChain,
  isCronAuthorized,
}

export type { NightlySyncStep }
