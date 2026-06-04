"use client"

import * as React from "react"
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  Mail,
  RefreshCw,
  Search,
  Tag,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"

import { createClient } from "@/lib/supabase/client"
import { useTranslation } from "@/hooks/use-translation"
import { useUser } from "@/hooks/use-user"
import { useCachedData } from "@/hooks/use-cached-data"
import { SearchInput } from "@/components/app/search-input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { ActionBar } from "@/components/app/action-bar"
import { EmptyState } from "@/components/app/empty-state"
import { MailTrackingOverview } from "@/components/app/mail-tracking-overview"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"

const MAIL_HISTORY_PAGE_SIZE = 15
const HISTORY_FETCH_LIMIT = 200

type RecipientStatus = "sent" | "failed"

type RecipientEntry = {
  id: string
  email: string
  name: string | null
  type: string
  status: RecipientStatus
  errorMessage: string | null
}

type BatchEntry = {
  id: string
  subject: string
  preview: string
  templateKey: string | null
  sentAt: string
  recipientCount: number
  sentCount: number
  failedCount: number
  recipients: RecipientEntry[]
  campaignId: string | null
  campaignName: string | null
}

type Campaign = { id: string; name: string }

type BatchRow = {
  id: string
  subject: string
  body_preview: string | null
  template_key: string | null
  sent_at: string
  recipient_count: number
  sent_count: number
  failed_count: number
  campaign_id: string | null
  sent_emails: Array<{
    id: string
    recipient_email: string
    recipient_name: string | null
    recipient_type: string
    status: RecipientStatus
    error_message: string | null
  }> | null
}

// Sentinels for the campaign filter dropdown.
const CAMPAIGN_FILTER_ALL = "__all__"
const CAMPAIGN_FILTER_NONE = "__none__"

function formatSentAt(iso: string, locale: string = "sv-SE"): string {
  try {
    const date = new Date(iso)
    // Build the date and time parts separately and join with a single comma so
    // the output is deterministic across locales (some sv-SE Intl outputs
    // inject "kl." between the date and the time, which pushes the string
    // past the 150px Sent column at text-xs and triggers a CSS ellipsis).
    const datePart = new Intl.DateTimeFormat(locale, {
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(date)
    const timePart = new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      minute: "2-digit",
    }).format(date)
    return `${datePart}, ${timePart}`
  } catch {
    return iso
  }
}

function escapeCsvValue(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function toCsvRow(values: string[]): string {
  return values.map(escapeCsvValue).join(",")
}

function withAccentScrollbarStyles(html: string): string {
  const scrollbarStyles = `
<style>
  :root { scrollbar-color: #8b6f2a #000; }
  * { scrollbar-width: thin; }
  *::-webkit-scrollbar { width: 12px; height: 12px; }
  *::-webkit-scrollbar-track { background: #000; }
  *::-webkit-scrollbar-thumb {
    background: #8b6f2a;
    border: 2px solid #000;
    border-radius: 9999px;
  }
  *::-webkit-scrollbar-thumb:hover { background: #8b6f2a; }
  *::-webkit-scrollbar-corner { background: #000; }
</style>`

  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (match) => `${match}${scrollbarStyles}`)
  }

  return `${scrollbarStyles}${html}`
}

type EmailBodyState =
  | { status: "loading" }
  | { status: "ready"; html: string }
  | { status: "error"; message: string }

export default function MailHistoryPage() {
  const { t } = useTranslation()
  const { user } = useUser()

  const fetchHistory = React.useCallback(async (): Promise<BatchEntry[]> => {
    const supabase = createClient()
    // Resolve campaign names via a separate owner-scoped query rather than a
    // PostgREST embed. The embed needs the FK relationship in the schema cache,
    // which lags after a migration and fails outright until campaign_id's FK is
    // applied — this only needs the campaign_id column to exist.
    const [batchesRes, campaignsRes] = await Promise.all([
      supabase
        .from("mail_send_batches")
        .select(
          "id, subject, body_preview, template_key, sent_at, recipient_count, " +
            "sent_count, failed_count, campaign_id, " +
            "sent_emails(id, recipient_email, recipient_name, recipient_type, status, error_message)",
        )
        .order("sent_at", { ascending: false })
        .limit(HISTORY_FETCH_LIMIT),
      supabase.from("mail_campaigns").select("id, name"),
    ])

    if (batchesRes.error) {
      throw new Error(batchesRes.error.message)
    }

    const campaignNameById = new Map(
      ((campaignsRes.data ?? []) as Campaign[]).map((c) => [c.id, c.name]),
    )

    const rows = (batchesRes.data ?? []) as unknown as BatchRow[]
    return rows.map((row) => ({
      id: row.id,
      subject: row.subject,
      preview: row.body_preview ?? "",
      templateKey: row.template_key,
      sentAt: row.sent_at,
      recipientCount: row.recipient_count ?? row.sent_emails?.length ?? 0,
      sentCount: row.sent_count ?? 0,
      failedCount: row.failed_count ?? 0,
      campaignId: row.campaign_id ?? null,
      campaignName: row.campaign_id
        ? campaignNameById.get(row.campaign_id) ?? null
        : null,
      recipients: (row.sent_emails ?? []).map((entry) => ({
        id: entry.id,
        email: entry.recipient_email,
        name: entry.recipient_name,
        type: entry.recipient_type,
        status: entry.status,
        errorMessage: entry.error_message,
      })),
    }))
  }, [])

  const {
    data: cachedHistory,
    loading,
    refreshing,
    error: fetchError,
    refresh,
    setData: setCachedHistory,
  } = useCachedData<BatchEntry[]>({
    // v3: added campaign fields to the fetched shape — bump so cached v2 rows
    // (which lack campaignId/campaignName) are refetched rather than served stale.
    key: `mail.history.v3.${user.id}`,
    fetcher: fetchHistory,
  })

  const batches = React.useMemo(() => cachedHistory ?? [], [cachedHistory])

  const [searchQuery, setSearchQuery] = React.useState("")
  const [pageIndex, setPageIndex] = React.useState(0)
  const [pageSize, setPageSize] = React.useState(MAIL_HISTORY_PAGE_SIZE)
  const [expandedIds, setExpandedIds] = React.useState<Set<string>>(new Set())
  const [activeBatch, setActiveBatch] = React.useState<BatchEntry | null>(null)
  const [bodyCache, setBodyCache] = React.useState<
    Record<string, EmailBodyState>
  >({})
  const [deleting, setDeleting] = React.useState(false)
  const [selectedTrackingBatch, setSelectedTrackingBatch] = React.useState<{
    id: string
    subject: string
  } | null>(null)

  // Multi-select: the set of selected batch ids drives the bottom action bar.
  const [selectedBatchIds, setSelectedBatchIds] = React.useState<Set<string>>(
    new Set(),
  )
  const [bulkDeleteOpen, setBulkDeleteOpen] = React.useState(false)

  // Campaigns: drive the filter dropdown and the bulk "assign" picker.
  const [campaigns, setCampaigns] = React.useState<Campaign[]>([])
  const [campaignFilter, setCampaignFilter] = React.useState<string>(CAMPAIGN_FILTER_ALL)
  const [assignOpen, setAssignOpen] = React.useState(false)
  const [assignQuery, setAssignQuery] = React.useState("")
  const [assignBusy, setAssignBusy] = React.useState(false)

  const loadCampaigns = React.useCallback(async () => {
    const supabase = createClient()
    const { data } = await supabase
      .from("mail_campaigns")
      .select("id, name")
      .order("created_at", { ascending: false })
    setCampaigns((data ?? []) as Campaign[])
  }, [])

  React.useEffect(() => {
    void loadCampaigns()
  }, [loadCampaigns])

  const filteredBatches = React.useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    const byCampaign = batches.filter((batch) => {
      if (campaignFilter === CAMPAIGN_FILTER_ALL) return true
      if (campaignFilter === CAMPAIGN_FILTER_NONE) return !batch.campaignId
      return batch.campaignId === campaignFilter
    })
    if (!q) return byCampaign
    return byCampaign.filter((batch) => {
      if (
        batch.subject.toLowerCase().includes(q) ||
        batch.preview.toLowerCase().includes(q) ||
        (batch.campaignName?.toLowerCase().includes(q) ?? false)
      ) {
        return true
      }
      return batch.recipients.some(
        (recipient) =>
          recipient.email.toLowerCase().includes(q) ||
          (recipient.name?.toLowerCase().includes(q) ?? false),
      )
    })
  }, [batches, searchQuery, campaignFilter])

  // Batch ids in the currently-filtered campaign scope (null = all campaigns).
  const campaignBatchIds = React.useMemo<string[] | null>(() => {
    if (campaignFilter === CAMPAIGN_FILTER_ALL) return null
    if (campaignFilter === CAMPAIGN_FILTER_NONE) {
      return batches.filter((b) => !b.campaignId).map((b) => b.id)
    }
    return batches
      .filter((b) => b.campaignId === campaignFilter)
      .map((b) => b.id)
  }, [batches, campaignFilter])

  // Scope for the tracking KPI cards. A single-batch "Filter tracking" takes
  // priority; otherwise the campaign filter drives the scope; otherwise all.
  const trackingScope = React.useMemo<{
    batchIds: string[] | null
    scopeKey: string
    scopeLabel: string | null
  }>(() => {
    if (selectedTrackingBatch) {
      return {
        batchIds: [selectedTrackingBatch.id],
        scopeKey: `batch:${selectedTrackingBatch.id}`,
        scopeLabel: `${t("mail.tracking.scope.batch", "Showing tracking for selected email batch")}: ${selectedTrackingBatch.subject}`,
      }
    }
    if (campaignFilter !== CAMPAIGN_FILTER_ALL) {
      const label =
        campaignFilter === CAMPAIGN_FILTER_NONE
          ? t(
              "mail.tracking.scope.campaignNone",
              "Showing tracking for emails with no campaign",
            )
          : `${t("mail.tracking.scope.campaign", "Showing tracking for campaign")}: ${
              campaigns.find((c) => c.id === campaignFilter)?.name ?? ""
            }`
      return {
        batchIds: campaignBatchIds,
        scopeKey: `campaign:${campaignFilter}`,
        scopeLabel: label,
      }
    }
    return { batchIds: null, scopeKey: "all", scopeLabel: null }
  }, [selectedTrackingBatch, campaignFilter, campaignBatchIds, campaigns, t])

  const pageCount = React.useMemo(
    () => Math.max(1, Math.ceil(filteredBatches.length / pageSize)),
    [filteredBatches.length, pageSize],
  )

  React.useEffect(() => {
    setPageIndex((current) => {
      if (current < 0) return 0
      if (current >= pageCount) return pageCount - 1
      return current
    })
  }, [pageCount])

  const paginatedBatches = React.useMemo(() => {
    const from = pageIndex * pageSize
    return filteredBatches.slice(from, from + pageSize)
  }, [filteredBatches, pageIndex, pageSize])

  const shouldShowPagination = batches.length >= MAIL_HISTORY_PAGE_SIZE

  function toggleExpanded(batchId: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(batchId)) next.delete(batchId)
      else next.add(batchId)
      return next
    })
  }

  function openBatchDetail(batch: BatchEntry) {
    setActiveBatch(batch)
    if (bodyCache[batch.id]?.status === "ready") return

    setBodyCache((prev) => ({ ...prev, [batch.id]: { status: "loading" } }))

    const supabase = createClient()
    void supabase
      .from("mail_send_batches")
      .select("body_html")
      .eq("id", batch.id)
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) {
          setBodyCache((prev) => ({
            ...prev,
            [batch.id]: { status: "error", message: error.message },
          }))
          return
        }
        const row = data as { body_html: string | null } | null
        setBodyCache((prev) => ({
          ...prev,
          [batch.id]: { status: "ready", html: row?.body_html ?? "" },
        }))
      })
  }

  // ---- Multi-select helpers --------------------------------------------------
  const selectedCount = selectedBatchIds.size
  const allOnPageSelected =
    paginatedBatches.length > 0 &&
    paginatedBatches.every((b) => selectedBatchIds.has(b.id))

  function toggleSelect(batchId: string) {
    setSelectedBatchIds((prev) => {
      const next = new Set(prev)
      if (next.has(batchId)) next.delete(batchId)
      else next.add(batchId)
      return next
    })
  }

  function toggleSelectAllOnPage() {
    setSelectedBatchIds((prev) => {
      const next = new Set(prev)
      if (allOnPageSelected) {
        for (const b of paginatedBatches) next.delete(b.id)
      } else {
        for (const b of paginatedBatches) next.add(b.id)
      }
      return next
    })
  }

  function clearSelection() {
    setSelectedBatchIds(new Set())
  }

  async function handleBulkDelete() {
    const ids = Array.from(selectedBatchIds)
    if (ids.length === 0) return

    setDeleting(true)
    try {
      const supabase = createClient()
      const { error } = await supabase
        .from("mail_send_batches")
        .delete()
        .in("id", ids)

      if (error) {
        toast.error(
          `${t("mail.history.delete.error", "Failed to delete email")}: ${error.message}`,
        )
        return
      }

      // Optimistically prune the deleted batches. ON DELETE CASCADE on
      // sent_emails / email_events removes their children server-side too.
      const idSet = new Set(ids)
      setCachedHistory((prev) => (prev ?? []).filter((b) => !idSet.has(b.id)))
      setExpandedIds((prev) => {
        const next = new Set(prev)
        for (const id of ids) next.delete(id)
        return next
      })
      setBodyCache((prev) => {
        const next = { ...prev }
        for (const id of ids) delete next[id]
        return next
      })
      setSelectedTrackingBatch((current) =>
        current && idSet.has(current.id) ? null : current,
      )
      setSelectedBatchIds(new Set())
      setBulkDeleteOpen(false)
      toast.success(
        ids.length === 1
          ? t("mail.history.delete.success", "Email deleted")
          : `${ids.length} ${t("mail.history.delete.successPlural", "emails deleted")}`,
      )

      void refresh()
    } finally {
      setDeleting(false)
    }
  }

  // Retroactively file (or unfile) the selected batches into a campaign.
  async function assignSelectionToCampaign(
    target:
      | { type: "none" }
      | { type: "existing"; id: string; name: string }
      | { type: "new"; name: string },
  ) {
    const ids = Array.from(selectedBatchIds)
    if (ids.length === 0) return

    setAssignBusy(true)
    try {
      const supabase = createClient()
      let campaignId: string | null = null
      let campaignName: string | null = null

      if (target.type === "existing") {
        campaignId = target.id
        campaignName = target.name
      } else if (target.type === "new") {
        const name = target.name.trim()
        if (!name) return
        const existing = await supabase
          .from("mail_campaigns")
          .select("id, name")
          .ilike("name", name)
          .maybeSingle()
        if (existing.data) {
          const row = existing.data as Campaign
          campaignId = row.id
          campaignName = row.name
        } else {
          const created = await supabase
            .from("mail_campaigns")
            .insert({ user_id: user.id, name } as never)
            .select("id, name")
            .single()
          if (created.error) {
            toast.error(
              `${t("mail.history.campaign.createError", "Failed to create campaign")}: ${created.error.message}`,
            )
            return
          }
          const row = created.data as Campaign
          campaignId = row.id
          campaignName = row.name
        }
      }

      const { error } = await supabase
        .from("mail_send_batches")
        .update({ campaign_id: campaignId } as never)
        .in("id", ids)
      if (error) {
        toast.error(
          `${t("mail.history.campaign.assignError", "Failed to assign campaign")}: ${error.message}`,
        )
        return
      }

      const idSet = new Set(ids)
      setCachedHistory((prev) =>
        (prev ?? []).map((b) =>
          idSet.has(b.id) ? { ...b, campaignId, campaignName } : b,
        ),
      )
      await loadCampaigns()
      setAssignOpen(false)
      setAssignQuery("")
      setSelectedBatchIds(new Set())
      toast.success(
        campaignId
          ? `${t("mail.history.campaign.assigned", "Filed under")} ${campaignName}`
          : t("mail.history.campaign.unfiled", "Removed from campaign"),
      )
    } finally {
      setAssignBusy(false)
    }
  }

  async function handleManualRefresh() {
    try {
      await refresh()
      toast.success(t("mail.history.refresh.success", "History refreshed"))
    } catch (err) {
      toast.error(
        `${t("mail.history.refresh.error", "Failed to refresh")}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }

  function handleExportCsv() {
    if (filteredBatches.length === 0) return

    const headers = [
      t("mail.history.columns.subject", "Subject"),
      t("mail.history.columns.preview", "Preview"),
      t("mail.history.columns.recipientName", "Recipient name"),
      t("mail.history.columns.recipientEmail", "Recipient email"),
      t("mail.history.columns.recipientType", "Recipient type"),
      t("mail.history.columns.status", "Status"),
      t("mail.history.columns.errorMessage", "Error message"),
      t("mail.history.columns.sentAt", "Sent"),
    ]

    const rows: string[] = [toCsvRow(headers)]
    for (const batch of filteredBatches) {
      for (const recipient of batch.recipients) {
        rows.push(
          toCsvRow([
            batch.subject,
            batch.preview,
            recipient.name ?? "",
            recipient.email,
            recipient.type,
            recipient.status,
            recipient.errorMessage ?? "",
            batch.sentAt,
          ]),
        )
      }
    }

    const csv = rows.join("\n")
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" })
    const url = URL.createObjectURL(blob)
    const timestamp = new Date().toISOString().slice(0, 10)
    const link = document.createElement("a")
    link.href = url
    link.download = `mail-history-${timestamp}.csv`
    link.click()
    URL.revokeObjectURL(url)

    toast.success(t("mail.history.export.success", "Mail history CSV exported"))
  }

  const paginationControl = (
    <div className="flex items-center gap-2">
      <select
        value={pageSize}
        onChange={(event) => {
          setPageSize(Number(event.target.value))
          setPageIndex(0)
        }}
        className="h-9 rounded-md border border-input bg-background px-2 text-xs"
        aria-label={t("mail.history.pagination.rowsPerPage", "Rows per page")}
      >
        <option value={15}>{t("mail.history.pagination.perPage15", "15 / page")}</option>
        <option value={30}>{t("mail.history.pagination.perPage30", "30 / page")}</option>
        <option value={50}>{t("mail.history.pagination.perPage50", "50 / page")}</option>
      </select>
      <span className="text-sm text-muted-foreground">
        {pageIndex + 1} {t("mail.history.pagination.of", "of")} {pageCount}
      </span>
      <Button
        variant="outline"
        size="sm"
        className="h-9 w-9"
        onClick={() => setPageIndex((current) => Math.max(current - 1, 0))}
        disabled={pageIndex === 0}
      >
        <ChevronLeft className="size-4" />
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="h-9 w-9"
        onClick={() => setPageIndex((current) => Math.min(current + 1, pageCount - 1))}
        disabled={pageIndex >= pageCount - 1}
      >
        <ChevronRight className="size-4" />
      </Button>
    </div>
  )

  const toolbar = (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center lg:flex-1">
        <SearchInput
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder={t("mail.history.searchPlaceholder", "Search sent emails...")}
          className="w-full lg:max-w-sm"
        />
        <Select value={campaignFilter} onValueChange={setCampaignFilter}>
          <SelectTrigger className="h-9 w-full sm:w-56">
            <div className="flex min-w-0 items-center gap-1.5">
              <Tag className="size-3.5 shrink-0 text-muted-foreground" />
              <SelectValue />
            </div>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>
                {t("mail.history.campaign.filterTitle", "Filter results by campaign")}
              </SelectLabel>
              <SelectItem value={CAMPAIGN_FILTER_ALL}>
                {t("mail.history.campaign.filterAll", "All campaigns")}
              </SelectItem>
              <SelectItem value={CAMPAIGN_FILTER_NONE}>
                {t("mail.history.campaign.filterNone", "No campaign")}
              </SelectItem>
              {campaigns.map((campaign) => (
                <SelectItem key={campaign.id} value={campaign.id}>
                  {campaign.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-wrap items-center gap-2 lg:justify-end">
        {selectedTrackingBatch ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-9"
            onClick={() => setSelectedTrackingBatch(null)}
          >
            {t("mail.tracking.scope.clear", "Show all tracking")}
          </Button>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          className="h-9 gap-1.5"
          onClick={handleManualRefresh}
          disabled={loading || refreshing}
        >
          <RefreshCw
            className={cn("size-3.5", refreshing && "animate-spin")}
          />
          {t("mail.history.refresh.label", "Refresh")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-9 gap-1.5"
          onClick={handleExportCsv}
          disabled={loading || filteredBatches.length === 0}
        >
          <Download className="size-3.5" />
          {t("mail.history.export.csv", "Export CSV")}
        </Button>
        {shouldShowPagination ? paginationControl : null}
      </div>
    </div>
  )

  const activeBody = activeBatch ? bodyCache[activeBatch.id] : undefined

  return (
    <div className="space-y-6">
      <MailTrackingOverview
        batchIds={trackingScope.batchIds}
        scopeKey={trackingScope.scopeKey}
        scopeLabel={trackingScope.scopeLabel}
      />

      {toolbar}

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-16 w-full rounded-md" />
          ))}
        </div>
      ) : fetchError ? (
        <EmptyState
          icon={Mail}
          title={t("mail.history.error.title", "Failed to load history")}
          description={fetchError.message}
        />
      ) : filteredBatches.length === 0 ? (
        searchQuery.trim().length > 0 ? (
          <EmptyState
            icon={Mail}
            title={t("mail.history.empty.searchTitle", "No matching emails")}
            description={t(
              "mail.history.empty.searchDescription",
              "No sent emails match your search.",
            )}
            action={{
              label: t("mail.history.empty.clearSearch", "Clear search"),
              onClick: () => setSearchQuery(""),
            }}
          />
        ) : (
          <EmptyState
            icon={Mail}
            title={t("mail.history.empty.title", "No sent emails yet")}
            description={t(
              "mail.history.empty.description",
              "Emails you send from this app will appear here.",
            )}
          />
        )
      ) : (
        <div className="overflow-hidden rounded-md border">
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <div className="flex items-center justify-center">
                    <Checkbox
                      checked={allOnPageSelected}
                      onCheckedChange={toggleSelectAllOnPage}
                      aria-label={t("mail.history.selectAll", "Select all on this page")}
                    />
                  </div>
                </TableHead>
                <TableHead className="w-[28%]">
                  {t("mail.history.columns.subject", "Subject")}
                </TableHead>
                <TableHead>
                  {t("mail.history.columns.preview", "Preview")}
                </TableHead>
                <TableHead className="w-[160px]">
                  {t("mail.history.columns.campaign", "Campaign")}
                </TableHead>
                <TableHead className="w-[180px]">
                  {t("mail.history.columns.recipients", "Recipients")}
                </TableHead>
                <TableHead className="w-[150px] text-right">
                  {t("mail.history.columns.sentAt", "Sent")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {paginatedBatches.map((batch) => {
                const expanded = expandedIds.has(batch.id)
                return (
                  <React.Fragment key={batch.id}>
                    <TableRow
                      className="cursor-pointer"
                      onClick={() => toggleExpanded(batch.id)}
                    >
                      <TableCell
                        className="w-10"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <div className="flex items-center justify-center">
                          <Checkbox
                            checked={selectedBatchIds.has(batch.id)}
                            onCheckedChange={() => toggleSelect(batch.id)}
                            aria-label={t("mail.history.selectRow", "Select email")}
                          />
                        </div>
                      </TableCell>
                      <TableCell className="font-medium">
                        <div className="flex items-start gap-1.5">
                          <ChevronDown
                            className={cn(
                              "mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform",
                              expanded && "rotate-180",
                            )}
                          />
                          <span className="min-w-0 truncate">{batch.subject}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {batch.preview || "—"}
                      </TableCell>
                      <TableCell>
                        {batch.campaignName ? (
                          <span className="inline-flex max-w-full items-center gap-1 text-sm">
                            <Tag className="size-3 shrink-0 text-muted-foreground" />
                            <span className="truncate">{batch.campaignName}</span>
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-1">
                          <Badge variant="secondary" className="text-xs">
                            {batch.recipientCount}{" "}
                            {batch.recipientCount === 1
                              ? t("mail.history.summary.recipient", "recipient")
                              : t("mail.history.summary.recipients", "recipients")}
                          </Badge>
                          {batch.failedCount > 0 ? (
                            <Badge
                              variant="outline"
                              className="border-destructive text-destructive text-xs"
                            >
                              {batch.failedCount}{" "}
                              {t("mail.history.statusFailed", "failed")}
                            </Badge>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground [text-overflow:clip]">
                        {formatSentAt(batch.sentAt)}
                      </TableCell>
                    </TableRow>

                    {expanded ? (
                      <TableRow className="bg-muted/30 hover:bg-muted/30">
                        <TableCell />
                        <TableCell colSpan={5} className="whitespace-normal">
                          <div className="space-y-2 py-1">
                            <div className="flex items-center justify-between">
                              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                {t(
                                  "mail.history.detail.recipients",
                                  "Recipients",
                                )}
                              </p>
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7 text-xs"
                                onClick={(event) => {
                                  event.stopPropagation()
                                  setSelectedTrackingBatch({
                                    id: batch.id,
                                    subject: batch.subject,
                                  })
                                  openBatchDetail(batch)
                                }}
                              >
                                {t(
                                  "mail.history.detail.viewBody",
                                  "View email",
                                )}
                              </Button>
                            </div>
                            {batch.recipients.length === 0 ? (
                              <p className="text-sm text-muted-foreground">
                                {t(
                                  "mail.history.detail.noRecipients",
                                  "No recipient records were stored for this send.",
                                )}
                              </p>
                            ) : (
                              <ul className="divide-y">
                                {batch.recipients.map((recipient) => (
                                  <li
                                    key={recipient.id}
                                    className="flex items-center justify-between gap-3 py-2 text-sm"
                                  >
                                    <div className="min-w-0">
                                      <p className="truncate">
                                        {recipient.name
                                          ? `${recipient.name} <${recipient.email}>`
                                          : recipient.email}
                                      </p>
                                      {recipient.errorMessage ? (
                                        <p className="truncate text-xs text-destructive">
                                          {recipient.errorMessage}
                                        </p>
                                      ) : null}
                                    </div>
                                    <Badge
                                      variant={
                                        recipient.status === "sent"
                                          ? "secondary"
                                          : "outline"
                                      }
                                      className={cn(
                                        "text-xs",
                                        recipient.status === "failed" &&
                                          "border-destructive text-destructive",
                                      )}
                                    >
                                      {recipient.status === "sent"
                                        ? t("mail.history.statusSent", "sent")
                                        : t(
                                            "mail.history.statusFailed",
                                            "failed",
                                          )}
                                    </Badge>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </React.Fragment>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <ActionBar
        selectedCount={selectedCount}
        onClear={clearSelection}
        actions={[
          {
            label: t("mail.history.actions.assignCampaign", "Assign to campaign"),
            icon: Tag,
            onClick: () => {
              setAssignQuery("")
              setAssignOpen(true)
            },
          },
          {
            label: t("mail.history.bulk.delete", "Delete"),
            icon: Trash2,
            onClick: () => setBulkDeleteOpen(true),
            variant: "destructive" as const,
          },
        ]}
      />

      <AlertDialog
        open={bulkDeleteOpen}
        onOpenChange={(open) => {
          if (!open && !deleting) setBulkDeleteOpen(false)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {selectedCount === 1
                ? t("mail.history.delete.confirmTitle", "Delete this email?")
                : `${t("mail.history.bulk.deleteConfirmTitlePrefix", "Delete")} ${selectedCount} ${t("mail.history.bulk.deleteConfirmTitleSuffix", "emails?")}`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "mail.history.delete.confirmDescription",
                "This permanently removes the send record, all per-recipient rows, and any tracked opens or clicks. This cannot be undone.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>
              {t("mail.history.delete.cancel", "Cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={(event) => {
                event.preventDefault()
                void handleBulkDelete()
              }}
              disabled={deleting}
            >
              {deleting
                ? t("mail.history.delete.confirming", "Deleting…")
                : t("mail.history.delete.confirm", "Delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={activeBatch !== null}
        onOpenChange={(open) => {
          if (!open) setActiveBatch(null)
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="text-base">
              {activeBatch?.subject ?? ""}
            </DialogTitle>
            <DialogDescription className="space-y-1 pt-1 text-left">
              <span className="block">
                {activeBatch
                  ? `${activeBatch.recipientCount} ${
                      activeBatch.recipientCount === 1
                        ? t("mail.history.summary.recipient", "recipient")
                        : t("mail.history.summary.recipients", "recipients")
                    }${
                      activeBatch.failedCount > 0
                        ? `, ${activeBatch.failedCount} ${t("mail.history.statusFailed", "failed")}`
                        : ""
                    }`
                  : ""}
              </span>
              <span className="block text-xs text-muted-foreground">
                {activeBatch ? formatSentAt(activeBatch.sentAt) : ""}
              </span>
            </DialogDescription>
          </DialogHeader>

          <div className="rounded-md border bg-white">
            {activeBody?.status === "ready" ? (
              activeBody.html.length > 0 ? (
                <iframe
                  title={t("mail.history.detail.bodyTitle", "Email body")}
                  srcDoc={withAccentScrollbarStyles(activeBody.html)}
                  className="h-[600px] w-full rounded-md"
                />
              ) : (
                <p className="p-4 text-sm text-muted-foreground">
                  {t(
                    "mail.history.detail.emptyBody",
                    "No body content was stored for this email.",
                  )}
                </p>
              )
            ) : activeBody?.status === "error" ? (
              <p className="p-4 text-sm text-destructive">
                {t(
                  "mail.history.detail.loadFailed",
                  "Failed to load email body",
                )}
                : {activeBody.message}
              </p>
            ) : (
              <div className="space-y-2 p-4">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-5/6" />
                <Skeleton className="h-64 w-full" />
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={assignOpen}
        onOpenChange={(open) => {
          if (!open && !assignBusy) {
            setAssignOpen(false)
            setAssignQuery("")
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">
              {t("mail.history.campaign.assignTitle", "Assign to campaign")}
            </DialogTitle>
            <DialogDescription>
              {`${selectedCount} ${
                selectedCount === 1
                  ? t("mail.history.summary.recipient", "email")
                  : t("mail.history.bulk.emails", "emails")
              } ${t("mail.history.bulk.willBeFiled", "will be filed")}`}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={assignQuery}
                onChange={(event) => setAssignQuery(event.target.value)}
                placeholder={t(
                  "mail.history.campaign.searchPlaceholder",
                  "Search or name a new campaign...",
                )}
                className="pl-9"
                disabled={assignBusy}
              />
            </div>
            <div className="max-h-64 space-y-1 overflow-y-auto">
              <button
                type="button"
                disabled={assignBusy}
                onClick={() => void assignSelectionToCampaign({ type: "none" })}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/60 disabled:opacity-50"
              >
                <span className="text-muted-foreground">
                  {t("mail.history.campaign.filterNone", "No campaign")}
                </span>
              </button>
              {campaigns
                .filter((c) =>
                  c.name
                    .toLowerCase()
                    .includes(assignQuery.trim().toLowerCase()),
                )
                .map((campaign) => (
                  <button
                    key={campaign.id}
                    type="button"
                    disabled={assignBusy}
                    onClick={() =>
                      void assignSelectionToCampaign({
                        type: "existing",
                        id: campaign.id,
                        name: campaign.name,
                      })
                    }
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/60 disabled:opacity-50"
                  >
                    <span className="truncate">{campaign.name}</span>
                  </button>
                ))}
              {assignQuery.trim() &&
              !campaigns.some(
                (c) =>
                  c.name.toLowerCase() === assignQuery.trim().toLowerCase(),
              ) ? (
                <button
                  type="button"
                  disabled={assignBusy}
                  onClick={() =>
                    void assignSelectionToCampaign({
                      type: "new",
                      name: assignQuery.trim(),
                    })
                  }
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/60 disabled:opacity-50"
                >
                  <span className="text-muted-foreground">
                    {t("mail.history.campaign.create", "Create")}
                  </span>
                  <span className="truncate font-medium">
                    &ldquo;{assignQuery.trim()}&rdquo;
                  </span>
                </button>
              ) : null}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
