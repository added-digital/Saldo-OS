"use client"

import * as React from "react"
import NumberFlow from "@number-flow/react"
import { Info, LineChart } from "lucide-react"

import { createClient } from "@/lib/supabase/client"
import { useTranslation } from "@/hooks/use-translation"
import { useUser } from "@/hooks/use-user"
import { useCachedData } from "@/hooks/use-cached-data"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { EmptyState } from "@/components/app/empty-state"

type TrackingStats = {
  totalSent: number
  totalFailed: number
  uniqueOpens: number
  uniqueClicks: number
  totalOpens: number
  totalClicks: number
}

type SentRow = { id: string; status: "sent" | "failed" }
type EventRow = {
  sent_email_id: string
  event_type: "open" | "click"
}

const EMPTY_STATS: TrackingStats = {
  totalSent: 0,
  totalFailed: 0,
  uniqueOpens: 0,
  uniqueClicks: 0,
  totalOpens: 0,
  totalClicks: 0,
}

const CHART_TOOLTIP_CLASS =
  "max-w-xs rounded-md border bg-background px-3 py-2 text-xs text-foreground shadow-xl"
const CHART_TOOLTIP_ARROW_CLASS =
  "border-r border-b border-border bg-background fill-background"

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "—"
  return `${value.toFixed(1)}%`
}

type MailTrackingOverviewProps = {
  /**
   * Scope tracking to these batch ids. `null` = all emails; an empty array =
   * a scope (e.g. a campaign) that currently has no batches → no data.
   */
  batchIds?: string[] | null
  /** Stable cache discriminator for the scope (e.g. "campaign:<id>"). */
  scopeKey?: string | null
  /** Human label for the "Showing tracking for …" line. */
  scopeLabel?: string | null
}

export function MailTrackingOverview({
  batchIds = null,
  scopeKey = null,
  scopeLabel = null,
}: MailTrackingOverviewProps) {
  const { t } = useTranslation()
  const { user } = useUser()
  const isScoped = batchIds != null

  const fetchStats = React.useCallback(async (): Promise<TrackingStats> => {
    const supabase = createClient()

    // A scope with no batches (e.g. an empty campaign) has nothing to show.
    if (batchIds && batchIds.length === 0) return EMPTY_STATS

    let sentQuery = supabase.from("sent_emails").select("id, status")
    if (batchIds && batchIds.length > 0) {
      sentQuery = sentQuery.in("batch_id", batchIds)
    }

    const { data: sentData, error: sentError } = await sentQuery
    if (sentError) throw new Error(sentError.message)

    const sentRows = (sentData ?? []) as unknown as SentRow[]
    const sentIds = sentRows.filter((row) => row.status === "sent").map((row) => row.id)
    const totalSent = sentIds.length
    const totalFailed = sentRows.filter((row) => row.status === "failed").length

    if (sentIds.length === 0) return EMPTY_STATS

    const { data: eventsData, error: eventsError } = await supabase
      .from("email_events")
      .select("sent_email_id, event_type")
      .in("sent_email_id", sentIds)
      .in("event_type", ["open", "click"])

    if (eventsError) throw new Error(eventsError.message)

    const events = (eventsData ?? []) as unknown as EventRow[]
    const opens = events.filter((event) => event.event_type === "open")
    const clicks = events.filter((event) => event.event_type === "click")

    return {
      totalSent,
      totalFailed,
      uniqueOpens: new Set(opens.map((event) => event.sent_email_id)).size,
      uniqueClicks: new Set(clicks.map((event) => event.sent_email_id)).size,
      totalOpens: opens.length,
      totalClicks: clicks.length,
    }
  }, [batchIds])

  const { data, loading, error: fetchError } = useCachedData<TrackingStats>({
    key: `mail.tracking.v3.${user.id}.${scopeKey ?? "all"}`,
    fetcher: fetchStats,
  })

  const stats = data ?? EMPTY_STATS
  const openRate = stats.totalSent > 0 ? (stats.uniqueOpens / stats.totalSent) * 100 : 0
  const clickRate = stats.totalSent > 0 ? (stats.uniqueClicks / stats.totalSent) * 100 : 0
  const ctr = stats.uniqueOpens > 0 ? (stats.uniqueClicks / stats.uniqueOpens) * 100 : 0

  const resolvedScopeLabel =
    scopeLabel ?? t("mail.tracking.scope.all", "Showing tracking for all emails")

  if (loading && !data) {
    return (
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">{resolvedScopeLabel}</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
      </div>
    )
  }

  if (fetchError) {
    return (
      <EmptyState
        icon={LineChart}
        title={t("mail.tracking.error.title", "Failed to load tracking data")}
        description={fetchError.message}
      />
    )
  }

  if (stats.totalSent === 0) {
    return (
      <EmptyState
        icon={LineChart}
        title={t("mail.tracking.empty.title", "No sent emails to track yet")}
        description={
          isScoped
            ? t(
                "mail.tracking.empty.batchDescription",
                "No delivered recipients were found for this selected email batch.",
              )
            : t(
                "mail.tracking.empty.description",
                "Once you send your first email from Send mail, opens and clicks will start showing up here.",
              )
        }
      />
    )
  }

  const moreInformationLabel = t(
    "mail.tracking.cards.moreInformation",
    "More information",
  )
  const cardHeaderClassName = "p-6 pb-1 pt-0"
  const cardContentClassName = "p-6 pt-0 pb-0"

  return (
    <TooltipProvider delayDuration={150}>
      <div className="space-y-4">
        <p className="text-xs text-muted-foreground">{resolvedScopeLabel}</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Card className="gap-2">
            <CardHeader className={cardHeaderClassName}>
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  {t("mail.tracking.cards.sent", "Sent")}
                </CardTitle>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={moreInformationLabel}
                      className="text-muted-foreground/70 transition-colors hover:text-foreground"
                    >
                      <Info className="size-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent
                    className={CHART_TOOLTIP_CLASS}
                    arrowClassName={CHART_TOOLTIP_ARROW_CLASS}
                  >
                    {t(
                      "mail.tracking.cards.sentTooltip",
                      "The total number of unique recipients the email has been sent to via Microsoft Graph.",
                    )}
                  </TooltipContent>
                </Tooltip>
              </div>
            </CardHeader>
            <CardContent className={`space-y-1 ${cardContentClassName}`}>
              <p className="text-4xl font-semibold leading-tight">
                <NumberFlow
                  value={stats.totalSent}
                  locales="sv-SE"
                  format={{ style: "decimal", maximumFractionDigits: 0 }}
                />
              </p>
              <p className="text-xs text-muted-foreground">
                {stats.totalFailed > 0
                  ? `${stats.totalFailed} ${t("mail.tracking.cards.failedSuffix", "failed")}`
                  : `${stats.totalSent} ${t("mail.tracking.cards.allDelivered", "delivered")}`}
              </p>
            </CardContent>
          </Card>

          <Card className="gap-2">
            <CardHeader className={cardHeaderClassName}>
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  {t("mail.tracking.cards.openRate", "Open rate")}
                </CardTitle>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={moreInformationLabel}
                      className="text-muted-foreground/70 transition-colors hover:text-foreground"
                    >
                      <Info className="size-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent
                    className={CHART_TOOLTIP_CLASS}
                    arrowClassName={CHART_TOOLTIP_ARROW_CLASS}
                  >
                    <p>
                      {t(
                        "mail.tracking.cards.openRateTooltip",
                        "The share of recipients who opened the email. This is the best gauge of how effective your subject line was.",
                      )}
                    </p>
                  </TooltipContent>
                </Tooltip>
              </div>
            </CardHeader>
            <CardContent className={`space-y-1 ${cardContentClassName}`}>
              <p className="text-4xl font-semibold leading-tight">{formatPercent(openRate)}</p>
              <p className="text-xs text-muted-foreground">
                {stats.uniqueOpens} {t("mail.tracking.cards.of", "of")} {stats.totalSent}{" "}
                {t("mail.tracking.cards.opensFraction", "opened")}
              </p>
            </CardContent>
          </Card>

          <Card className="gap-2">
            <CardHeader className={cardHeaderClassName}>
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  {t("mail.tracking.cards.clickRate", "Click rate")}
                </CardTitle>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={moreInformationLabel}
                      className="text-muted-foreground/70 transition-colors hover:text-foreground"
                    >
                      <Info className="size-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent
                    className={CHART_TOOLTIP_CLASS}
                    arrowClassName={CHART_TOOLTIP_ARROW_CLASS}
                  >
                    {t(
                      "mail.tracking.cards.clickRateTooltip",
                      "The share of all recipients who clicked your button or a link. This measures how much reach the whole campaign had across your audience.",
                    )}
                  </TooltipContent>
                </Tooltip>
              </div>
            </CardHeader>
            <CardContent className={`space-y-1 ${cardContentClassName}`}>
              <p className="text-4xl font-semibold leading-tight">{formatPercent(clickRate)}</p>
              <p className="text-xs text-muted-foreground">
                {stats.uniqueClicks} {t("mail.tracking.cards.of", "of")} {stats.totalSent}{" "}
                {t("mail.tracking.cards.clickedRecipients", "clicked")}
              </p>
            </CardContent>
          </Card>

          <Card className="gap-2">
            <CardHeader className={cardHeaderClassName}>
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  {t("mail.tracking.cards.ctor", "Click-to-open rate")}
                </CardTitle>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={moreInformationLabel}
                      className="text-muted-foreground/70 transition-colors hover:text-foreground"
                    >
                      <Info className="size-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent
                    className={CHART_TOOLTIP_CLASS}
                    arrowClassName={CHART_TOOLTIP_ARROW_CLASS}
                  >
                    {t(
                      "mail.tracking.cards.ctorTooltip",
                      "How many of those who actually opened the email also chose to click. This is the most precise gauge of how relevant your content and offer were to the reader.",
                    )}
                  </TooltipContent>
                </Tooltip>
              </div>
            </CardHeader>
            <CardContent className={`space-y-1 ${cardContentClassName}`}>
              <p className="text-4xl font-semibold leading-tight">{formatPercent(ctr)}</p>
              <p className="text-xs text-muted-foreground">
                {stats.uniqueClicks} {t("mail.tracking.cards.of", "of")} {stats.uniqueOpens}{" "}
                {t("mail.tracking.cards.clickedOfOpeners", "of openers clicked")}
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </TooltipProvider>
  )
}
