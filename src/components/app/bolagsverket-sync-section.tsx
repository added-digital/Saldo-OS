"use client"

import * as React from "react"
import { Building2, Loader2, Play } from "lucide-react"
import { toast } from "sonner"

import { createClient } from "@/lib/supabase/client"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
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
  return `bolagsverket_updated_at.is.null,bolagsverket_updated_at.lt.${cutoff}`
}

export function BolagsverketSyncCard() {
  const { t } = useTranslation()
  const { isAdmin } = useUser()
  const [pending, setPending] = React.useState<number | null>(null)
  const [running, setRunning] = React.useState(false)
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

  if (!isAdmin) return null

  const description =
    pending === 0
      ? t("settings.sync.bolagsverket.upToDate", "All active customers are up to date.")
      : t(
          "settings.sync.bolagsverket.description",
          "Enrich new and out-of-date active customers' org number and räkenskapsår from Bolagsverket.",
        )

  const buttonLabel = running
    ? `${progress.done}/${progress.total}`
    : pending && pending > 0
      ? `${t("common.run", "Run")} (${pending})`
      : t("common.run", "Run")

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Building2 className="size-4 text-muted-foreground" />
            {t("settings.sync.bolagsverket.title", "Bolagsverket")}
          </CardTitle>
          {running && (
            <Badge variant="secondary" className="font-normal">
              <Loader2 className="mr-1 size-3 animate-spin" />
              {t("common.running", "Running")}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{description}</p>
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          disabled={running || pending === 0 || pending == null}
          onClick={handleRun}
        >
          <Play className="size-3" />
          {buttonLabel}
        </Button>
        {running && (
          <p className="text-xs text-muted-foreground">
            {t("settings.sync.bolagsverket.runningHint", "Keep this tab open until it finishes. You can re-run it anytime.")}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
