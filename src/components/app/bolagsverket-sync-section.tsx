"use client"

import * as React from "react"
import Link from "next/link"
import { AlertTriangle, Landmark, Play, RefreshCw } from "lucide-react"
import { toast } from "sonner"

import { createClient } from "@/lib/supabase/client"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { SyncCardShell } from "@/components/app/sync-card-shell"
import { useTranslation } from "@/hooks/use-translation"
import { useUser } from "@/hooks/use-user"

/**
 * Bolagsverket enrichment card (Settings → Sync).
 *
 * A "smart" sweep: it only processes ACTIVE customers that actually need it —
 * never-enriched (new) or last checked > 30 days ago (stale). It drives the
 * work from the browser, calling the per-customer /api/bolagsverket/refresh
 * route in sequence with pacing for Bolagsverket's 60-calls/min limit.
 *
 * Why browser-driven and not a backend job: the full sweep takes ~30 min
 * because of the rate limit, which is far longer than a serverless request can
 * run. Keeping it here reuses the existing (admin-gated) refresh route with no
 * new backend infrastructure. Closing the tab stops it; re-running just picks
 * up whatever is still stale (idempotent).
 */

const STALE_DAYS = 30
const PACING_MS = 2200 // ~27 customers/min × 2 calls ≈ 54/min, under the 60 cap

type Tally = {
  confirmed: number
  no_rakenskapsar: number
  name_mismatch: number
  not_found: number
  no_orgnr: number
  error: number
}

function staleFilter() {
  const cutoff = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000).toISOString()
  // Never enriched, OR last checked > 30 days ago, OR currently flagged as a
  // mismatch (so re-running re-evaluates flagged customers and clears any that
  // now match — e.g. after a matching-logic fix or an org-number correction).
  return `bolagsverket_updated_at.is.null,bolagsverket_updated_at.lt.${cutoff},bolagsverket_name_mismatch.is.true`
}

export function BolagsverketSyncCard() {
  const { t } = useTranslation()
  const { isAdmin } = useUser()
  const [pending, setPending] = React.useState<number | null>(null)
  const [running, setRunning] = React.useState(false)
  const [startingAll, setStartingAll] = React.useState(false)
  const [progress, setProgress] = React.useState<{ done: number; total: number }>({
    done: 0,
    total: 0,
  })

  const refreshCount = React.useCallback(async () => {
    const supabase = createClient()
    const { count, error } = await supabase
      .from("customers")
      .select("id", { count: "exact", head: true })
      .eq("status", "active")
      .or(staleFilter())
    if (!error) setPending(count ?? 0)
  }, [])

  React.useEffect(() => {
    void refreshCount()
  }, [refreshCount])

  async function handleRun() {
    if (running) return
    setRunning(true)
    const tally: Tally = {
      confirmed: 0,
      no_rakenskapsar: 0,
      name_mismatch: 0,
      not_found: 0,
      no_orgnr: 0,
      error: 0,
    }
    try {
      const supabase = createClient()
      // Which active customers need enrichment right now (new or stale).
      const { data, error } = await supabase
        .from("customers")
        .select("id")
        .eq("status", "active")
        .or(staleFilter())
        .order("bolagsverket_updated_at", { ascending: true, nullsFirst: true })
      if (error) {
        toast.error(error.message)
        return
      }
      const ids = (data ?? []).map((r) => (r as { id: string }).id)
      setProgress({ done: 0, total: ids.length })
      if (ids.length === 0) {
        toast.success(t("settings.sync.bolagsverket.upToDate", "All active customers are up to date."))
        return
      }

      let done = 0
      for (const id of ids) {
        try {
          const res = await fetch("/api/bolagsverket/refresh", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ customerId: id }),
          })
          const payload = (await res.json().catch(() => ({}))) as {
            ok?: boolean
            result?: { status?: keyof Tally }
          }
          if (res.ok && payload.ok && payload.result?.status) {
            tally[payload.result.status] += 1
          } else {
            tally.error += 1
          }
        } catch {
          tally.error += 1
        }
        done += 1
        setProgress({ done, total: ids.length })
        // Pace for the rate limit (skip the wait after the final one).
        if (done < ids.length) await new Promise((r) => setTimeout(r, PACING_MS))
      }

      // Dynamic count summary stays in English (admin operational feedback),
      // matching the SIE cards' convention.
      const reviewNote = tally.name_mismatch > 0 ? ` — ${tally.name_mismatch} to review` : ""
      if (tally.error > 0) {
        toast.warning(`Enriched ${done} customers (${tally.error} failed)${reviewNote}`)
      } else {
        toast.success(`Enriched ${done} customers${reviewNote}`)
      }

      // Log into sync_jobs so it shows in Recent Sync Jobs like the other steps.
      await supabase.from("sync_jobs").insert({
        status: "completed",
        progress: 100,
        current_step: `Enriched ${done} customers from Bolagsverket`,
        total_items: ids.length,
        processed_items: done,
        step_name: "bolagsverket",
        batch_phase: null,
        batch_offset: 0,
        dispatch_lock: false,
        payload: {
          step_name: "bolagsverket",
          step_label: "Bolagsverket",
          triggered_by: "manual",
          summary: { ...tally, total: ids.length },
        },
      } as never)

      await refreshCount()
    } finally {
      setRunning(false)
    }
  }

  async function handleRunAll() {
    if (startingAll) return
    setStartingAll(true)
    try {
      const res = await fetch("/api/bolagsverket/sweep", { method: "POST" })
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        error?: string
        message?: string
      }
      if (!res.ok || !data.ok) {
        toast.error(
          data.message ??
            data.error ??
            t("settings.sync.bolagsverket.allFailed", "Couldn't start full sweep"),
        )
        return
      }
      toast.success(
        t(
          "settings.sync.bolagsverket.allStarted",
          "Full sweep started — all active customers, running in the background (~30 min). Check Recent Sync Jobs.",
        ),
      )
    } finally {
      setStartingAll(false)
    }
  }

  if (!isAdmin) return null

  const description =
    pending === 0
      ? t("settings.sync.bolagsverket.upToDate", "All active customers are up to date.")
      : t(
          "settings.sync.bolagsverket.description",
          "Updates org number and räkenskapsår from Bolagsverket for active customers that are new or haven't been checked in 30 days.",
        )

  const buttonLabel = running
    ? `${progress.done}/${progress.total}`
    : pending && pending > 0
      ? `${t("common.run", "Run")} (${pending})`
      : t("common.run", "Run")

  return (
    <SyncCardShell
      icon={Landmark}
      title={t("settings.sync.bolagsverket.title", "Bolagsverket")}
      description={description}
      running={running}
      runningLabel={t("common.running", "Running")}
    >
      <div className="space-y-2">
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            disabled={running || pending === 0 || pending == null}
            onClick={handleRun}
            title={t(
              "settings.sync.bolagsverket.runHint",
              "Enrich only new or stale customers (runs in this tab).",
            )}
          >
            <Play className="size-3" />
            {buttonLabel}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            disabled={running || startingAll}
            onClick={handleRunAll}
            title={t(
              "settings.sync.bolagsverket.runAllHint",
              "Enrich all active customers in the background (~30 min).",
            )}
          >
            <RefreshCw className={startingAll ? "size-3 animate-spin" : "size-3"} />
            {startingAll
              ? t("settings.sync.bolagsverket.allStarting", "Starting…")
              : t("settings.sync.bolagsverket.runAll", "Run all")}
          </Button>
        </div>
        {running && (
          <p className="text-xs text-muted-foreground">
            {t("settings.sync.bolagsverket.runningHint", "Keep this tab open until it finishes. You can re-run it anytime.")}
          </p>
        )}
      </div>
    </SyncCardShell>
  )
}

// ---------------------------------------------------------------------
// Needs-review list — customers Bolagsverket flagged as a name mismatch
// ---------------------------------------------------------------------

interface ReviewRow {
  id: string
  name: string | null
  org_number: string | null
  org_number_bv: string | null
  bolagsverket_company_data: Record<string, unknown> | null
}

// Dig the registered company name out of the stored raw payload so the admin
// can see WHICH company that org number actually belongs to.
interface RawCompanyData {
  organisation?: {
    organisationsnamn?: {
      organisationsnamnLista?: Array<{
        namn?: string
        organisationsnamntyp?: { kod?: string }
      }>
    }
  }
}
function bvNameFromRaw(raw: Record<string, unknown> | null): string | null {
  const data = raw as RawCompanyData | null
  const list = data?.organisation?.organisationsnamn?.organisationsnamnLista ?? []
  const entry =
    list.find((n) => n.organisationsnamntyp?.kod === "FORETAGSNAMN") ?? list[0]
  return entry?.namn ?? null
}

/**
 * Lists active customers where Bolagsverket returned a DIFFERENT company for
 * the stored org number (bolagsverket_name_mismatch = true) — the "X to review"
 * from a sweep, made clickable. Data on these was left untouched; a human
 * verifies the org number. Hidden entirely when there's nothing to review.
 */
export function BolagsverketReviewCard() {
  const { t } = useTranslation()
  const { isAdmin } = useUser()
  const [rows, setRows] = React.useState<ReviewRow[] | null>(null)

  React.useEffect(() => {
    const supabase = createClient()
    let cancelled = false
    void (async () => {
      const { data } = await supabase
        .from("customers")
        .select("id, name, org_number, org_number_bv, bolagsverket_company_data")
        .eq("status", "active")
        .eq("bolagsverket_name_mismatch", true)
        .order("name", { ascending: true })
      if (!cancelled) setRows((data ?? []) as unknown as ReviewRow[])
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Hide for non-admins and when there's nothing to review.
  if (!isAdmin || !rows || rows.length === 0) return null

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <AlertTriangle className="size-4 text-semantic-warning" />
          <CardTitle className="text-base">
            {t("settings.sync.bolagsverketReview.title", "Bolagsverket — needs review")}
          </CardTitle>
          <Badge
            variant="outline"
            className="border-semantic-warning/40 bg-semantic-warning/10 text-semantic-warning"
          >
            {rows.length}
          </Badge>
        </div>
        <CardDescription>
          {t(
            "settings.sync.bolagsverketReview.description",
            "Bolagsverket returned a different company for these org numbers. Their data was left unchanged — verify the org number on each card.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {rows.map((r) => {
          const bvName = bvNameFromRaw(r.bolagsverket_company_data)
          return (
            <Link
              key={r.id}
              href={`/customers/${r.id}`}
              className="flex flex-col gap-0.5 rounded-md border px-3 py-2 text-sm transition-colors hover:bg-accent"
            >
              <span className="font-medium">{r.name ?? "—"}</span>
              <span className="text-xs text-muted-foreground">
                {t("settings.sync.bolagsverketReview.ours", "Ours")}: {r.org_number ?? "—"}
                {"  ·  "}
                {t("settings.sync.bolagsverketReview.bolagsverket", "Bolagsverket")}:{" "}
                {bvName ? `${bvName} (${r.org_number_bv ?? "—"})` : (r.org_number_bv ?? "—")}
              </span>
            </Link>
          )
        })}
      </CardContent>
    </Card>
  )
}
