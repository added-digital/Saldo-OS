"use client"

import * as React from "react"
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Link2,
  RefreshCw,
  Search,
} from "lucide-react"
import { toast } from "sonner"

import { createClient } from "@/lib/supabase/client"
import { cn } from "@/lib/utils"
import { useTranslation } from "@/hooks/use-translation"
import { useUser } from "@/hooks/use-user"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { SieConnectionStatus } from "@/types/database"

// A connection flagged `error` because the SIE file's org number didn't match
// the customer's is worth distinguishing from a generic sync error — it means
// the OAuth grant is bound to the wrong Fortnox company. We detect it from the
// stored last_error text (see sync.ts), which always contains this phrase.
function isOrgMismatch(lastError: string | null): boolean {
  return !!lastError && /does not match/i.test(lastError)
}

// One row per customer in the table. We compose this client-side by joining
// `customers` with `sie_connections` so a customer that hasn't been touched
// yet shows up with status = "not_connected" (no row exists yet).
type SieStatus = SieConnectionStatus | "not_connected"

type SieRow = {
  customerId: string
  customerName: string
  fortnoxCustomerNumber: string | null
  status: SieStatus
  lastSyncedAt: string | null
  lastError: string | null
}

type StatusFilter = "all" | SieStatus

const PAGE_SIZE_OPTIONS = [25, 50, 100] as const
const DEFAULT_PAGE_SIZE = 25

const STATUS_FILTERS: { value: StatusFilter; labelKey: string; fallback: string }[] = [
  { value: "all", labelKey: "settings.sie.filter.all", fallback: "All" },
  {
    value: "not_connected",
    labelKey: "settings.sie.filter.notConnected",
    fallback: "Not connected",
  },
  { value: "pending", labelKey: "settings.sie.filter.pending", fallback: "Pending" },
  { value: "active", labelKey: "settings.sie.filter.active", fallback: "Connected" },
  {
    value: "needs_reauth",
    labelKey: "settings.sie.filter.needsReauth",
    fallback: "Needs re-auth",
  },
  { value: "error", labelKey: "settings.sie.filter.error", fallback: "Error" },
]

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—"
  try {
    const date = new Date(iso)
    return new Intl.DateTimeFormat("sv-SE", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date)
  } catch {
    return iso
  }
}

export default function SettingsSiePage() {
  const { isAdmin } = useUser()
  const { t } = useTranslation()
  const [rows, setRows] = React.useState<SieRow[]>([])
  const [loading, setLoading] = React.useState(true)
  const [refreshing, setRefreshing] = React.useState(false)
  const [searchQuery, setSearchQuery] = React.useState("")
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>("all")
  const [pageIndex, setPageIndex] = React.useState(0)
  const [pageSize, setPageSize] = React.useState<number>(DEFAULT_PAGE_SIZE)
  const [connectingCustomerId, setConnectingCustomerId] = React.useState<
    string | null
  >(null)

  // Prefill the search box from a ?search= param (e.g. when arriving from a
  // customer card's "Connect SIE" shortcut). Read from window.location rather
  // than useSearchParams to avoid needing a Suspense boundary on this page.
  React.useEffect(() => {
    const term = new URLSearchParams(window.location.search).get("search")
    if (term) setSearchQuery(term)
  }, [])

  const loadRows = React.useCallback(async () => {
    const supabase = createClient()

    // Customers come from the customers table; existing SIE state (if any)
    // comes from sie_connections. We outer-join client-side so a customer
    // with no row yet shows as "not_connected".
    //
    // Scoped to status = 'active' because paused/former/archived customers
    // don't need a SIE link — their general ledger isn't going to change
    // and burning OAuth on them just clutters the onboarding list.
    const [customersResult, connectionsResult] = await Promise.all([
      supabase
        .from("customers")
        .select("id, name, fortnox_customer_number")
        .eq("status", "active")
        .order("name", { ascending: true }),
      supabase
        .from("sie_connections")
        .select(
          "customer_id, connection_status, last_synced_at, last_error",
        ),
    ])

    if (customersResult.error) {
      toast.error(
        `${t("settings.sie.toast.loadFailed", "Failed to load customers")}: ${customersResult.error.message}`,
      )
      return
    }
    if (connectionsResult.error) {
      // Non-fatal — we can still show "not_connected" for everyone.
      console.error(
        "[settings/sie] failed to load sie_connections:",
        connectionsResult.error,
      )
    }

    const customers = (customersResult.data ?? []) as Array<{
      id: string
      name: string
      fortnox_customer_number: string | null
    }>
    const connections = (connectionsResult.data ?? []) as Array<{
      customer_id: string
      connection_status: SieConnectionStatus
      last_synced_at: string | null
      last_error: string | null
    }>

    const connectionsByCustomer = new Map(
      connections.map((c) => [c.customer_id, c]),
    )

    setRows(
      customers.map((customer) => {
        const conn = connectionsByCustomer.get(customer.id)
        return {
          customerId: customer.id,
          customerName: customer.name,
          fortnoxCustomerNumber: customer.fortnox_customer_number,
          status: conn?.connection_status ?? ("not_connected" as SieStatus),
          lastSyncedAt: conn?.last_synced_at ?? null,
          lastError: conn?.last_error ?? null,
        }
      }),
    )
  }, [t])

  React.useEffect(() => {
    if (!isAdmin) {
      setLoading(false)
      return
    }
    void (async () => {
      setLoading(true)
      try {
        await loadRows()
      } finally {
        setLoading(false)
      }
    })()
  }, [isAdmin, loadRows])

  // Surface the outcome of an OAuth round-trip. The callback route redirects
  // back here with ?success=true or ?error=<code>. We read it once on mount,
  // toast it, then strip the params from the URL so a refresh doesn't re-fire
  // the toast. Using window.location avoids needing a Suspense boundary for
  // useSearchParams on this settings sub-page.
  React.useEffect(() => {
    if (typeof window === "undefined") return
    const params = new URLSearchParams(window.location.search)
    const success = params.get("success")
    const error = params.get("error")
    if (!success && !error) return

    if (success === "true") {
      toast.success(
        t("settings.sie.toast.connected", "Customer connected to SIE"),
      )
    } else if (error === "org_mismatch") {
      const fortnoxOrg = params.get("fortnox_org")
      toast.error(
        t(
          "settings.sie.toast.orgMismatch",
          "Wrong company: the Fortnox account you authorized doesn't match this customer's org number",
        ) + (fortnoxOrg ? ` (Fortnox: ${fortnoxOrg})` : ""),
        { duration: 8000 },
      )
    } else if (error) {
      const message = params.get("message")
      toast.error(
        `${t("settings.sie.toast.connectFailed", "Connection failed")}: ${message ?? error}`,
      )
    }

    // Strip the one-shot params so the toast doesn't repeat on refresh.
    params.delete("success")
    params.delete("error")
    params.delete("message")
    params.delete("customer_id")
    params.delete("fortnox_org")
    const query = params.toString()
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}`,
    )
    // Re-load so a freshly-connected customer's status flips to active.
    void loadRows()
  }, [t, loadRows])

  async function handleManualRefresh() {
    setRefreshing(true)
    try {
      await loadRows()
      toast.success(t("settings.sie.toast.refreshed", "Connection list refreshed"))
    } catch (err) {
      toast.error(
        `${t("settings.sie.toast.refreshFailed", "Failed to refresh")}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    } finally {
      setRefreshing(false)
    }
  }

  // Aggregate counters for the header strip ("612 / 700 connected" etc.).
  const stats = React.useMemo(() => {
    const counts: Record<SieStatus, number> = {
      not_connected: 0,
      pending: 0,
      active: 0,
      needs_reauth: 0,
      error: 0,
    }
    for (const row of rows) counts[row.status] += 1
    return counts
  }, [rows])

  const filteredRows = React.useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    return rows.filter((row) => {
      if (statusFilter !== "all" && row.status !== statusFilter) return false
      if (!q) return true
      return (
        row.customerName.toLowerCase().includes(q) ||
        (row.fortnoxCustomerNumber?.toLowerCase().includes(q) ?? false)
      )
    })
  }, [rows, searchQuery, statusFilter])

  const pageCount = React.useMemo(
    () => Math.max(1, Math.ceil(filteredRows.length / pageSize)),
    [filteredRows.length, pageSize],
  )

  // Keep pageIndex in bounds whenever the underlying filter shrinks or grows
  // (e.g. switching status filter, typing in search). Without this, you'd be
  // stranded on an empty page-3 after narrowing results to 12 rows.
  React.useEffect(() => {
    setPageIndex((current) => {
      if (current < 0) return 0
      if (current >= pageCount) return pageCount - 1
      return current
    })
  }, [pageCount])

  // Searching or changing the status filter should always send you back to
  // page 1 — anything else is disorienting.
  React.useEffect(() => {
    setPageIndex(0)
  }, [searchQuery, statusFilter])

  const paginatedRows = React.useMemo(() => {
    const from = pageIndex * pageSize
    return filteredRows.slice(from, from + pageSize)
  }, [filteredRows, pageIndex, pageSize])

  const visibleFrom = filteredRows.length === 0 ? 0 : pageIndex * pageSize + 1
  const visibleTo = Math.min(
    filteredRows.length,
    (pageIndex + 1) * pageSize,
  )

  function handleConnect(row: SieRow) {
    // Navigate the top-level browser context to /api/fortnox-sie/auth so
    // Fortnox's authorize page can take over the tab. The route sets a
    // short-lived CSRF cookie and redirects to Fortnox; on return, the
    // /api/fortnox-sie/callback route persists the tokens and redirects
    // back here with ?success=true&customer_id=... (or ?error=...).
    setConnectingCustomerId(row.customerId)
    const url = `/api/fortnox-sie/auth?customer_id=${encodeURIComponent(row.customerId)}`
    window.location.assign(url)
  }

  if (!isAdmin) {
    return <div className="h-40 rounded-lg border bg-muted/20" />
  }

  return (
    <TooltipProvider delayDuration={150}>
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">
            {t("settings.sie.title", "SIE integration")}
          </h3>
          <p className="text-sm text-muted-foreground">
            {t(
              "settings.sie.description",
              "Authorize the SIE integration for each customer once. The nightly sync uses the stored tokens to pull their general ledger.",
            )}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleManualRefresh}
          disabled={loading || refreshing}
          className="gap-1.5"
        >
          <RefreshCw
            className={cn("size-3.5", refreshing && "animate-spin")}
          />
          {t("settings.sie.refresh", "Refresh")}
        </Button>
      </div>

      {/* Stat strip: quick glance at how onboarding is going */}
      <div className="grid grid-cols-2 gap-2 rounded-md border bg-muted/10 p-3 sm:grid-cols-5">
        <StatCell
          label={t("settings.sie.stats.total", "Total customers")}
          value={rows.length}
        />
        <StatCell
          label={t("settings.sie.stats.connected", "Connected")}
          value={stats.active}
          tone="success"
        />
        <StatCell
          label={t("settings.sie.stats.notConnected", "Not connected")}
          value={stats.not_connected}
        />
        <StatCell
          label={t("settings.sie.stats.needsReauth", "Needs re-auth")}
          value={stats.needs_reauth}
          tone={stats.needs_reauth > 0 ? "warning" : undefined}
        />
        <StatCell
          label={t("settings.sie.stats.errors", "Errors")}
          value={stats.error}
          tone={stats.error > 0 ? "destructive" : undefined}
        />
      </div>

      {/* Search + status filter */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={t(
              "settings.sie.searchPlaceholder",
              "Search by name or Fortnox #",
            )}
            className="pl-9"
          />
        </div>
        <Select
          value={statusFilter}
          onValueChange={(value) => setStatusFilter(value as StatusFilter)}
        >
          <SelectTrigger className="w-full sm:w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_FILTERS.map((filter) => (
              <SelectItem key={filter.value} value={filter.value}>
                {t(filter.labelKey, filter.fallback)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Customers table */}
      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-12 w-full rounded-md" />
          ))}
        </div>
      ) : filteredRows.length === 0 ? (
        <div className="rounded-md border p-8 text-center text-sm text-muted-foreground">
          {rows.length === 0
            ? t("settings.sie.emptyTotal", "No customers yet.")
            : t(
                "settings.sie.emptyFilter",
                "No customers match the current filter.",
              )}
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border">
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead>
                  {t("settings.sie.columns.customer", "Customer")}
                </TableHead>
                <TableHead className="w-[140px]">
                  {t("settings.sie.columns.fortnoxNumber", "Fortnox #")}
                </TableHead>
                <TableHead className="w-[160px]">
                  {t("settings.sie.columns.status", "Status")}
                </TableHead>
                <TableHead className="w-[180px]">
                  {t("settings.sie.columns.lastSync", "Last sync")}
                </TableHead>
                <TableHead className="w-[140px] text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {paginatedRows.map((row) => (
                <TableRow key={row.customerId}>
                  <TableCell className="font-medium">
                    {row.customerName}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {row.fortnoxCustomerNumber ?? "—"}
                  </TableCell>
                  <TableCell>
                    <StatusBadge
                      status={row.status}
                      lastError={row.lastError}
                      t={t}
                    />
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatTimestamp(row.lastSyncedAt)}
                  </TableCell>
                  <TableCell className="w-[140px] text-right">
                    <Button
                      variant={row.status === "active" ? "outline" : "default"}
                      size="sm"
                      className="gap-1.5"
                      disabled={connectingCustomerId === row.customerId}
                      onClick={() => handleConnect(row)}
                    >
                      <Link2 className="size-3.5" />
                      {row.status === "active"
                        ? t("settings.sie.reconnect", "Reconnect")
                        : row.status === "needs_reauth"
                          ? t("settings.sie.reauthorize", "Re-authorize")
                          : t("settings.sie.connect", "Connect")}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Pagination footer — only shows when we have more rows than fit on one page */}
      {!loading && filteredRows.length > 0 ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            {t("settings.sie.pagination.showing", "Showing")}{" "}
            <span className="font-medium text-foreground">
              {visibleFrom}-{visibleTo}
            </span>{" "}
            {t("settings.sie.pagination.of", "of")}{" "}
            <span className="font-medium text-foreground">
              {filteredRows.length}
            </span>
          </p>
          <div className="flex items-center gap-2">
            <select
              value={pageSize}
              onChange={(event) => {
                setPageSize(Number(event.target.value))
                setPageIndex(0)
              }}
              className="h-9 rounded-md border border-input bg-background px-2 text-xs"
              aria-label={t(
                "settings.sie.pagination.rowsPerPage",
                "Rows per page",
              )}
            >
              {PAGE_SIZE_OPTIONS.map((size) => (
                <option key={size} value={size}>
                  {size} / {t("settings.sie.pagination.page", "page")}
                </option>
              ))}
            </select>
            <span className="text-xs text-muted-foreground">
              {pageIndex + 1} {t("settings.sie.pagination.ofShort", "of")}{" "}
              {pageCount}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-9 w-9"
              onClick={() =>
                setPageIndex((current) => Math.max(current - 1, 0))
              }
              disabled={pageIndex === 0}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-9 w-9"
              onClick={() =>
                setPageIndex((current) =>
                  Math.min(current + 1, pageCount - 1),
                )
              }
              disabled={pageIndex >= pageCount - 1}
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      ) : null}
    </div>
    </TooltipProvider>
  )
}

type StatCellProps = {
  label: string
  value: number
  tone?: "success" | "warning" | "destructive"
}

function StatCell({ label, value, tone }: StatCellProps) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={cn(
          "text-lg font-semibold leading-none",
          tone === "success" && "text-semantic-success",
          tone === "warning" && "text-semantic-warning",
          tone === "destructive" && "text-destructive",
        )}
      >
        {value}
      </p>
    </div>
  )
}

type StatusBadgeProps = {
  status: SieStatus
  lastError: string | null
  t: (key: string, fallback?: string) => string
}

function StatusBadge({ status, lastError, t }: StatusBadgeProps) {
  if (status === "active") {
    return (
      <Badge
        variant="secondary"
        className="bg-semantic-success/15 text-semantic-success"
      >
        {t("settings.sie.status.active", "Connected")}
      </Badge>
    )
  }
  if (status === "needs_reauth") {
    return (
      <Badge
        variant="outline"
        className="border-semantic-warning text-semantic-warning"
      >
        {t("settings.sie.status.needsReauth", "Needs re-auth")}
      </Badge>
    )
  }
  if (status === "error") {
    // An org-number mismatch means the grant is bound to the wrong Fortnox
    // company — surface that distinctly from a generic sync error, and put
    // the full stored detail in a tooltip.
    const mismatch = isOrgMismatch(lastError)
    const badge = (
      <Badge
        variant="outline"
        className="border-destructive text-destructive gap-1"
      >
        {mismatch ? <AlertTriangle className="size-3" /> : null}
        {mismatch
          ? t("settings.sie.status.orgMismatch", "Wrong company")
          : t("settings.sie.status.error", "Error")}
      </Badge>
    )
    if (!lastError) return badge
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-help">{badge}</span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs text-xs">
          {lastError}
        </TooltipContent>
      </Tooltip>
    )
  }
  if (status === "pending") {
    return (
      <Badge variant="outline">
        {t("settings.sie.status.pending", "Pending")}
      </Badge>
    )
  }
  return (
    <span className="text-xs text-muted-foreground">
      {t("settings.sie.status.notConnected", "Not connected")}
    </span>
  )
}
