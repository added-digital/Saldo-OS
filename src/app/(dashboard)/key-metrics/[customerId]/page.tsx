"use client"

import * as React from "react"
import Link from "next/link"
import { useParams } from "next/navigation"
import {
  AlertTriangle,
  ArrowLeft,
  Calculator,
  TrendingUp,
} from "lucide-react"
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts"

import { createClient } from "@/lib/supabase/client"
import { cn } from "@/lib/utils"
import { useTranslation } from "@/hooks/use-translation"
import { useUser } from "@/hooks/use-user"
import { useScope } from "@/hooks/use-scope"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
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
  KPI_DEFINITIONS,
  KPI_DEFINITIONS_BY_KEY,
  type KpiDefinition,
  type KpiTarget,
} from "@/lib/fortnox-sie/kpi-definitions"

/**
 * /key-metrics/[customerId] — per-customer financial KPI detail page.
 *
 * Top: header + back link to overview.
 * Cards: one per KPI with current value, target, flagged badge, formula.
 * Chart: monthly bars for revenue + EBIT (the two cash-flow KPIs everyone
 *        cares about month-over-month).
 * Table: a compact P&L summary built from the KPI inputs (revenue, COGS,
 *        gross profit, EBIT) for the current year.
 */

interface KpiRow {
  kpiKey: string
  period: string // 'YEAR' or 'YYYYMM'
  value: number | null
  unit: string
  flagged: boolean
  target: KpiTarget | null
  inputs: Record<string, number | null>
  financialYearFrom: string
}

interface CustomerInfo {
  id: string
  name: string
  fortnox_customer_number: string | null
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const KR_FORMATTER = new Intl.NumberFormat("sv-SE", {
  maximumFractionDigits: 0,
})

function formatValue(
  value: number | null,
  unit: string,
  decimals: number,
): string {
  if (value == null || !Number.isFinite(value)) return "—"
  if (unit === "kr") return `${KR_FORMATTER.format(value)} kr`
  if (unit === "%") {
    const formatted =
      decimals === 0
        ? Math.round(value).toLocaleString("sv-SE")
        : value.toLocaleString("sv-SE", {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals,
          })
    return `${formatted} %`
  }
  return value.toLocaleString("sv-SE", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

function formatTarget(target: KpiTarget | null): string | null {
  if (!target) return null
  const opSymbol =
    target.op === "gte"
      ? "≥"
      : target.op === "gt"
        ? ">"
        : target.op === "lte"
          ? "≤"
          : "<"
  const unitSuffix =
    target.unit === "kr" ? " kr" : target.unit === "%" ? " %" : ""
  return `${opSymbol} ${target.value}${unitSuffix}`
}

// Pretty-print 'YYYYMM' → 'jan 26', 'feb 26', ...
const MONTH_NAMES_SV = [
  "jan",
  "feb",
  "mar",
  "apr",
  "maj",
  "jun",
  "jul",
  "aug",
  "sep",
  "okt",
  "nov",
  "dec",
]

function formatPeriodLabel(period: string): string {
  if (period === "YEAR" || !/^\d{6}$/.test(period)) return period
  const year = period.slice(2, 4)
  const month = Number(period.slice(4, 6))
  return `${MONTH_NAMES_SV[month - 1] ?? "?"} ${year}`
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function NyckeltalDetailPage() {
  const params = useParams<{ customerId: string }>()
  const customerId = params.customerId
  const { isAdmin } = useUser()
  const hasCustomersScope = useScope("customers")
  const { t } = useTranslation()

  const [customer, setCustomer] = React.useState<CustomerInfo | null>(null)
  const [kpiRows, setKpiRows] = React.useState<KpiRow[]>([])
  const [loading, setLoading] = React.useState(true)
  const [notFound, setNotFound] = React.useState(false)

  const currentYear = new Date().getFullYear()
  const yearFrom = `${currentYear}-01-01`
  const hasAccess = isAdmin || hasCustomersScope

  React.useEffect(() => {
    if (!hasAccess || !customerId) {
      setLoading(false)
      return
    }
    let cancelled = false

    void (async () => {
      setLoading(true)
      const supabase = createClient()

      const [customerRes, kpiRes] = await Promise.all([
        supabase
          .from("customers")
          .select("id, name, fortnox_customer_number")
          .eq("id", customerId)
          .maybeSingle(),
        // Pull ALL periods for the current year — both YEAR rollup and
        // monthly rows. Detail page needs both: cards from YEAR, chart
        // from monthly.
        supabase
          .from("sie_kpis")
          .select(
            "kpi_key, period, value, unit, flagged, target, inputs, financial_year_from",
          )
          .eq("customer_id", customerId)
          .eq("financial_year_from", yearFrom),
      ])

      if (cancelled) return

      if (customerRes.error || !customerRes.data) {
        setNotFound(true)
        setLoading(false)
        return
      }
      setCustomer(customerRes.data as CustomerInfo)

      if (kpiRes.error) {
        console.error("[key-metrics detail] failed to load sie_kpis:", kpiRes.error)
        setKpiRows([])
      } else {
        setKpiRows(
          ((kpiRes.data ?? []) as Array<KpiRow & { value: number | string | null }>).map(
            (r) => ({
              ...r,
              value:
                r.value == null
                  ? null
                  : typeof r.value === "string"
                    ? Number(r.value)
                    : r.value,
            }),
          ),
        )
      }
      setLoading(false)
    })()

    return () => {
      cancelled = true
    }
  }, [customerId, hasAccess, yearFrom])

  // Slice the rows into YEAR (one per KPI) and monthly (per KPI per month).
  const yearByKpi = React.useMemo(() => {
    const out: Record<string, KpiRow> = {}
    for (const row of kpiRows) if (row.period === "YEAR") out[row.kpiKey] = row
    return out
  }, [kpiRows])

  // Build the monthly chart data: one entry per month with revenue + ebit.
  const monthlyChartData = React.useMemo(() => {
    const byMonth = new Map<string, { period: string; revenue: number | null; ebit: number | null }>()
    for (const row of kpiRows) {
      if (row.period === "YEAR") continue
      if (row.kpiKey !== "revenue" && row.kpiKey !== "ebit") continue
      let entry = byMonth.get(row.period)
      if (!entry) {
        entry = { period: row.period, revenue: null, ebit: null }
        byMonth.set(row.period, entry)
      }
      if (row.kpiKey === "revenue") entry.revenue = row.value
      if (row.kpiKey === "ebit") entry.ebit = row.value
    }
    return Array.from(byMonth.values())
      .sort((a, b) => a.period.localeCompare(b.period))
      .map((e) => ({
        period: e.period,
        label: formatPeriodLabel(e.period),
        revenue: e.revenue ?? 0,
        ebit: e.ebit ?? 0,
      }))
  }, [kpiRows])

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

  if (notFound) {
    return (
      <div className="space-y-4">
        <Link
          href="/key-metrics"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          {t("keyMetrics.backToOverview", "Back to overview")}
        </Link>
        <div className="rounded-md border bg-muted/20 p-8 text-center text-sm text-muted-foreground">
          {t("keyMetrics.detail.notFound", "Customer not found.")}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header strip */}
      <div className="space-y-3">
        <Link
          href="/key-metrics"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          {t("keyMetrics.backToOverview", "Back to overview")}
        </Link>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold">
              <Calculator className="size-5 text-muted-foreground" />
              {loading || !customer ? (
                <Skeleton className="h-6 w-48" />
              ) : (
                customer.name
              )}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t("keyMetrics.detail.subtitle", "Financial KPIs for")}{" "}
              <span className="font-medium text-foreground">{currentYear}</span>
              {customer?.fortnox_customer_number ? (
                <> — Fortnox #{customer.fortnox_customer_number}</>
              ) : null}
            </p>
          </div>
        </div>
      </div>

      {/* KPI cards */}
      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {KPI_DEFINITIONS.map((d) => (
            <Skeleton key={d.key} className="h-32 w-full rounded-lg" />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {KPI_DEFINITIONS.map((def) => {
            const row = yearByKpi[def.key]
            return (
              <KpiCard
                key={def.key}
                definition={def}
                row={row}
              />
            )
          })}
        </div>
      )}

      {/* Monthly trend chart */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <TrendingUp className="size-4 text-muted-foreground" />
                {t("keyMetrics.detail.trendTitle", "Monthly trend")}
              </CardTitle>
              <CardDescription>
                {t(
                  "keyMetrics.detail.trendDescription",
                  "Revenue and operating result per month, current financial year.",
                )}
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-[280px] w-full" />
          ) : monthlyChartData.length === 0 ? (
            <div className="flex h-[200px] items-center justify-center text-sm text-muted-foreground">
              {t(
                "keyMetrics.detail.noMonthlyData",
                "No monthly data yet. Trigger a SIE sync to populate period balances.",
              )}
            </div>
          ) : (
            <div className="h-[320px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={monthlyChartData}
                  margin={{ top: 12, right: 12, bottom: 8, left: 8 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    className="stroke-muted-foreground/20"
                  />
                  <XAxis
                    dataKey="label"
                    tickLine={false}
                    axisLine={false}
                    fontSize={11}
                  />
                  <YAxis
                    tickFormatter={(v) =>
                      KR_FORMATTER.format(Number(v)).replace(/ /g, " ")
                    }
                    width={70}
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                  />
                  <RechartsTooltip
                    formatter={(value) =>
                      `${KR_FORMATTER.format(Number(value))} kr`
                    }
                    labelClassName="text-xs"
                    contentStyle={{
                      backgroundColor: "var(--color-bg-secondary)",
                      borderColor: "var(--color-border-default)",
                      fontSize: "12px",
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: "12px" }} />
                  <Bar
                    name={t("keyMetrics.kpi.revenue", "Omsättning")}
                    dataKey="revenue"
                    fill="var(--color-brand-primary)"
                    radius={[2, 2, 0, 0]}
                  />
                  <Bar
                    name={t("keyMetrics.kpi.ebit", "Rörelseresultat")}
                    dataKey="ebit"
                    radius={[2, 2, 0, 0]}
                  >
                    {/* Per-cell colouring so a loss-month is rendered with the
                        warning colour instead of the brand colour — quick visual
                        signal alongside the flag badges in the cards above. */}
                    {monthlyChartData.map((entry, i) => (
                      <Cell
                        key={i}
                        fill={
                          entry.ebit < 0
                            ? "var(--color-error)"
                            : "var(--color-success)"
                        }
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      {/* P&L summary table — built from the KPI engine's "inputs" payload */}
      <PlSummaryCard yearByKpi={yearByKpi} loading={loading} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// KPI Card
// ---------------------------------------------------------------------------

function KpiCard({
  definition,
  row,
}: {
  definition: KpiDefinition
  row: KpiRow | undefined
}) {
  const { t } = useTranslation()
  const value = row?.value ?? null
  const flagged = row?.flagged ?? false
  const targetLabel = formatTarget(definition.target ?? null)

  return (
    <Card
      className={cn(
        "transition-colors",
        flagged && "border-semantic-warning/40 bg-semantic-warning/[0.04]",
      )}
    >
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            {/* Swedish names live with the definition; locale switching is
                handled at the i18n layer for surrounding UI chrome. */}
            {definition.names.sv}
          </CardTitle>
          {flagged ? (
            <Badge
              variant="outline"
              className="gap-1 border-semantic-warning text-semantic-warning"
            >
              <AlertTriangle className="size-3" />
              {t("keyMetrics.detail.flag", "Off target")}
            </Badge>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-1">
        <div
          className={cn(
            "text-2xl font-semibold tabular-nums",
            value == null && "text-muted-foreground",
          )}
        >
          {formatValue(value, definition.unit, definition.decimals)}
        </div>
        {targetLabel ? (
          <div className="text-xs text-muted-foreground">
            {t("keyMetrics.detail.target", "Target")}: {targetLabel}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">
            {t("keyMetrics.detail.informational", "Informational")}
          </div>
        )}
        <p className="pt-2 text-xs leading-relaxed text-muted-foreground">
          {definition.descriptions.sv}
        </p>
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// P&L summary
// ---------------------------------------------------------------------------

function PlSummaryCard({
  yearByKpi,
  loading,
}: {
  yearByKpi: Record<string, KpiRow>
  loading: boolean
}) {
  const { t } = useTranslation()

  // Pull sub-totals captured by the engine as "inputs" on the relevant
  // KPI rows. Gross_margin_pct carries both revenue and COGS sub-totals
  // because its expression tree references both ranges; EBIT carries the
  // combined 3000–7999 sum. Falling back gracefully if any are missing.
  const revenueInput =
    yearByKpi["gross_margin_pct"]?.inputs?.["Intäkter"] ??
    yearByKpi["revenue"]?.inputs?.["Intäkter"] ??
    null
  const cogsInput =
    yearByKpi["gross_margin_pct"]?.inputs?.["Kostnad sålda varor"] ?? null
  const grossProfit =
    revenueInput != null && cogsInput != null ? revenueInput - cogsInput : null
  const ebit = yearByKpi["ebit"]?.value ?? null
  const opexAndCogs =
    revenueInput != null && ebit != null ? revenueInput - ebit : null
  const opexOther =
    opexAndCogs != null && cogsInput != null ? opexAndCogs - cogsInput : null

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {t("keyMetrics.detail.plTitle", "P&L summary")}
        </CardTitle>
        <CardDescription>
          {t(
            "keyMetrics.detail.plDescription",
            "Year-to-date totals from the synced ledger.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-48 w-full" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("keyMetrics.detail.plLine", "Line")}</TableHead>
                <TableHead className="text-right">
                  {t("keyMetrics.detail.plAmount", "Amount")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <PlRow
                label={KPI_DEFINITIONS_BY_KEY.revenue?.names.sv ?? "Omsättning"}
                value={revenueInput}
              />
              <PlRow
                label={t("keyMetrics.detail.plCogs", "− Kostnad sålda varor")}
                value={cogsInput == null ? null : -cogsInput}
              />
              <PlRow
                label={t("keyMetrics.detail.plGrossProfit", "= Bruttovinst")}
                value={grossProfit}
                bold
              />
              <PlRow
                label={t(
                  "keyMetrics.detail.plOtherOpex",
                  "− Övriga rörelsekostnader (klass 5–7)",
                )}
                value={opexOther == null ? null : -opexOther}
              />
              <PlRow
                label={
                  KPI_DEFINITIONS_BY_KEY.ebit?.names.sv ?? "Rörelseresultat"
                }
                value={ebit}
                bold
              />
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}

function PlRow({
  label,
  value,
  bold,
}: {
  label: string
  value: number | null
  bold?: boolean
}) {
  return (
    <TableRow>
      <TableCell className={cn(bold && "font-semibold")}>{label}</TableCell>
      <TableCell
        className={cn(
          "text-right tabular-nums",
          bold && "font-semibold",
          value != null && value < 0 && "text-semantic-error",
        )}
      >
        {value == null || !Number.isFinite(value) ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          `${KR_FORMATTER.format(value)} kr`
        )}
      </TableCell>
    </TableRow>
  )
}

