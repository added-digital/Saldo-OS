"use client"

import * as React from "react"
import { Calculator, Database, Loader2, Play } from "lucide-react"
import { toast } from "sonner"

import { createClient } from "@/lib/supabase/client"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { useTranslation } from "@/hooks/use-translation"

/**
 * SIE Bookkeeping sync card.
 *
 * Visually identical to the firm-wide step cards in `/settings/sync` — same
 * shape, same button styling, same Running badge. Lives as one more grid
 * cell so the page looks like a uniform "sync control panel".
 *
 * Only the trigger lives here. Per-customer status, connection management,
 * and the recent-imports table are all on `/settings/sie`, which is the
 * canonical page for SIE-specific details.
 */
export function SieSyncCard() {
  const { t } = useTranslation()
  const [activeCount, setActiveCount] = React.useState<number | null>(null)
  const [syncing, setSyncing] = React.useState(false)

  React.useEffect(() => {
    // Fetch the active-connection count once on mount so we can disable
    // the button when there's nothing to sync and show a count in the
    // description.
    const supabase = createClient()
    let cancelled = false
    void (async () => {
      const { count, error } = await supabase
        .from("sie_connections")
        .select("id", { count: "exact", head: true })
        .eq("connection_status", "active")
      if (!cancelled && !error) setActiveCount(count ?? 0)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  async function handleSync() {
    if (syncing) return
    setSyncing(true)
    try {
      const response = await fetch("/api/fortnox-sie/sync-all", {
        method: "POST",
      })
      const data = (await response.json()) as
        | {
            ok: true
            summary: {
              total: number
              success: number
              failure: number
              duration_ms: number
            }
          }
        | { ok: false; error: string; message?: string }

      if (data.ok) {
        const { total, success, failure, duration_ms } = data.summary
        // Dynamic count messages are admin-only operational feedback —
        // they stay in English regardless of UI language. Keeping i18n
        // for static labels only avoids the awkward "translate this
        // template with embedded values" problem.
        const stem = t("settings.sync.sie.syncedStem", "Synced")
        if (failure === 0) {
          toast.success(`${stem} ${success}/${total}`)
        } else {
          const failedLabel = t("settings.sync.sie.failedLabel", "failed")
          toast.warning(
            `${stem} ${success}/${total} — ${failure} ${failedLabel}`,
          )
        }

        // Log the manual run into sync_jobs so it shows up alongside the
        // dispatcher-triggered rows on the Recent Sync Jobs list. We mark
        // it 'completed' immediately because the work has already happened
        // in the direct API call above — no edge function involved.
        const supabase = createClient()
        await supabase.from("sync_jobs").insert({
          status: "completed",
          progress: 100,
          current_step:
            failure === 0
              ? `Synced ${success}/${total} customers`
              : `Synced ${success}/${total} customers (${failure} failed)`,
          total_items: total,
          processed_items: success,
          step_name: "sie",
          batch_phase: null,
          batch_offset: 0,
          dispatch_lock: false,
          payload: {
            step_name: "sie",
            step_label: "SIE Bookkeeping",
            triggered_by: "manual",
            summary: { total, success, failure, duration_ms },
          },
        } as never)
      } else {
        toast.error(
          data.message ??
            t("settings.sync.sie.syncFailed", "SIE sync failed"),
        )
      }
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("settings.sync.sie.syncFailed", "SIE sync failed"),
      )
    } finally {
      setSyncing(false)
    }
  }

  // Description is fully static — counts and dynamic info live on the
  // button label and on /settings/sie. Keeps the dictionary entries clean.
  const description =
    activeCount === 0
      ? t(
          "settings.sync.sie.descriptionNone",
          "No connected customers yet. Connect customers in Settings → SIE to enable syncing.",
        )
      : t(
          "settings.sync.sie.description",
          "Sync general-ledger SIE exports for connected customers from their Fortnox tenants.",
        )

  const syncButtonLabel = (() => {
    if (syncing) return t("common.running", "Running")
    return t("common.run", "Run")
  })()

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Database className="size-4 text-muted-foreground" />
            {t("settings.sync.sie.title", "SIE Bookkeeping")}
          </CardTitle>
          {syncing && (
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
          disabled={syncing || activeCount === 0 || activeCount == null}
          onClick={handleSync}
        >
          <Play className="size-3" />
          {syncButtonLabel}
        </Button>
      </CardContent>
    </Card>
  )
}

/**
 * SIE KPI generation card.
 *
 * Sibling of SieSyncCard. Runs the KPI engine over every customer that
 * has at least one successful sie_imports row. The engine reads from
 * sie_period_balances + sie_account_balances and writes computed values
 * into sie_kpis, which powers the Nyckeltal pages.
 *
 * Kept separate from SieSyncCard because the two steps are independent —
 * you can re-run KPIs after a KPI-definition tweak without re-fetching
 * any SIE files. Same visual shape so the grid still reads uniformly.
 */
export function SieKpisCard() {
  const { t } = useTranslation()
  const [importCount, setImportCount] = React.useState<number | null>(null)
  const [generating, setGenerating] = React.useState(false)

  React.useEffect(() => {
    // Count of (customer, year) pairs we'd compute KPIs for. Same
    // distinct-pair logic as the engine uses for its loop, so the button
    // count matches the work it'll actually do.
    const supabase = createClient()
    let cancelled = false
    void (async () => {
      const { count, error } = await supabase
        .from("sie_imports")
        .select("id", { count: "exact", head: true })
        .eq("import_status", "success")
      if (!cancelled && !error) setImportCount(count ?? 0)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  async function handleGenerate() {
    if (generating) return
    setGenerating(true)
    try {
      const response = await fetch("/api/fortnox-sie/generate-kpis", {
        method: "POST",
      })
      const data = (await response.json()) as
        | {
            ok: true
            summary: {
              total: number
              success: number
              failure: number
              duration_ms: number
            }
          }
        | { ok: false; error: string; message?: string }

      if (data.ok) {
        const { total, success, failure, duration_ms } = data.summary
        const stem = t("settings.sync.sieKpis.generatedStem", "Generated")
        if (failure === 0) {
          toast.success(`${stem} ${success}/${total}`)
        } else {
          const failedLabel = t("settings.sync.sieKpis.failedLabel", "failed")
          toast.warning(
            `${stem} ${success}/${total} — ${failure} ${failedLabel}`,
          )
        }

        // Mirror the manual run into sync_jobs so the Recent Sync Jobs list
        // shows it like every other completed step.
        const supabase = createClient()
        await supabase.from("sync_jobs").insert({
          status: "completed",
          progress: 100,
          current_step:
            failure === 0
              ? `Computed KPIs for ${success}/${total} customer-years`
              : `Computed KPIs for ${success}/${total} customer-years (${failure} failed)`,
          total_items: total,
          processed_items: success,
          step_name: "sie-kpis",
          batch_phase: null,
          batch_offset: 0,
          dispatch_lock: false,
          payload: {
            step_name: "sie-kpis",
            step_label: "SIE Nyckeltal",
            triggered_by: "manual",
            summary: { total, success, failure, duration_ms },
          },
        } as never)
      } else {
        toast.error(
          data.message ??
            t("settings.sync.sieKpis.failed", "KPI generation failed"),
        )
      }
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("settings.sync.sieKpis.failed", "KPI generation failed"),
      )
    } finally {
      setGenerating(false)
    }
  }

  const description =
    importCount === 0
      ? t(
          "settings.sync.sieKpis.descriptionNone",
          "No SIE imports yet. Run the SIE sync first to populate ledger data, then KPIs can be computed.",
        )
      : t(
          "settings.sync.sieKpis.description",
          "Recompute revenue, gross margin, EBIT, kassalikviditet and soliditet for every customer with a synced SIE.",
        )

  const generateButtonLabel = (() => {
    if (generating) return t("common.running", "Running")
    return t("common.run", "Run")
  })()

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Calculator className="size-4 text-muted-foreground" />
            {t("settings.sync.sieKpis.title", "SIE Nyckeltal")}
          </CardTitle>
          {generating && (
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
          disabled={generating || importCount === 0 || importCount == null}
          onClick={handleGenerate}
        >
          <Play className="size-3" />
          {generateButtonLabel}
        </Button>
      </CardContent>
    </Card>
  )
}
