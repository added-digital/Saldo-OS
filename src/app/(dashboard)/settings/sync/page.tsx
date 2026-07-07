"use client"

import * as React from "react"
import {
  Loader2,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Play,
  Users,
  Building2,
  ReceiptText,
  Package,
  CalendarClock,
  FileSignature,
  Sigma,
  Trash2,
} from "lucide-react"

import { createClient } from "@/lib/supabase/client"
import type { SyncJob } from "@/types/database"
import {
  useSync,
  SYNC_STEPS,
  STEP_LABELS,
  type SyncStep,
} from "@/hooks/use-sync"
import { useUser } from "@/hooks/use-user"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { SieKpisCard, SieSyncCard } from "@/components/app/sie-sync-section"
import { BolagsverketSyncCard, BolagsverketReviewCard } from "@/components/app/bolagsverket-sync-section"
import { SyncCardShell } from "@/components/app/sync-card-shell"
import { formatDateTime } from "@/lib/utils"
import { useTranslation } from "@/hooks/use-translation"
import { toast } from "sonner"

const STEP_ICONS: Record<SyncStep, React.ElementType> = {
  customers: Building2,
  employees: Users,
  invoices: ReceiptText,
  articles: Package,
  "time-reports": CalendarClock,
  contracts: FileSignature,
  "generate-kpis": Sigma,
}

const STEP_DESCRIPTIONS: Record<SyncStep, string> = {
  customers: "Sync customer data, cost centers, and link account managers",
  employees: "Sync employees, create user accounts, and link cost centers",
  invoices: "Sync invoice headers and compute turnover KPIs per customer",
  articles: "Sync Fortnox time articles into the article registry",
  "time-reports": "Sync attendance transactions and compute reported hours",
  contracts: "Sync contracts and compute contract value per customer",
  "generate-kpis": "Recompute all customer KPI fields from existing invoices, time reports, and contracts",
}

const STEP_LABEL_KEYS: Record<SyncStep, string> = {
  customers: "settings.sync.step.customers",
  employees: "settings.sync.step.employees",
  invoices: "settings.sync.step.invoices",
  articles: "settings.sync.step.articles",
  "time-reports": "settings.sync.step.timeReports",
  contracts: "settings.sync.step.contracts",
  "generate-kpis": "settings.sync.step.generateKpis",
}

const STEP_DESCRIPTION_KEYS: Record<SyncStep, string> = {
  customers: "settings.sync.desc.customers",
  employees: "settings.sync.desc.employees",
  invoices: "settings.sync.desc.invoices",
  articles: "settings.sync.desc.articles",
  "time-reports": "settings.sync.desc.timeReports",
  contracts: "settings.sync.desc.contracts",
  "generate-kpis": "settings.sync.desc.generateKpis",
}

export default function SyncPage() {
  const { isAdmin } = useUser()
  const { t } = useTranslation()
  const { syncing, startSync } = useSync()
  const [recentJobs, setRecentJobs] = React.useState<SyncJob[]>([])
  const [loadingJobs, setLoadingJobs] = React.useState(true)
  const [clearing, setClearing] = React.useState(false)
  const [clearHistoryDialogOpen, setClearHistoryDialogOpen] =
    React.useState(false)

  async function handleClearHistory() {
    setClearing(true)
    const supabase = createClient()
    const { error } = await supabase
      .from("sync_jobs")
      .delete()
      .not("status", "in", '("pending","processing")' as never)
    if (error) {
      toast.error(t("settings.sync.clearFailed", "Failed to clear sync history"))
    } else {
      toast.success(t("settings.sync.clearSuccess", "Sync history cleared"))
      fetchRecentJobs()
    }
    setClearing(false)
    setClearHistoryDialogOpen(false)
  }
  const [retryingJobId, setRetryingJobId] = React.useState<string | null>(null)

  const fetchRecentJobs = React.useCallback(async () => {
    const supabase = createClient()
    const { data } = await supabase
      .from("sync_jobs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(20)

    setRecentJobs((data ?? []) as unknown as SyncJob[])
    setLoadingJobs(false)
  }, [])

  React.useEffect(() => {
    fetchRecentJobs()
  }, [fetchRecentJobs])

  React.useEffect(() => {
    const supabase = createClient()

    const channel = supabase
      .channel("sync-jobs-list")
      .on(
        "postgres_changes" as never,
        {
          event: "*",
          schema: "public",
          table: "sync_jobs",
        } as never,
        () => {
          fetchRecentJobs()
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [fetchRecentJobs])

  const continueFailedJob = React.useCallback(
    async (job: SyncJob) => {
      const rawPayload =
        job.payload && typeof job.payload === "object"
          ? (job.payload as Record<string, unknown>)
          : {}

      const rawStepName =
        typeof job.step_name === "string" && job.step_name.length > 0
          ? job.step_name
          : typeof rawPayload.step_name === "string"
            ? rawPayload.step_name
            : ""

      const isSyncStep = (value: string): value is SyncStep =>
        SYNC_STEPS.includes(value as SyncStep)

      if (!isSyncStep(rawStepName)) {
        toast.error(t("settings.sync.retryInvalidStep", "Failed to continue: unknown step"))
        return
      }

      const step = rawStepName
      const stepLabel =
        typeof rawPayload.step_label === "string" && rawPayload.step_label.length > 0
          ? rawPayload.step_label
          : STEP_LABELS[step]

      const payload: Record<string, unknown> = {
        ...rawPayload,
        step_name: step,
        step_label: stepLabel,
      }

      const batchPhase =
        typeof job.batch_phase === "string" && job.batch_phase.length > 0
          ? job.batch_phase
          : "list"

      const batchOffset =
        typeof job.batch_offset === "number" && Number.isFinite(job.batch_offset) && job.batch_offset > 0
          ? job.batch_offset
          : 0

      setRetryingJobId(job.id)
      const supabase = createClient()
      const { error } = await supabase.from("sync_jobs").insert({
        status: "pending",
        progress: 0,
        current_step: `Waiting for ${stepLabel}...`,
        total_items: 0,
        processed_items: 0,
        step_name: step,
        batch_phase: batchPhase,
        batch_offset: batchOffset,
        dispatch_lock: false,
        payload,
      } as never)

      if (error) {
        toast.error(t("settings.sync.retryFailed", "Failed to continue sync job"))
      } else {
        toast.success(t("settings.sync.retryStarted", "Sync step queued to continue"))
        fetchRecentJobs()
      }
      setRetryingJobId(null)
    },
    [fetchRecentJobs, t]
  )

  if (!isAdmin) {
    return (
      <div className="space-y-6">
        <div className="h-48 animate-pulse rounded-lg border bg-muted" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {SYNC_STEPS.map((step) => {
          const Icon = STEP_ICONS[step]
          const runningJobs = recentJobs.filter(
            (j) =>
              (j.status === "pending" || j.status === "processing") &&
              ((j.payload as Record<string, unknown> | null)?.step_name === step ||
                j.step_name === step)
          )
          const isRunning = runningJobs.length > 0

          return (
            <SyncCardShell
              key={step}
              icon={Icon}
              title={t(STEP_LABEL_KEYS[step], STEP_LABELS[step])}
              description={t(STEP_DESCRIPTION_KEYS[step], STEP_DESCRIPTIONS[step])}
              running={isRunning}
              runningLabel={t("common.running", "Running")}
            >
              {step === "invoices" ? (
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1"
                    disabled={syncing || isRunning}
                    onClick={() =>
                      startSync([step], { syncMode: "skip_finalized" })
                    }
                  >
                    <Play className="size-3" />
                    {t("settings.sync.skipFinalized", "Skip Finalized")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1"
                    disabled={syncing || isRunning}
                    onClick={() =>
                      startSync([step], { syncMode: "enrich_all" })
                    }
                  >
                    <Play className="size-3" />
                    {t("settings.sync.enrichAll", "Enrich All")}
                  </Button>
                </div>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  disabled={syncing || isRunning}
                  onClick={() => startSync([step])}
                >
                  <Play className="size-3" />
                  {t("common.run", "Run")}
                </Button>
              )}
            </SyncCardShell>
          )
        })}
        {/* SIE Bookkeeping — slotted as another grid cell so the layout is
            uniform. Per-customer scoped (not firm-wide), but the user-
            facing trigger is the same shape: one button to run a sync.
            Detailed per-customer status lives on /settings/sie. */}
        <SieSyncCard />
        {/* SIE Nyckeltal — derived KPI computation step. Independent from
            the SIE sync above: re-running KPIs doesn't refetch anything,
            it just walks the already-stored ledger and rewrites sie_kpis.
            Surfaced on /key-metrics. */}
        <SieKpisCard />
        {/* Bolagsverket enrichment — browser-driven smart sweep of active
            customers that are new or >30 days stale. Reuses the per-customer
            refresh route; admin-only (card hides itself for non-admins). */}
        <BolagsverketSyncCard />
      </div>

      {/* Bolagsverket mismatches to review (hidden when there are none). */}
      <BolagsverketReviewCard />

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <CardTitle className="text-base">{t("settings.sync.recentJobs", "Recent Sync Jobs")}</CardTitle>
              <CardDescription>
                {t("settings.sync.recentJobsDescription", "History of the last 20 sync operations")}
              </CardDescription>
            </div>
            {recentJobs.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                disabled={clearing}
                onClick={() => setClearHistoryDialogOpen(true)}
              >
                <Trash2 className="size-4" />
                {clearing
                  ? t("settings.sync.clearing", "Clearing...")
                  : t("settings.sync.clearHistory", "Clear History")}
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {loadingJobs ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : recentJobs.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t("settings.sync.noJobs", "No sync jobs have been run yet")}
            </p>
          ) : (
            <div className="space-y-2">
              {recentJobs.map((job) => {
                const stepLabel = (job.payload as Record<string, unknown> | null)?.step_label as string | undefined

                return (
                  <div
                    key={job.id}
                    className="flex items-center justify-between rounded-md border p-3"
                  >
                    <div className="flex items-center gap-3">
                      <SyncStatusIcon status={job.status} />
                      <div className="space-y-0.5">
                        <p className="text-sm font-medium">
                          {stepLabel ?? job.current_step ?? t("settings.sync.fallbackSync", "Sync")}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {formatDateTime(job.created_at)}
                        </p>
                        {job.status === "failed" && job.error_message && (
                          <p className="text-xs text-destructive">
                            {job.error_message}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {job.total_items > 0 && (
                        <span className="text-xs text-muted-foreground">
                          {job.processed_items}/{job.total_items} {t("common.items", "items")}
                        </span>
                      )}
                      {job.status === "failed" && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={syncing || retryingJobId === job.id}
                          onClick={() => continueFailedJob(job)}
                        >
                          <RefreshCw className={retryingJobId === job.id ? "size-3 animate-spin" : "size-3"} />
                          {t("settings.sync.continue", "Continue")}
                        </Button>
                      )}
                      <SyncStatusBadge status={job.status} t={t} />
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={clearHistoryDialogOpen}
        onOpenChange={(open) => {
          if (!clearing) setClearHistoryDialogOpen(open)
        }}
        title={t(
          "settings.sync.clearHistoryDialog.title",
          "Clear sync history?",
        )}
        description={t(
          "settings.sync.clearHistoryDialog.description",
          "This removes the log of past sync runs (completed and failed). In-flight or pending jobs are kept. The underlying synced data (customers, invoices, KPIs) is unaffected. This cannot be undone.",
        )}
        confirmLabel={t("common.delete", "Delete")}
        variant="destructive"
        loading={clearing}
        onConfirm={handleClearHistory}
      />
    </div>
  )
}

function SyncStatusIcon({ status }: { status: SyncJob["status"] }) {
  switch (status) {
    case "completed":
      return <CheckCircle2 className="size-4 text-green-600" />
    case "failed":
      return <XCircle className="size-4 text-destructive" />
    case "processing":
      return <Loader2 className="size-4 animate-spin text-primary" />
    default:
      return <RefreshCw className="size-4 text-muted-foreground" />
  }
}

function SyncStatusBadge({
  status,
  t,
}: {
  status: SyncJob["status"]
  t: (key: string, fallback?: string) => string
}) {
  switch (status) {
    case "completed":
      return (
        <Badge variant="outline" className="font-normal text-green-600">
          {t("settings.sync.status.completed", "Completed")}
        </Badge>
      )
    case "failed":
      return (
        <Badge variant="destructive" className="font-normal">
          {t("settings.sync.status.failed", "Failed")}
        </Badge>
      )
    case "processing":
      return (
        <Badge variant="secondary" className="font-normal">
          {t("settings.sync.status.processing", "Processing")}
        </Badge>
      )
    default:
      return (
        <Badge variant="outline" className="font-normal">
          {t("settings.sync.status.pending", "Pending")}
        </Badge>
      )
  }
}
