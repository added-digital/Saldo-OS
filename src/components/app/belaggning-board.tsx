"use client"

import * as React from "react"
import {
  CalendarClock,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Columns3,
  Lock,
  ShieldCheck,
  Sparkles,
} from "lucide-react"
import { toast } from "sonner"

import { createClient } from "@/lib/supabase/client"
import { cn } from "@/lib/utils"
import { useTranslation } from "@/hooks/use-translation"
import type { ResourceBoardRow, ResourceStatus } from "@/types/resource"
import { PageHeader } from "@/components/app/page-header"
import { ManagerFilter } from "@/components/app/engagement-filters"
import { BelaggningCalendar } from "@/components/app/belaggning-calendar"
import { RecurringWorkSheet } from "@/components/app/recurring-work-sheet"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"

const ALL = "all"
const UNASSIGNED = "unassigned"

/**
 * Monthly capacity per person, in hours.
 *
 * There is no FTE or planned-absence data in the system, so this is a firm-wide
 * default rather than a per-person truth: ~160 working hours at the 75%
 * billable target the industry plans to (the remaining quarter absorbs sick
 * days, internal work and the urgent things nobody forecasts). Planned leave is
 * the missing input — until it exists, a July column will look overloaded
 * because the capacity is wrong, not because the work is.
 */
const MONTHLY_CAPACITY_HOURS = 120
/** ~4.33 weeks to a month; used to express the same capacity per week. */
const WEEKS_PER_MONTH = 4.33

type Consultant = { id: string; name: string }
type ViewMode = "kalender" | "tavla"

function monthLabel(year: number, month: number, locale: string) {
  return new Intl.DateTimeFormat(locale === "sv" ? "sv-SE" : "en-GB", {
    month: "long",
    year: "numeric",
  }).format(new Date(year, month - 1, 1))
}

const hourFormatter = new Intl.NumberFormat("sv-SE", {
  maximumFractionDigits: 1,
})
const sekFormatter = new Intl.NumberFormat("sv-SE", {
  maximumFractionDigits: 0,
})

/**
 * Hours are only shown as a number when the customer is big enough for the
 * estimate to mean anything. Below this the measured error is ~73%, so a point
 * estimate reads as precision that isn't there — the card shows its recurring
 * work instead and the column total still carries the hours.
 */
const MIN_HOURS_FOR_ESTIMATE = 2

export function BelaggningBoard() {
  const { t, language } = useTranslation()
  const supabase = React.useMemo(() => createClient(), [])

  const now = new Date()
  const [year, setYear] = React.useState(now.getFullYear())
  const [month, setMonth] = React.useState(now.getMonth() + 1)

  const [loading, setLoading] = React.useState(true)
  const [rows, setRows] = React.useState<ResourceBoardRow[]>([])
  const [statuses, setStatuses] = React.useState<ResourceStatus[]>([])
  const [consultants, setConsultants] = React.useState<Consultant[]>([])
  const [filterManager, setFilterManager] = React.useState<string>(ALL)
  const [view, setView] = React.useState<ViewMode>("kalender")
  const [draggingId, setDraggingId] = React.useState<string | null>(null)
  const [dragOverCol, setDragOverCol] = React.useState<string | null>(null)
  const [captureFor, setCaptureFor] = React.useState<ResourceBoardRow | null>(null)

  React.useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)

      const [boardRes, statusRes, profileRes] = await Promise.all([
        // resource_board isn't in the generated Database type yet (same as
        // task_board / engagement_board), so the name is cast and the rows are
        // typed on the way out.
        supabase.rpc("resource_board" as never, { p_year: year, p_month: month } as never),
        supabase.from("resource_statuses").select("*").order("sort_order"),
        supabase
          .from("profiles")
          .select("id, full_name")
          .eq("is_active", true)
          .order("full_name"),
      ])

      if (cancelled) return

      if (boardRes.error) {
        toast.error(t("belaggning.toast.loadFailed", "Could not load the board"))
        setRows([])
      } else {
        setRows((boardRes.data ?? []) as ResourceBoardRow[])
      }

      setStatuses((statusRes.data ?? []) as ResourceStatus[])
      setConsultants(
        ((profileRes.data ?? []) as Array<{ id: string; full_name: string | null }>).map(
          (p) => ({ id: p.id, name: p.full_name ?? "—" }),
        ),
      )
      setLoading(false)
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [supabase, year, month, t])

  const managers = React.useMemo(() => {
    const seen = new Map<string, string>()
    for (const row of rows) {
      if (row.kundansvarig_id && row.kundansvarig_name) {
        seen.set(row.kundansvarig_id, row.kundansvarig_name)
      }
    }
    return Array.from(seen, ([id, name]) => ({ id, name })).sort((a, b) =>
      a.name.localeCompare(b.name, "sv"),
    )
  }, [rows])

  const visibleRows = React.useMemo(
    () =>
      filterManager === ALL
        ? rows
        : rows.filter((row) => row.kundansvarig_id === filterManager),
    [rows, filterManager],
  )

  /**
   * Columns are the utförare — who will do the work — because that is the axis
   * capacity lives on. Filtering by kundansvarig above narrows which customers
   * are in play without changing what a column means.
   */
  const columns = React.useMemo(() => {
    const byAssignee = new Map<string, ResourceBoardRow[]>()
    for (const row of visibleRows) {
      const key = row.assignee_id ?? UNASSIGNED
      const list = byAssignee.get(key) ?? []
      list.push(row)
      byAssignee.set(key, list)
    }

    const named = Array.from(byAssignee.entries())
      .filter(([key]) => key !== UNASSIGNED)
      .map(([id, list]) => ({
        id,
        name: list[0]?.assignee_name ?? "—",
        rows: list,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, "sv"))

    // Unassigned always sits first: it is the queue the month starts as, and
    // emptying it is the job.
    return [
      {
        id: UNASSIGNED,
        name: t("belaggning.column.unassigned", "Not assigned"),
        rows: byAssignee.get(UNASSIGNED) ?? [],
      },
      ...named,
    ]
  }, [visibleRows, t])

  function shiftMonth(delta: number) {
    const next = new Date(year, month - 1 + delta, 1)
    setYear(next.getFullYear())
    setMonth(next.getMonth() + 1)
  }

  async function assign(row: ResourceBoardRow, assigneeId: string | null) {
    if (row.assignee_id === assigneeId) return

    const previous = rows
    const assigneeName =
      assigneeId === null
        ? null
        : (consultants.find((c) => c.id === assigneeId)?.name ?? null)

    setRows((current) =>
      current.map((r) =>
        r.customer_id === row.customer_id
          ? { ...r, assignee_id: assigneeId, assignee_name: assigneeName }
          : r,
      ),
    )

    const planned = statuses.find((s) => s.key === "planerad")
    const { error } = await supabase.from("resource_plan").upsert(
      {
        customer_id: row.customer_id,
        period_year: year,
        period_month: month,
        assignee_id: assigneeId,
        // Assigning is the act of planning, so the card leaves "Ej planerad"
        // on its own rather than requiring a second gesture.
        status_id: row.status_id ?? planned?.id ?? null,
      } as never,
      { onConflict: "customer_id,period_year,period_month" },
    )

    if (error) {
      setRows(previous)
      toast.error(t("belaggning.toast.assignFailed", "Could not assign"))
    }
  }

  const totalPlanned = visibleRows.reduce((sum, r) => sum + Number(r.effective_hours ?? 0), 0)
  const unconfirmed = visibleRows.filter((r) => r.recurring_confirmed === 0).length

  /**
   * How many people the weekly capacity line is measured against. Once work is
   * assigned this is simply the utförare in view. Before anything is assigned
   * there are none — so a single-manager filter measures against that one
   * person (their own month), and the unfiltered view against every
   * kundansvarig present, which is the closest honest stand-in until planned
   * absence and FTE exist as data.
   */
  const peopleInView = React.useMemo(() => {
    const assignees = new Set(
      visibleRows.map((r) => r.assignee_id).filter((id): id is string => Boolean(id)),
    )
    if (assignees.size > 0) return assignees.size
    if (filterManager !== ALL) return 1
    return Math.max(
      new Set(
        visibleRows.map((r) => r.kundansvarig_id).filter((id): id is string => Boolean(id)),
      ).size,
      1,
    )
  }, [visibleRows, filterManager])

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("belaggning.title", "Beläggning")}
        description={t(
          "belaggning.description",
          "Estimated workload per customer and month, based on reported time.",
        )}
      >
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => shiftMonth(-1)}
            aria-label={t("belaggning.prevMonth", "Previous month")}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <span className="min-w-[9rem] text-center text-sm font-medium capitalize">
            {monthLabel(year, month, language)}
          </span>
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => shiftMonth(1)}
            aria-label={t("belaggning.nextMonth", "Next month")}
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
        <ManagerFilter
          value={filterManager}
          onChange={setFilterManager}
          options={managers}
          allLabel={t("belaggning.filter.allManagers", "All customer managers")}
          searchPlaceholder={t("belaggning.filter.searchManager", "Search manager")}
        />
        <div className="flex items-center gap-1 rounded-md border p-0.5">
          <Button
            variant={view === "kalender" ? "secondary" : "ghost"}
            size="xs"
            className="h-7 gap-1 px-2"
            onClick={() => setView("kalender")}
          >
            <CalendarDays className="size-3.5" />
            {t("belaggning.view.calendar", "Calendar")}
          </Button>
          <Button
            variant={view === "tavla" ? "secondary" : "ghost"}
            size="xs"
            className="h-7 gap-1 px-2"
            onClick={() => setView("tavla")}
          >
            <Columns3 className="size-3.5" />
            {t("belaggning.view.board", "Board")}
          </Button>
        </div>
      </PageHeader>

      <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
        <span>
          {t("belaggning.summary.customers", "Customers")}: {visibleRows.length}
        </span>
        <span>
          {t("belaggning.summary.planned", "Planned")}:{" "}
          {hourFormatter.format(totalPlanned)} h
        </span>
        {unconfirmed > 0 ? (
          <Badge variant="outline" className="gap-1 font-normal">
            <Sparkles className="size-3" />
            {t("belaggning.summary.unconfirmed", "Unconfirmed recurring work")}: {unconfirmed}
          </Badge>
        ) : null}
      </div>

      {loading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-64 w-full" />
          ))}
        </div>
      ) : view === "kalender" ? (
        <div className="space-y-4">
          <BelaggningCalendar
            rows={visibleRows}
            year={year}
            month={month}
            weeklyCapacityHours={(peopleInView * MONTHLY_CAPACITY_HOURS) / WEEKS_PER_MONTH}
            onSelect={setCaptureFor}
          />

          <div>
            <h2 className="mb-2 text-sm font-medium">
              {t("belaggning.calendar.customers", "Customers this month")}
            </h2>
            {/* A dense grid rather than one tall column: 19 customers in a
                single strip was a list, not a plan. */}
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {visibleRows
                .slice()
                .sort((a, b) => Number(b.effective_hours ?? 0) - Number(a.effective_hours ?? 0))
                .map((row) => (
                  <CompactRow
                    key={row.customer_id}
                    row={row}
                    onCapture={() => setCaptureFor(row)}
                  />
                ))}
            </div>
            {visibleRows.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                {t("belaggning.calendar.noCustomers", "No customers in this view")}
              </p>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-4">
          {columns.map((column) => {
            const planned = column.rows.reduce(
              (sum, r) => sum + Number(r.effective_hours ?? 0),
              0,
            )
            const load = planned / MONTHLY_CAPACITY_HOURS
            const isQueue = column.id === UNASSIGNED

            return (
              <div
                key={column.id}
                onDragOver={(event) => {
                  event.preventDefault()
                  setDragOverCol(column.id)
                }}
                onDragLeave={() => setDragOverCol((c) => (c === column.id ? null : c))}
                onDrop={(event) => {
                  event.preventDefault()
                  setDragOverCol(null)
                  const row = rows.find((r) => r.customer_id === draggingId)
                  if (row) void assign(row, isQueue ? null : column.id)
                  setDraggingId(null)
                }}
                className={cn(
                  "flex w-72 shrink-0 flex-col gap-2 rounded-lg border p-2 transition-colors",
                  dragOverCol === column.id ? "border-brand-primary bg-muted/40" : "border-border",
                )}
              >
                <div className="space-y-1 px-1 pt-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-medium">{column.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {column.rows.length}
                    </span>
                  </div>

                  {isQueue ? (
                    <p className="text-xs text-muted-foreground">
                      {hourFormatter.format(planned)} h
                    </p>
                  ) : (
                    <>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className={cn(
                            "h-full rounded-full transition-all",
                            load > 1
                              ? "bg-semantic-error"
                              : load > 0.85
                                ? "bg-semantic-warning"
                                : "bg-semantic-success",
                          )}
                          style={{ width: `${Math.min(load * 100, 100)}%` }}
                        />
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {hourFormatter.format(planned)} / {MONTHLY_CAPACITY_HOURS} h
                        {load > 1
                          ? ` · ${t("belaggning.column.over", "over capacity")}`
                          : ""}
                      </p>
                    </>
                  )}
                </div>

                <div className="flex flex-col gap-2">
                  {column.rows.map((row) => (
                    <BoardCard
                      key={row.customer_id}
                      row={row}
                      onDragStart={() => setDraggingId(row.customer_id)}
                      onDragEnd={() => setDraggingId(null)}
                      onCapture={() => setCaptureFor(row)}
                    />
                  ))}
                  {column.rows.length === 0 ? (
                    <p className="px-1 py-6 text-center text-xs text-muted-foreground">
                      {t("belaggning.column.empty", "Nothing here")}
                    </p>
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <RecurringWorkSheet
        customerId={captureFor?.customer_id ?? null}
        customerName={captureFor?.customer_name ?? ""}
        open={captureFor !== null}
        onOpenChange={(open) => {
          if (!open) setCaptureFor(null)
        }}
        onConfirmed={(count) => {
          setRows((current) =>
            current.map((r) =>
              r.customer_id === captureFor?.customer_id
                ? { ...r, recurring_confirmed: count, recurring_total: Math.max(r.recurring_total, count) }
                : r,
            ),
          )
        }}
      />
    </div>
  )
}

/**
 * One customer as a single dense line: name, hours, and only the badges that
 * demand an action. Used by the calendar view, where the point is scanning
 * twenty customers at once rather than reading any one of them.
 */
function CompactRow({
  row,
  onCapture,
}: {
  row: ResourceBoardRow
  onCapture: () => void
}) {
  const { t } = useTranslation()
  const hours = Number(row.effective_hours ?? 0)

  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{row.customer_name}</p>
        <p className="truncate text-xs text-muted-foreground">
          {row.assignee_name ?? row.kundansvarig_name ?? "—"}
        </p>
      </div>

      {row.event_label ? (
        <span title={`${row.event_label}${row.event_due_date ? ` · ${row.event_due_date}` : ""}`}>
          <Lock className="size-3.5 shrink-0 text-semantic-warning" />
        </span>
      ) : null}

      {row.recurring_confirmed === 0 ? (
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onCapture}
          title={t("belaggning.card.confirmWork", "Confirm recurring work")}
        >
          <CircleAlert className="size-3.5 text-semantic-warning" />
        </Button>
      ) : (
        <ShieldCheck className="size-3.5 shrink-0 text-semantic-success" />
      )}

      <span className="w-12 shrink-0 text-right text-sm font-semibold tabular-nums">
        {hours >= MIN_HOURS_FOR_ESTIMATE ? `${hourFormatter.format(hours)} h` : "–"}
      </span>
    </div>
  )
}

function BoardCard({
  row,
  onDragStart,
  onDragEnd,
  onCapture,
}: {
  row: ResourceBoardRow
  onDragStart: () => void
  onDragEnd: () => void
  onCapture: () => void
}) {
  const { t } = useTranslation()

  const hours = Number(row.effective_hours ?? 0)
  const showHours = hours >= MIN_HOURS_FOR_ESTIMATE

  // Planerat vs avtalat is the comparison this board is really for — a customer
  // drifting past the agreed scope, caught before the month starts rather than
  // at fakturan. It needs planned hours × pris against the avtalade avgiften,
  // and the pricing parsers that turn fixed_monthly_price into an hours
  // equivalent don't exist yet. Until they do the card shows the agreed fee
  // alone; the comparison lands with the parsers.
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      data-card-id={row.customer_id}
      className="cursor-grab rounded-md border border-border bg-card p-3 shadow-sm transition-shadow hover:shadow-md active:cursor-grabbing"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="line-clamp-2 text-sm font-medium">{row.customer_name}</p>
        {showHours ? (
          <span className="shrink-0 text-sm font-semibold tabular-nums">
            {hourFormatter.format(hours)} h
          </span>
        ) : (
          <span
            className="shrink-0 text-sm text-muted-foreground"
            title={t(
              "belaggning.card.tooSmall",
              "Too few hours for a meaningful estimate",
            )}
          >
            –
          </span>
        )}
      </div>

      {row.kundansvarig_name ? (
        <p className="mt-0.5 text-xs text-muted-foreground">{row.kundansvarig_name}</p>
      ) : null}

      {row.event_label ? (
        <div className="mt-2 flex items-center gap-1.5 rounded-sm bg-muted/60 px-2 py-1">
          {row.event_hardness === "lagstadgad" ? (
            <Lock className="size-3 shrink-0 text-semantic-warning" />
          ) : (
            <CalendarClock className="size-3 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate text-xs">{row.event_label}</span>
          {row.event_due_date ? (
            <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
              {row.event_due_date.slice(5)}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="mt-2 flex items-center justify-between gap-2">
        {row.recurring_confirmed > 0 ? (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <ShieldCheck className="size-3 text-semantic-success" />
            {row.recurring_confirmed} {t("belaggning.card.confirmed", "confirmed")}
          </span>
        ) : (
          <Button
            variant="ghost"
            size="xs"
            className="h-6 gap-1 px-1.5 text-xs"
            onClick={onCapture}
          >
            <CircleAlert className="size-3 text-semantic-warning" />
            {t("belaggning.card.confirmWork", "Confirm recurring work")}
          </Button>
        )}

        {row.fixed_monthly_price ? (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {sekFormatter.format(Number(row.fixed_monthly_price))} kr
          </span>
        ) : null}
      </div>
    </div>
  )
}
