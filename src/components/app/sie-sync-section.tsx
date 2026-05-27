"use client"

import * as React from "react"
import { Database, Loader2, Play } from "lucide-react"
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
        const { total, success, failure } = data.summary
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
    if (syncing) return t("settings.sync.sie.syncing", "Syncing…")
    const label = t("settings.sync.sie.syncAll", "Sync all connected")
    if (activeCount && activeCount > 0) return `${label} (${activeCount})`
    return label
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
