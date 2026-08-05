"use client"

import * as React from "react"
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Columns3,
  ListChecks,
  Lock,
  Plane,
  ShieldCheck,
} from "lucide-react"
import { toast } from "sonner"

import { createClient } from "@/lib/supabase/client"
import { cn } from "@/lib/utils"
import { useTranslation } from "@/hooks/use-translation"
import type {
  Absence,
  ResourceAssessmentReason,
  ResourceBoardRow,
  ResourceCapacityRow,
  ResourceMonthEvent,
  ResourceStatus,
  SwedishHoliday,
} from "@/types/resource"
import { PageHeader } from "@/components/app/page-header"
import { ManagerFilter } from "@/components/app/engagement-filters"
import { CapacityBar } from "@/components/app/capacity-bar"
import {
  BelaggningCalendar,
  type CalendarAbsence,
  type CalendarEvent,
} from "@/components/app/belaggning-calendar"
import { AbsenceSheet } from "@/components/app/absence-sheet"
import {
  RecurringWorkSheet,
  type ConfirmQueueItem,
} from "@/components/app/recurring-work-sheet"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"

const ALL = "all"
const UNASSIGNED = "unassigned"

type Consultant = { id: string; name: string }
type ViewMode = "kalender" | "tavla"
type AbsenceWithName = Absence & { profile_name: string | null }

function monthLabel(year: number, month: number, locale: string) {
  return new Intl.DateTimeFormat(locale === "sv" ? "sv-SE" : "en-GB", {
    month: "long",
    year: "numeric",
  }).format(new Date(year, month - 1, 1))
}

function isoDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

const hourFormatter = new Intl.NumberFormat("sv-SE", { maximumFractionDigits: 1 })
const sekFormatter = new Intl.NumberFormat("sv-SE", { maximumFractionDigits: 0 })

/**
 * Hours are only shown as a number when the customer is big enough for the
 * estimate to mean anything. Below this the measured error is ~73%, so a point
 * estimate reads as precision that isn't there — those cards carry their reason
 * instead, and the column total still carries the hours.
 */
const MIN_HOURS_FOR_ESTIMATE = 2

export function BelaggningBoard() {
  const { t, language } = useTranslation()
  const supabase = React.useMemo(() => createClient(), [])
  const locale = language === "sv" ? "sv-SE" : "en-GB"

  const now = new Date()
  const [year, setYear] = React.useState(now.getFullYear())
  const [month, setMonth] = React.useState(now.getMonth() + 1)

  const [loading, setLoading] = React.useState(true)
  const [rows, setRows] = React.useState<ResourceBoardRow[]>([])
  const [statuses, setStatuses] = React.useState<ResourceStatus[]>([])
  const [consultants, setConsultants] = React.useState<Consultant[]>([])
  const [capacity, setCapacity] = React.useState<ResourceCapacityRow[]>([])
  const [events, setEvents] = React.useState<ResourceMonthEvent[]>([])
  const [absences, setAbsences] = React.useState<AbsenceWithName[]>([])
  const [holidays, setHolidays] = React.useState<SwedishHoliday[]>([])

  const [filterManager, setFilterManager] = React.useState<string>(ALL)
  const [view, setView] = React.useState<ViewMode>("kalender")
  const [draggingId, setDraggingId] = React.useState<string | null>(null)
  const [dragOverCol, setDragOverCol] = React.useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = React.useState(false)
  const [confirmStart, setConfirmStart] = React.useState(0)
  const [confirmTarget, setConfirmTarget] = React.useState<ConfirmQueueItem[]>([])
  const [absenceOpen, setAbsenceOpen] = React.useState(false)
  const [reloadKey, setReloadKey] = React.useState(0)

  const monthStart = React.useMemo(() => isoDate(new Date(year, month - 1, 1)), [year, month])
  const monthEnd = React.useMemo(() => isoDate(new Date(year, month, 0)), [year, month])

  React.useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)

      const [boardRes, statusRes, profileRes, capacityRes, eventRes, absenceRes, holidayRes] =
        await Promise.all([
          // The resource_* functions aren't in the generated Database type yet
          // (same as task_board / engagement_board), so the names are cast and
          // the rows are typed on the way out.
          supabase.rpc("resource_board" as never, { p_year: year, p_month: month } as never),
          supabase.from("resource_statuses").select("*").order("sort_order"),
          supabase
            .from("profiles")
            .select("id, full_name")
            .eq("is_active", true)
            .order("full_name"),
          supabase.rpc("resource_capacity" as never, {
            p_year: year,
            p_month: month,
          } as never),
          supabase.rpc("resource_month_events" as never, {
            p_year: year,
            p_month: month,
          } as never),
          supabase
            .from("absences")
            .select("*, profiles!absences_profile_id_fkey(full_name)")
            .lte("start_date", monthEnd)
            .gte("end_date", monthStart)
            .order("start_date"),
          supabase
            .from("swedish_holidays")
            .select("*")
            .gte("date", monthStart)
            .lte("date", monthEnd),
        ])

      if (cancelled) return

      if (boardRes.error) {
        toast.error(t("belaggning.toast.loadFailed", "Could not load the board"))
        setRows([])
      } else {
        // Normalised on the way in. resource_board grows columns migration by
        // migration, and an absent field must read as "nothing to say" rather
        // than as undefined — undefined !== null put every card in "Behöver
        // bedömning" the first time this shipped ahead of its migration.
        setRows(
          ((boardRes.data ?? []) as ResourceBoardRow[]).map((row) => ({
            ...row,
            assessment_reason: row.assessment_reason ?? null,
            top_activities: row.top_activities ?? [],
            history_months: row.history_months ?? 0,
          })),
        )
      }

      setStatuses((statusRes.data ?? []) as ResourceStatus[])
      setConsultants(
        ((profileRes.data ?? []) as Array<{ id: string; full_name: string | null }>).map((p) => ({
          id: p.id,
          name: p.full_name ?? "—",
        })),
      )
      setCapacity((capacityRes.data ?? []) as ResourceCapacityRow[])
      setEvents((eventRes.data ?? []) as ResourceMonthEvent[])
      setAbsences(
        (
          (absenceRes.data ?? []) as Array<
            Absence & { profiles: { full_name: string | null } | null }
          >
        ).map((row) => ({ ...row, profile_name: row.profiles?.full_name ?? null })),
      )
      setHolidays((holidayRes.data ?? []) as SwedishHoliday[])
      setLoading(false)
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [supabase, year, month, monthStart, monthEnd, reloadKey, t])

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

  const capacityById = React.useMemo(() => {
    const map = new Map<string, ResourceCapacityRow>()
    for (const row of capacity) map.set(row.profile_id, row)
    return map
  }, [capacity])

  /**
   * Whose capacity the header measures against. Filtering by kundansvarig means
   * "this person's month", so it measures against them alone. Unfiltered, it is
   * everyone the visible work touches — assignees where work is already
   * distributed, kundansvariga before it is.
   */
  const peopleInView = React.useMemo(() => {
    if (filterManager !== ALL) return [filterManager]
    const ids = new Set<string>()
    for (const row of visibleRows) {
      if (row.assignee_id) ids.add(row.assignee_id)
      else if (row.kundansvarig_id) ids.add(row.kundansvarig_id)
    }
    return Array.from(ids)
  }, [visibleRows, filterManager])

  const availableHours = React.useMemo(
    () =>
      peopleInView.reduce(
        (sum, id) => sum + Number(capacityById.get(id)?.available_hours ?? 0),
        0,
      ),
    [peopleInView, capacityById],
  )

  const totalPlanned = visibleRows.reduce((sum, r) => sum + Number(r.effective_hours ?? 0), 0)

  /**
   * How a capacity number was arrived at, in words. Available hours are three
   * multiplications and a subtraction; showing only the product asks the user
   * to trust it, and the first thing anyone does with a number they cannot
   * derive is stop believing it.
   */
  const describeCapacity = React.useCallback(
    (people: ResourceCapacityRow[]) => {
      if (people.length === 0) return undefined
      const absenceDays = people.reduce((sum, p) => sum + Number(p.absence_days ?? 0), 0)
      const absence =
        absenceDays > 0
          ? t("belaggning.capacity.detailAbsence", " − {days} days of absence").replace(
              "{days}",
              String(absenceDays),
            )
          : ""

      if (people.length === 1) {
        const person = people[0]
        return (
          t(
            "belaggning.capacity.detailOne",
            "{workdays} workdays × {hours} h × {target} % billable",
          )
            .replace("{workdays}", String(person.workdays))
            .replace("{hours}", hourFormatter.format(Number(person.weekly_hours) / 5))
            .replace("{target}", String(Math.round(Number(person.billable_target) * 100))) +
          absence
        )
      }

      return (
        t("belaggning.capacity.detailMany", "{people} people × {workdays} workdays")
          .replace("{people}", String(people.length))
          .replace("{workdays}", String(people[0].workdays)) + absence
      )
    },
    [t],
  )

  const headerCapacityDetail = React.useMemo(
    () =>
      describeCapacity(
        peopleInView
          .map((id) => capacityById.get(id))
          .filter((row): row is ResourceCapacityRow => row !== undefined),
      ),
    [describeCapacity, peopleInView, capacityById],
  )

  const visibleCustomerIds = React.useMemo(
    () => new Set(visibleRows.map((row) => row.customer_id)),
    [visibleRows],
  )

  const calendarEvents = React.useMemo<CalendarEvent[]>(() => {
    const nameById = new Map(rows.map((row) => [row.customer_id, row.customer_name]))
    return events
      .filter((event) => visibleCustomerIds.has(event.customer_id))
      .map((event) => ({
        ...event,
        customer_name: nameById.get(event.customer_id) ?? "—",
      }))
  }, [events, rows, visibleCustomerIds])

  const visibleAbsences = React.useMemo<CalendarAbsence[]>(() => {
    const inView = new Set(peopleInView)
    return absences
      .filter((absence) => inView.size === 0 || inView.has(absence.profile_id))
      .map((absence) => ({
        profile_id: absence.profile_id,
        profile_name: absence.profile_name,
        start_date: absence.start_date,
        end_date: absence.end_date,
        type: absence.type,
      }))
  }, [absences, peopleInView])

  /** The queue the bekräfta-button works through, in the order it is shown. */
  const confirmQueue = React.useMemo<ConfirmQueueItem[]>(
    () =>
      visibleRows
        .filter((row) => row.recurring_confirmed === 0)
        .sort((a, b) => Number(b.effective_hours ?? 0) - Number(a.effective_hours ?? 0))
        .map((row) => ({ customer_id: row.customer_id, customer_name: row.customer_name })),
    [visibleRows],
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

  /**
   * Three groups, always in this order, because that is the order the questions
   * get asked in: what needs a decision, what has a date, and then the rest.
   * A customer belongs to exactly one — the first it qualifies for.
   */
  const groups = React.useMemo(() => {
    const sorted = visibleRows
      .slice()
      .sort((a, b) => Number(b.effective_hours ?? 0) - Number(a.effective_hours ?? 0))

    const needsAssessment = sorted.filter((row) => row.assessment_reason !== null)
    const rest = sorted.filter((row) => row.assessment_reason === null)

    return {
      needsAssessment,
      withDeadline: rest.filter((row) => row.event_due_date !== null),
      lopande: rest.filter((row) => row.event_due_date === null),
    }
  }, [visibleRows])

  /**
   * The one sentence the header exists for. Whose month it is matters — a name
   * makes it a statement about a person, and a person is who has to act on it.
   */
  const verdict = React.useMemo(() => {
    if (availableHours <= 0) return null

    const remaining = availableHours - totalPlanned
    const subject =
      peopleInView.length === 1
        ? (capacityById.get(peopleInView[0])?.profile_name ??
          managers.find((m) => m.id === peopleInView[0])?.name ??
          t("belaggning.verdict.team", "The team"))
        : t("belaggning.verdict.team", "The team")

    const template =
      remaining >= 0
        ? t("belaggning.verdict.free", "{who} has {hours} h free in {month}")
        : t("belaggning.verdict.over", "{who} is {hours} h over in {month}")

    return {
      over: remaining < 0,
      text: template
        .replace("{who}", subject)
        .replace("{hours}", hourFormatter.format(Math.abs(remaining)))
        .replace("{month}", monthLabel(year, month, language).replace(/\s\d{4}$/, "")),
    }
  }, [
    availableHours,
    totalPlanned,
    peopleInView,
    capacityById,
    managers,
    year,
    month,
    language,
    t,
  ])

  function shiftMonth(delta: number) {
    const next = new Date(year, month - 1 + delta, 1)
    setYear(next.getFullYear())
    setMonth(next.getMonth() + 1)
  }

  /**
   * Opening from the header walks the whole queue; opening from one card walks
   * from that card — and a customer that is already confirmed opens on its own,
   * rather than silently sending you to somebody else's card.
   */
  function openConfirm(customerId?: string) {
    if (!customerId) {
      setConfirmTarget(confirmQueue)
      setConfirmStart(0)
      setConfirmOpen(true)
      return
    }

    const index = confirmQueue.findIndex((item) => item.customer_id === customerId)
    if (index >= 0) {
      setConfirmTarget(confirmQueue)
      setConfirmStart(index)
    } else {
      const row = rows.find((r) => r.customer_id === customerId)
      if (!row) return
      setConfirmTarget([{ customer_id: row.customer_id, customer_name: row.customer_name }])
      setConfirmStart(0)
    }
    setConfirmOpen(true)
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

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("belaggning.title", "Beläggning")}
        description={t(
          "belaggning.description",
          "Planned workload against available hours, per customer and month.",
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

      <div className="flex flex-wrap items-end justify-between gap-4">
        {/* The sentence is the answer; the bar underneath is the evidence for
            it. A row of statistics made the reader do this arithmetic. */}
        <div className="min-w-[18rem] flex-1 space-y-1.5">
          {verdict ? (
            <p
              className={cn(
                "text-base font-medium",
                verdict.over ? "text-semantic-error" : "text-semantic-success",
              )}
            >
              {verdict.text}
            </p>
          ) : null}
          <CapacityBar
            plannedHours={totalPlanned}
            availableHours={availableHours}
            detail={headerCapacityDetail}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {confirmQueue.length > 0 ? (
            <Button size="sm" className="gap-2" onClick={() => openConfirm()}>
              <ListChecks className="size-4" />
              {t("belaggning.confirm.action", "Confirm recurring work")} (
              {confirmQueue.length})
            </Button>
          ) : (
            <Badge variant="outline" className="gap-1 font-normal">
              <ShieldCheck className="size-3 text-semantic-success" />
              {t("belaggning.confirm.allDone", "All recurring work confirmed")}
            </Badge>
          )}

          <Button variant="outline" size="sm" className="gap-2" onClick={() => setAbsenceOpen(true)}>
            <Plane className="size-4" />
            {t("belaggning.absence.action", "Absence")}
            {visibleAbsences.length > 0 ? ` (${visibleAbsences.length})` : ""}
          </Button>
        </div>
      </div>

      {visibleAbsences.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {visibleAbsences.map((absence) => (
            <Badge
              key={`${absence.profile_id}-${absence.start_date}`}
              variant="outline"
              className="gap-1 font-normal"
            >
              <Plane className="size-3 text-semantic-info" />
              {absence.profile_name ?? "—"}
              <span className="text-muted-foreground tabular-nums">
                {absence.start_date.slice(5)} – {absence.end_date.slice(5)}
              </span>
            </Badge>
          ))}
        </div>
      ) : null}

      {loading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-64 w-full" />
          ))}
        </div>
      ) : view === "kalender" ? (
        <div className="space-y-4">
          {/* No derivable dates, no calendar. Not a collapsed one, not a
              toggle, not a caption explaining the absence — an empty grid was
              the thing being explained away. */}
          {calendarEvents.length > 0 ? (
            <BelaggningCalendar
              year={year}
              month={month}
              events={calendarEvents}
              holidays={holidays}
              absences={visibleAbsences}
              onSelect={(customerId) => openConfirm(customerId)}
            />
          ) : null}

          {/* A heading with nothing under it is a bug report, not a section. */}
          <CardGroup
            title={t("belaggning.group.needsAssessment", "Needs a decision")}
            rows={groups.needsAssessment}
            locale={locale}
            onCapture={openConfirm}
          />

          <CardGroup
            title={t("belaggning.group.deadline", "Has a deadline in {month}").replace(
              "{month}",
              monthLabel(year, month, language).replace(/\s\d{4}$/, ""),
            )}
            rows={groups.withDeadline}
            locale={locale}
            onCapture={openConfirm}
          />

          <CardGroup
            title={t("belaggning.group.lopande", "Running work")}
            rows={groups.lopande}
            locale={locale}
            onCapture={openConfirm}
          />

          {visibleRows.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {t("belaggning.calendar.noCustomers", "No customers in this view")}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-4">
          {columns.map((column) => {
            const planned = column.rows.reduce(
              (sum, r) => sum + Number(r.effective_hours ?? 0),
              0,
            )
            const isQueue = column.id === UNASSIGNED
            const columnCapacity = isQueue
              ? 0
              : Number(capacityById.get(column.id)?.available_hours ?? 0)
            const columnAbsence = isQueue
              ? 0
              : Number(capacityById.get(column.id)?.absence_days ?? 0)

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
                    <p className="text-xs text-muted-foreground tabular-nums">
                      {hourFormatter.format(planned)} h
                    </p>
                  ) : (
                    <>
                      <CapacityBar
                        plannedHours={planned}
                        availableHours={columnCapacity}
                        detail={describeCapacity(
                          [capacityById.get(column.id)].filter(
                            (row): row is ResourceCapacityRow => row !== undefined,
                          ),
                        )}
                        compact
                      />
                      {columnAbsence > 0 ? (
                        <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                          <Plane className="size-3 text-semantic-info" />
                          {t("belaggning.column.absenceDays", "{days} days away").replace(
                            "{days}",
                            String(columnAbsence),
                          )}
                        </p>
                      ) : null}
                    </>
                  )}
                </div>

                <div className="flex flex-col gap-2">
                  {column.rows.map((row) => (
                    <BoardCard
                      key={row.customer_id}
                      row={row}
                      locale={locale}
                      onDragStart={() => setDraggingId(row.customer_id)}
                      onDragEnd={() => setDraggingId(null)}
                      onCapture={() => openConfirm(row.customer_id)}
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
        queue={confirmTarget}
        startIndex={confirmStart}
        open={confirmOpen}
        onOpenChange={(open) => {
          setConfirmOpen(open)
          // Confirming can set momsperiod and lönedag, and those are what the
          // calendar draws its anchors from — so the board reloads rather than
          // showing an empty grid the capture just fixed.
          if (!open) setReloadKey((key) => key + 1)
        }}
        onConfirmed={(customerId, count) => {
          setRows((current) =>
            current.map((r) =>
              r.customer_id === customerId
                ? {
                    ...r,
                    recurring_confirmed: count,
                    recurring_total: Math.max(r.recurring_total, count),
                  }
                : r,
            ),
          )
        }}
      />

      <AbsenceSheet
        open={absenceOpen}
        onOpenChange={setAbsenceOpen}
        people={consultants}
        year={year}
        month={month}
        onChanged={() => setReloadKey((key) => key + 1)}
      />
    </div>
  )
}

/**
 * One titled group of cards, or nothing at all. The count belongs in the
 * heading — it is the first thing anyone reads to decide whether to look.
 */
function CardGroup({
  title,
  rows,
  locale,
  onCapture,
}: {
  title: string
  rows: ResourceBoardRow[]
  locale: string
  onCapture: (customerId: string) => void
}) {
  if (rows.length === 0) return null

  return (
    <div>
      <h2 className="mb-2 text-sm font-medium">
        {title} <span className="text-muted-foreground">({rows.length})</span>
      </h2>
      {/* A dense grid rather than one tall column: 19 customers in a single
          strip was a list, not a plan. */}
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {rows.map((row) => (
          <CompactRow
            key={row.customer_id}
            row={row}
            locale={locale}
            onCapture={() => onCapture(row.customer_id)}
          />
        ))}
      </div>
    </div>
  )
}

/** `Lagstadgad 12 aug` in red, `Intern 31 mar` in neutral — the difference that
 *  makes an overloaded month resolvable, because the soft work is what moves. */
function DeadlineChip({
  row,
  locale,
  className,
}: {
  row: ResourceBoardRow
  locale: string
  className?: string
}) {
  const { t } = useTranslation()
  if (!row.event_due_date) return null

  const hard = row.event_hardness === "lagstadgad"
  const date = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(
    new Date(`${row.event_due_date}T00:00:00`),
  )

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px]",
        hard
          ? "bg-semantic-error/10 text-semantic-error"
          : "bg-muted text-muted-foreground",
        className,
      )}
      title={row.event_label ?? undefined}
    >
      {hard ? <Lock className="size-2.5 shrink-0" /> : null}
      {hard
        ? t("belaggning.hardness.lagstadgad", "Statutory")
        : t("belaggning.hardness.intern", "Internal")}{" "}
      {date}
    </span>
  )
}

function useAssessmentLabel(reason: ResourceAssessmentReason | null) {
  const { t } = useTranslation()
  if (reason === null) return null
  const labels: Record<ResourceAssessmentReason, string> = {
    ny_kund: t("belaggning.reason.nyKund", "New customer — no history"),
    vilande: t("belaggning.reason.vilande", "Dormant — no hours in 3 months"),
    ingen_historik: t("belaggning.reason.ingenHistorik", "No history"),
    for_lite_historik: t("belaggning.reason.forLite", "Too few hours to estimate"),
  }
  return labels[reason]
}

/**
 * One customer as a single dense line: what needs doing, when it is due, and
 * how much. The kundansvarig's name is deliberately gone — the view is already
 * filtered by person, so repeating it twenty times was pure noise.
 */
function CompactRow({
  row,
  locale,
  onCapture,
}: {
  row: ResourceBoardRow
  locale: string
  onCapture: () => void
}) {
  const hours = Number(row.effective_hours ?? 0)
  const reasonLabel = useAssessmentLabel(row.assessment_reason)
  const activities = row.top_activities

  return (
    <button
      type="button"
      onClick={onCapture}
      className="flex w-full items-center gap-2 rounded-md border border-border bg-card px-2.5 py-2 text-left transition-colors hover:bg-muted/40"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{row.customer_name}</p>
        <p className="truncate text-xs text-muted-foreground">
          {reasonLabel ?? activities.join(" · ")}
        </p>
      </div>

      <DeadlineChip row={row} locale={locale} />

      <span className="w-12 shrink-0 text-right text-sm font-semibold tabular-nums">
        {hours >= MIN_HOURS_FOR_ESTIMATE ? `${hourFormatter.format(hours)} h` : "–"}
      </span>
    </button>
  )
}

function BoardCard({
  row,
  locale,
  onDragStart,
  onDragEnd,
  onCapture,
}: {
  row: ResourceBoardRow
  locale: string
  onDragStart: () => void
  onDragEnd: () => void
  onCapture: () => void
}) {
  const { t } = useTranslation()

  const hours = Number(row.effective_hours ?? 0)
  const showHours = hours >= MIN_HOURS_FOR_ESTIMATE
  const reasonLabel = useAssessmentLabel(row.assessment_reason)
  const activities = row.top_activities

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
      className={cn(
        "cursor-grab rounded-md border bg-card p-3 shadow-sm transition-shadow hover:shadow-md active:cursor-grabbing",
        // Unconfirmed work is drawn as a draft rather than flagged with an icon
        // on every card — a warning that fires twenty times out of twenty is
        // not a warning.
        row.recurring_confirmed === 0 ? "border-dashed border-border" : "border-border",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="line-clamp-2 text-sm font-medium">{row.customer_name}</p>
        {showHours ? (
          <span className="shrink-0 text-sm font-semibold tabular-nums">
            {hourFormatter.format(hours)} h
          </span>
        ) : (
          <span className="shrink-0 text-sm text-muted-foreground">–</span>
        )}
      </div>

      {reasonLabel ? (
        <p className="mt-0.5 text-xs text-semantic-warning">{reasonLabel}</p>
      ) : activities.length > 0 ? (
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {activities.join(" · ")}
        </p>
      ) : null}

      {row.event_due_date ? (
        <div className="mt-2 flex items-center gap-1.5">
          <DeadlineChip row={row} locale={locale} />
          <span className="truncate text-xs text-muted-foreground">{row.event_label}</span>
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
            <ListChecks className="size-3" />
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
