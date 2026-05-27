"use client"

import * as React from "react"
import Link from "next/link"
import { AlertTriangle, Calculator, ChevronRight, Search } from "lucide-react"

import { createClient } from "@/lib/supabase/client"
import { cn } from "@/lib/utils"
import { useTranslation } from "@/hooks/use-translation"
import { useUser } from "@/hooks/use-user"
import { useScope } from "@/hooks/use-scope"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
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
import { KPI_DEFINITIONS } from "@/lib/fortnox-sie/kpi-definitions"

/**
 * /key-metrics — overview of SIE-derived financial KPIs across all customers
 * with a synced general ledger.
 *
 * One row per customer that has a successful sie_import for the current
 * calendar year. Columns: customer name, then one column per KPI (current
 * year only), then a "→" affordance linking to the per-customer detail
 * page. Flagged values render with a warning badge so anything tripping a
 * target (negative margin, kassalikviditet < 100%, etc.) is visible at a
 * glance.
 */

interface KpiRow {
  customerId: string
  customerName: string
  fortnoxCustomerNumber: string | null
  values: Record<string, { value: number | null; flagged: boolean }>
  /** Year the values belong to (financial_year_from). */
  yearFrom: string
  /** Number of flagged KPIs in this row — drives row-level highlight. */
  flaggedCount: number
}

// Compact intl formatters used in the table cells.
const KR_FORMATTER = new Intl.NumberFormat("sv-SE", {
  maximumFractionDigits: 0,
})
const PCT_FORMATTER = new Intl.NumberFormat("sv-SE", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})

function formatKpiValue(
  value: number | null,
  unit: "kr" | "%" | "ratio",
  decimals: number,
): string {
  if (value == null || !Number.isFinite(value)) return "—"
  if (unit === "kr") return `${KR_FORMATTER.format(value)} kr`
  if (unit === "%") {
    // Honour the per-KPI decimal count via a one-shot formatter so we
    // don't allocate a new Intl every render.
    const formatted =
      decimals === 0
        ? Math.round(value).toLocaleString("sv-SE")
        : value.toLocaleString("sv-SE", {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals,
          })
    return `${formatted} %`
  }
  // ratio
  return PCT_FORMATTER.format(value)
}

export default function NyckeltalOverviewPage() {
  const { isAdmin } = useUser()
  // useScope returns true for admins automatically, plus anyone with the
  // 'customers' scope explicitly assigned. Same gate as the rest of the
  // customer-data pages (mail, reports).
  const hasCustomersScope = useScope("customers")
  const { t } = useTranslation()
  const [rows, setRows] = React.useState<KpiRow[]>([])
  const [loading, setLoading] = React.useState(true)
  const [searchQuery, setSearchQuery] = React.useState("")
  // Default to current calendar year; the UI doesn't expose a year picker
  // yet — that's a follow-up. The KPI engine stores rows keyed by
  // financial_year_from, so swapping years is a one-line change once we add
  // the picker.
  const currentYear = new Date().getFullYear()
  const yearFrom = `${currentYear}-01-01`

  // Visible to admins and to anyone with the `customers` scope. The
  // RLS policy on sie_kpis enforces the scope server-side; this check is
  // just to render an informative empty state on the client.
  const hasAccess = isAdmin || hasCustomersScope

  React.useEffect(() => {
    if (!hasAccess) {
      setLoading(false)
      return
    }
    let cancelled = false

    void (async () => {
      setLoading(true)
      const supabase = createClient()

      // Pull every YEAR-period sie_kpis row for the current year, joined
      // back to customers so we can show names. Filtering by period='YEAR'
      // limits the result to one row per (customer, KPI) — the per-month
      // rows live in the same table but power the detail page.
      const { data, error } = await supabase
        .from("sie_kpis")
        .select(
          "customer_id, kpi_key, value, flagged, financial_year_from, customers!inner(id, name, fortnox_customer_number)",
        )
        .eq("financial_year_from", yearFrom)
        .eq("period", "YEAR")

      if (cancelled) return

      if (error) {
        console.error("[key-metrics] failed to load sie_kpis:", error)
        setRows([])
        setLoading(false)
        return
      }

      // Group rows by customer, building a values map per KPI.
      const byCustomer = new Map<string, KpiRow>()
      for (const raw of (data ?? []) as Array<{
        customer_id: string
        kpi_key: string
        value: number | string | null
        flagged: boolean
        financial_year_from: string
        customers: {
          id: string
          name: string
          fortnox_customer_number: string | null
        } | null
      }>) {
        const customer = raw.customers
        if (!customer) continue
        let row = byCustomer.get(raw.customer_id)
        if (!row) {
          row = {
            customerId: raw.customer_id,
            customerName: customer.name,
            fortnoxCustomerNumber: customer.fortnox_customer_number,
            values: {},
            yearFrom: raw.financial_year_from,
            flaggedCount: 0,
          }
          byCustomer.set(raw.customer_id, row)
        }
        // Supabase numeric() may arrive as string in some drivers; coerce.
        const numericValue =
          raw.value == null
            ? null
            : typeof raw.value === "string"
              ? Number(raw.value)
              : raw.value
        row.values[raw.kpi_key] = {
          value:
            numericValue == null || !Number.isFinite(numericValue)
              ? null
              : numericValue,
          flagged: raw.flagged,
        }
        if (raw.flagged) row.flaggedCount += 1
      }

      const sorted = Array.from(byCustomer.values()).sort((a, b) =>
        a.customerName.localeCompare(b.customerName, "sv"),
      )
      setRows(sorted)
      setLoading(false)
    })()

    return () => {
      cancelled = true
    }
  }, [hasAccess, yearFrom])

  const filteredRows = React.useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((row) => {
      return (
        row.customerName.toLowerCase().includes(q) ||
        (row.fortnoxCustomerNumber?.toLowerCase().includes(q) ?? false)
      )
    })
  }, [rows, searchQuery])

  const flaggedRowCount = rows.filter((r) => r.flaggedCount > 0).length

  if (!hasAccess) {
    return (
      <div className="rounded-md border bg-muted/20 p-8 text-center text-sm text-muted-foreground">
        {t(
          "keyMetrics.noAccess",
          "You don't have access to financial KPIs. Ask an admin to grant the customers scope.",
        )}
      </div>
    )
  }

  return (
    <TooltipProvider delayDuration={150}>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold">
              <Calculator className="size-5 text-muted-foreground" />
              {t("keyMetrics.title", "Nyckeltal")}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t(
                "keyMetrics.subtitle",
                "Financial KPIs derived from each customer's synced SIE file.",
              )}{" "}
              <span className="font-medium text-foreground">{currentYear}</span>
            </p>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span>
              {t("keyMetrics.stats.customers", "Customers")}:{" "}
              <span className="font-medium text-foreground">{rows.length}</span>
            </span>
            <span>
              {t("keyMetrics.stats.flaggedRows", "Flagged")}:{" "}
              <span
                className={cn(
                  "font-medium",
                  flaggedRowCount > 0
                    ? "text-semantic-warning"
                    : "text-foreground",
                )}
              >
                {flaggedRowCount}
              </span>
            </span>
          </div>
        </div>

        {/* Search */}
        <div className="relative w-full sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={t(
              "keyMetrics.searchPlaceholder",
              "Search by customer name or Fortnox #",
            )}
            className="pl-9"
          />
        </div>

        {/* Table */}
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} className="h-12 w-full rounded-md" />
            ))}
          </div>
        ) : filteredRows.length === 0 ? (
          <div className="rounded-md border p-8 text-center text-sm text-muted-foreground">
            {rows.length === 0
              ? t(
                  "keyMetrics.empty",
                  "No SIE-synced customers yet. Connect customers in Settings → SIE, sync their ledgers, then generate KPIs.",
                )
              : t(
                  "keyMetrics.emptyFilter",
                  "No customers match the current search.",
                )}
          </div>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-[200px]">
                    {t("keyMetrics.columns.customer", "Customer")}
                  </TableHead>
                  {KPI_DEFINITIONS.map((def) => (
                    <TableHead
                      key={def.key}
                      className="text-right whitespace-nowrap"
                    >
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="cursor-help underline decoration-dotted underline-offset-4">
                            {/* Swedish names by default. UI strings can localise
                                later via i18n, but the canonical KPI name lives
                                with the definition. */}
                            {def.names.sv}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent
                          side="bottom"
                          className="max-w-xs text-xs"
                        >
                          {def.descriptions.sv}
                        </TooltipContent>
                      </Tooltip>
                    </TableHead>
                  ))}
                  <TableHead className="w-[44px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRows.map((row) => (
                  <TableRow
                    key={row.customerId}
                    className={cn(
                      "transition-colors",
                      row.flaggedCount > 0 && "bg-semantic-warning/[0.04]",
                    )}
                  >
                    <TableCell>
                      <Link
                        href={`/key-metrics/${row.customerId}`}
                        className="font-medium hover:underline"
                      >
                        {row.customerName}
                      </Link>
                      {row.fortnoxCustomerNumber ? (
                        <div className="text-xs text-muted-foreground">
                          #{row.fortnoxCustomerNumber}
                        </div>
                      ) : null}
                    </TableCell>
                    {KPI_DEFINITIONS.map((def) => {
                      const cell = row.values[def.key]
                      const display = formatKpiValue(
                        cell?.value ?? null,
                        def.unit,
                        def.decimals,
                      )
                      const flagged = cell?.flagged ?? false
                      return (
                        <TableCell
                          key={def.key}
                          className="text-right whitespace-nowrap tabular-nums"
                        >
                          {flagged ? (
                            <Badge
                              variant="outline"
                              className="border-semantic-warning text-semantic-warning gap-1"
                            >
                              <AlertTriangle className="size-3" />
                              {display}
                            </Badge>
                          ) : (
                            <span className={cn(cell?.value == null && "text-muted-foreground")}>
                              {display}
                            </span>
                          )}
                        </TableCell>
                      )
                    })}
                    <TableCell className="w-[44px] text-right">
                      <Link
                        href={`/key-metrics/${row.customerId}`}
                        aria-label={t("keyMetrics.openDetail", "Open detail view")}
                        className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        <ChevronRight className="size-4" />
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {/* Footer note — explains what "flagged" means without cluttering
            individual cells. */}
        {!loading && rows.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            {t(
              "keyMetrics.flagExplainer",
              "Values are flagged when they breach the KPI's target threshold (e.g. kassalikviditet < 100 %, negative EBIT). Hover the column name for the formula and threshold.",
            )}
          </p>
        ) : null}
      </div>
    </TooltipProvider>
  )
}
