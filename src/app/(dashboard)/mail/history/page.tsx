"use client"

import * as React from "react"
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  Ellipsis,
  Mail,
  RefreshCw,
} from "lucide-react"
import { toast } from "sonner"

import { createClient } from "@/lib/supabase/client"
import { useTranslation } from "@/hooks/use-translation"
import { useUser } from "@/hooks/use-user"
import { useCachedData } from "@/hooks/use-cached-data"
import { SearchInput } from "@/components/app/search-input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
}

type BatchRow = {
  id: string
  subject: string
  body_preview: string | null
  template_key: string | null
  sent_at: string
  recipient_count: number
  sent_count: number
  failed_count: number
  sent_emails: Array<{
    id: string
    recipient_email: string
    recipient_name: string | null
    recipient_type: string
    status: RecipientStatus
    error_message: string | null
  }> | null
}

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
    const { data, error } = await supabase
      .from("mail_send_batches")
      .select(
        "id, subject, body_preview, template_key, sent_at, recipient_count, " +
          "sent_count, failed_count, " +
          "sent_emails(id, recipient_email, recipient_name, recipient_type, status, error_message)",
      )
      .order("sent_at", { ascending: false })
      .limit(HISTORY_FETCH_LIMIT)

    if (error) {
      throw new Error(error.message)
    }

    const rows = (data ?? []) as unknown as BatchRow[]
    return rows.map((row) => ({
      id: row.id,
      subject: row.subject,
      preview: row.body_preview ?? "",
      templateKey: row.template_key,
      sentAt: row.sent_at,
      recipientCount: row.recipient_count ?? row.sent_emails?.length ?? 0,
      sentCount: row.sent_count ?? 0,
      failedCount: row.failed_count ?? 0,
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
    key: `mail.history.v2.${user.id}`,
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
  const [pendingDelete, setPendingDelete] = React.useState<BatchEntry | null>(
    null,
  )
  const [deleting, setDeleting] = React.useState(false)
  const [openActionMenuBatchId, setOpenActionMenuBatchId] = React.useState<string | null>(null)
  const [selectedTrackingBatch, setSelectedTrackingBatch] = React.useState<{
    id: string
    subject: string
  } | null>(null)

  const filteredBatches = React.useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return batches
    return batches.filter((batch) => {
      if (
        batch.subject.toLowerCase().includes(q) ||
        batch.preview.toLowerCase().includes(q)
      ) {
        return true
      }
      return batch.recipients.some(
        (recipient) =>
          recipient.email.toLowerCase().includes(q) ||
          (recipient.name?.toLowerCase().includes(q) ?? false),
      )
    })
  }, [batches, searchQuery])

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

  async function handleConfirmDelete() {
    if (!pendingDelete) return
    const batchId = pendingDelete.id

    setDeleting(true)
    try {
      const supabase = createClient()
      const { error } = await supabase
        .from("mail_send_batches")
        .delete()
        .eq("id", batchId)

      if (error) {
        toast.error(
          `${t("mail.history.delete.error", "Failed to delete email")}: ${error.message}`,
        )
        return
      }

      // Optimistically prune the deleted batch from the cached list so the UI
      // updates immediately even before the background refetch returns. The
      // ON DELETE CASCADE on sent_emails (and email_events) means the row is
      // fully gone server-side too.
      setCachedHistory((prev) => (prev ?? []).filter((b) => b.id !== batchId))
      setExpandedIds((prev) => {
        if (!prev.has(batchId)) return prev
        const next = new Set(prev)
        next.delete(batchId)
        return next
      })
      setBodyCache((prev) => {
        if (!(batchId in prev)) return prev
        const next = { ...prev }
        delete next[batchId]
        return next
      })
      setSelectedTrackingBatch((current) =>
        current?.id === batchId ? null : current,
      )

      setPendingDelete(null)
      toast.success(t("mail.history.delete.success", "Email deleted"))

      // Reconcile in the background so any other client updates show up too.
      void refresh()
    } finally {
      setDeleting(false)
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

  function recipientSummary(batch: BatchEntry): string {
    if (batch.recipientCount === 0) return "—"
    const first = batch.recipients[0]
    const firstLabel =
      first?.name?.trim() || first?.email || `${batch.recipientCount} recipients`
    if (batch.recipientCount === 1) return firstLabel
    return `${firstLabel} + ${batch.recipientCount - 1} ${
      batch.recipientCount - 1 === 1
        ? t("mail.history.summary.other", "other")
        : t("mail.history.summary.others", "others")
    }`
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
      <SearchInput
        value={searchQuery}
        onChange={setSearchQuery}
        placeholder={t("mail.history.searchPlaceholder", "Search sent emails...")}
        className="w-full lg:max-w-sm"
      />
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
        batchId={selectedTrackingBatch?.id ?? null}
        batchSubject={selectedTrackingBatch?.subject ?? null}
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
                <TableHead className="w-10" />
                <TableHead className="w-[28%]">
                  {t("mail.history.columns.subject", "Subject")}
                </TableHead>
                <TableHead>
                  {t("mail.history.columns.preview", "Preview")}
                </TableHead>
                <TableHead className="w-[180px]">
                  {t("mail.history.columns.recipients", "Recipients")}
                </TableHead>
                <TableHead className="w-[150px] text-right">
                  {t("mail.history.columns.sentAt", "Sent")}
                </TableHead>
                <TableHead className="w-12" />
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
                      <TableCell className="w-10 text-muted-foreground">
                        <div className="flex items-center justify-center">
                        <ChevronDown
                          className={cn(
                            "size-4 transition-transform",
                            expanded && "rotate-180",
                          )}
                        />
                        </div>
                      </TableCell>
                      <TableCell className="font-medium">
                        {batch.subject}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {batch.preview || "—"}
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
                      <TableCell className="w-12 text-right">
                        <DropdownMenu
                          open={openActionMenuBatchId === batch.id}
                          onOpenChange={(open) =>
                            setOpenActionMenuBatchId(open ? batch.id : null)
                          }
                        >
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="text-muted-foreground"
                              aria-label={t("mail.history.actions.label", "Email actions")}
                              onClick={(event) => event.stopPropagation()}
                            >
                              <Ellipsis className="size-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent
                            align="end"
                            className="w-52"
                            onCloseAutoFocus={(event) => event.preventDefault()}
                          >
                            <DropdownMenuItem
                              onClick={(event) => {
                                event.stopPropagation()
                                setSelectedTrackingBatch({
                                  id: batch.id,
                                  subject: batch.subject,
                                })
                              }}
                            >
                              {t("mail.history.actions.filterTracking", "Filter tracking to this email")}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="text-destructive focus:text-destructive"
                              onClick={(event) => {
                                event.stopPropagation()
                                setPendingDelete(batch)
                              }}
                            >
                              {t("mail.history.delete.label", "Delete email")}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
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

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setPendingDelete(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("mail.history.delete.confirmTitle", "Delete this email?")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete
                ? t(
                    "mail.history.delete.confirmDescription",
                    "This permanently removes the send record, all per-recipient rows, and any tracked opens or clicks. This cannot be undone.",
                  )
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pendingDelete ? (
            <div className="rounded-md border bg-muted/30 p-3 text-sm">
              <p className="truncate font-medium">{pendingDelete.subject}</p>
              <p className="text-xs text-muted-foreground">
                {pendingDelete.recipientCount}{" "}
                {pendingDelete.recipientCount === 1
                  ? t("mail.history.summary.recipient", "recipient")
                  : t("mail.history.summary.recipients", "recipients")}
                {" · "}
                {formatSentAt(pendingDelete.sentAt)}
              </p>
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>
              {t("mail.history.delete.cancel", "Cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={(event) => {
                event.preventDefault()
                void handleConfirmDelete()
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
    </div>
  )
}
