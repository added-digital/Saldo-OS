"use client"

import * as React from "react"
import { CalendarDays, ChevronDown, ChevronUp, Lock, Plane } from "lucide-react"

import { cn } from "@/lib/utils"
import { useTranslation } from "@/hooks/use-translation"
import { loadTone, type ResourceEventKind, type ResourceMonthEvent } from "@/types/resource"
import { Button } from "@/components/ui/button"

const hourFormatter = new Intl.NumberFormat("sv-SE", { maximumFractionDigits: 1 })

/** Monday-first, matching Swedish convention. */
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0]

/** Anchors that represent lumpy, one-off work rather than the monthly rhythm. */
const EVENT_KINDS: ResourceEventKind[] = ["bokslut", "ink2"]

const TONE_CLASS = {
  neutral: "bg-muted-foreground",
  success: "bg-semantic-success",
  warning: "bg-semantic-warning",
  error: "bg-semantic-error",
} as const

export type CalendarEvent = ResourceMonthEvent & { customer_name: string }

export type CalendarAbsence = {
  profile_id: string
  profile_name: string | null
  start_date: string
  end_date: string
  type: string
}

function isWeekend(date: Date) {
  const day = date.getDay()
  return day === 0 || day === 6
}

function isoDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

/** ISO week number — the unit Saldo already talks in ("Senast v13"). */
function isoWeek(date: Date): number {
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dayNumber = (target.getUTCDay() + 6) % 7
  target.setUTCDate(target.getUTCDate() - dayNumber + 3)
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4))
  const firstDayNumber = (firstThursday.getUTCDay() + 6) % 7
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNumber + 3)
  return 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000))
}

type DayCell = {
  date: Date
  key: string
  inMonth: boolean
  isWorkday: boolean
  holiday: string | null
  events: CalendarEvent[]
}

/**
 * Month view of a single period.
 *
 * Every date drawn here is derived from something real:
 *
 *   moms / AGI   den 12:e (den 26:e för stora företag), from customers.moms_period
 *   löner        customers.payroll_run_day, default den 25:e
 *   bokslut      the engagement's own deadline
 *   INK2         the engagement's INK2 date, or the internal one computed from
 *                räkenskapsårsslutet
 *
 * Nothing is invented to fill the grid. A month with no derivable anchors
 * collapses to a single line and gives the space back to the customer cards,
 * because six empty week rows is not information.
 *
 * The week bar separates the two kinds of hours it is made of: anchored hours
 * sit in the week their date falls in, and everything else is a flat remainder,
 * labelled as such. A flat spread presented as a forecast implies knowledge of
 * *when* work happens that the system does not have.
 */
export function BelaggningCalendar({
  year,
  month,
  events,
  holidays,
  absences,
  eventHoursByCustomer,
  lopandeTotalHours,
  monthlyAvailableHours,
  onSelect,
}: {
  year: number
  month: number
  events: CalendarEvent[]
  holidays: Array<{ date: string; name: string }>
  absences: CalendarAbsence[]
  /** Händelsestyrda hours per customer, placed on that customer's anchor days. */
  eventHoursByCustomer: Record<string, number>
  /** Everything that is not anchored — spread flat, and labelled as spread. */
  lopandeTotalHours: number
  monthlyAvailableHours: number
  onSelect: (customerId: string) => void
}) {
  const { t, language } = useTranslation()
  const locale = language === "sv" ? "sv-SE" : "en-GB"
  // A month with no anchors collapses by default; opening it is a deliberate act.
  const [expanded, setExpanded] = React.useState(false)

  const holidayByDate = React.useMemo(() => {
    const map = new Map<string, string>()
    for (const holiday of holidays) map.set(holiday.date, holiday.name)
    return map
  }, [holidays])

  const weeks = React.useMemo(() => {
    const first = new Date(year, month - 1, 1)
    const last = new Date(year, month, 0)

    // Back up to the Monday on or before the 1st, forward to the Sunday on or
    // after the last day, so the grid is always whole weeks.
    const start = new Date(first)
    start.setDate(first.getDate() - ((first.getDay() + 6) % 7))
    const end = new Date(last)
    end.setDate(last.getDate() + (7 - ((last.getDay() + 6) % 7) - 1))

    const eventsByDay = new Map<string, CalendarEvent[]>()
    for (const event of events) {
      const list = eventsByDay.get(event.due_date) ?? []
      list.push(event)
      eventsByDay.set(event.due_date, list)
    }

    const out: DayCell[][] = []
    const cursor = new Date(start)
    while (cursor <= end) {
      const week: DayCell[] = []
      for (let i = 0; i < 7; i += 1) {
        const key = isoDate(cursor)
        const holiday = holidayByDate.get(key) ?? null
        week.push({
          date: new Date(cursor),
          key,
          inMonth: cursor.getMonth() === month - 1,
          isWorkday: !isWeekend(cursor) && holiday === null,
          holiday,
          events: eventsByDay.get(key) ?? [],
        })
        cursor.setDate(cursor.getDate() + 1)
      }
      out.push(week)
    }
    return out
  }, [events, holidayByDate, year, month])

  const workdaysInMonth = React.useMemo(
    () =>
      weeks.reduce(
        (sum, week) => sum + week.filter((cell) => cell.inMonth && cell.isWorkday).length,
        0,
      ),
    [weeks],
  )

  const perWorkday = workdaysInMonth > 0 ? lopandeTotalHours / workdaysInMonth : 0

  const weekdayNames = React.useMemo(() => {
    const formatter = new Intl.DateTimeFormat(locale, { weekday: "short" })
    // 2024-01-01 was a Monday; walk from there so the labels match the order.
    return WEEKDAY_ORDER.map((_, index) => formatter.format(new Date(2024, 0, 1 + index)))
  }, [locale])

  const dateFormatter = React.useMemo(
    () => new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }),
    [locale],
  )

  const today = new Date()
  const anchorCount = events.length

  if (anchorCount === 0 && !expanded) {
    // Nothing is derivable for this month, so the calendar has nothing to say.
    // Say that in one line instead of six empty week rows.
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm">
        <CalendarDays className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-muted-foreground">
          {t(
            "belaggning.calendar.noAnchors",
            "No dated work this month — the hours are running work with no fixed day.",
          )}
        </span>
        <span className="tabular-nums">
          {hourFormatter.format(lopandeTotalHours)} h
        </span>
        <Button
          variant="ghost"
          size="xs"
          className="ml-auto gap-1"
          onClick={() => setExpanded(true)}
        >
          {t("belaggning.calendar.show", "Show calendar")}
          <ChevronDown className="size-3.5" />
        </Button>
      </div>
    )
  }

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[52rem]">
        {anchorCount === 0 ? (
          <div className="mb-2 flex justify-end">
            <Button
              variant="ghost"
              size="xs"
              className="gap-1"
              onClick={() => setExpanded(false)}
            >
              {t("belaggning.calendar.hide", "Hide calendar")}
              <ChevronUp className="size-3.5" />
            </Button>
          </div>
        ) : null}

        <div className="grid grid-cols-[3.5rem_repeat(7,1fr)] gap-px">
          <div />
          {weekdayNames.map((name) => (
            <div
              key={name}
              className="px-2 py-1 text-xs font-medium capitalize text-muted-foreground"
            >
              {name}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-[3.5rem_repeat(7,1fr)] gap-px rounded-lg bg-border">
          {weeks.map((week) => {
            const workdays = week.filter((cell) => cell.inMonth && cell.isWorkday).length
            const spread = perWorkday * workdays

            // Anchored hours land in the week their date falls in. A customer
            // with two anchors in the month splits its händelsestyrda hours
            // between them rather than counting twice.
            const anchored = week.reduce((sum, cell) => {
              for (const event of cell.events) {
                if (!EVENT_KINDS.includes(event.kind)) continue
                const total = eventHoursByCustomer[event.customer_id] ?? 0
                const anchors = events.filter(
                  (e) => e.customer_id === event.customer_id && EVENT_KINDS.includes(e.kind),
                ).length
                sum += anchors > 0 ? total / anchors : 0
              }
              return sum
            }, 0)

            const weekCapacity =
              workdaysInMonth > 0 ? (monthlyAvailableHours * workdays) / workdaysInMonth : 0
            const weekLoad = weekCapacity > 0 ? (spread + anchored) / weekCapacity : 0
            const tone = loadTone(weekLoad)

            const weekStart = week[0].key
            const weekEnd = week[6].key
            const away = absences.filter(
              (absence) => absence.start_date <= weekEnd && absence.end_date >= weekStart,
            )

            return (
              <React.Fragment key={weekStart}>
                <div className="flex flex-col justify-center gap-1 bg-background px-2 py-2">
                  <span className="text-xs font-medium text-muted-foreground">
                    v{isoWeek(week[0].date)}
                  </span>
                  {spread + anchored > 0 ? (
                    <>
                      <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className={cn("h-full rounded-full", TONE_CLASS[tone])}
                          style={{ width: `${Math.min(weekLoad * 100, 100)}%` }}
                        />
                      </div>
                      <span
                        className="text-[10px] tabular-nums text-muted-foreground"
                        title={t(
                          "belaggning.calendar.weekBreakdown",
                          "{anchored} h anchored · {spread} h spread evenly",
                        )
                          .replace("{anchored}", hourFormatter.format(anchored))
                          .replace("{spread}", hourFormatter.format(spread))}
                      >
                        {hourFormatter.format(spread + anchored)} h
                      </span>
                    </>
                  ) : null}
                </div>

                {week.map((cell) => {
                  const isToday =
                    cell.date.getFullYear() === today.getFullYear() &&
                    cell.date.getMonth() === today.getMonth() &&
                    cell.date.getDate() === today.getDate()

                  return (
                    <div
                      key={cell.key}
                      className={cn(
                        "min-h-[5.5rem] bg-background p-1.5",
                        !cell.inMonth && "opacity-40",
                        (isWeekend(cell.date) || cell.holiday) && "bg-muted/30",
                      )}
                    >
                      <div className="flex items-baseline gap-1">
                        <span
                          className={cn(
                            "inline-flex size-5 items-center justify-center rounded-full text-xs tabular-nums",
                            isToday
                              ? "bg-brand-primary font-medium text-text-on-brand"
                              : "text-muted-foreground",
                          )}
                        >
                          {cell.date.getDate()}
                        </span>
                        {cell.holiday ? (
                          <span className="truncate text-[10px] text-muted-foreground">
                            {cell.holiday}
                          </span>
                        ) : null}
                      </div>

                      <div className="mt-1 space-y-1">
                        {cell.events.map((event) => (
                          <button
                            key={`${event.customer_id}-${event.kind}`}
                            type="button"
                            onClick={() => onSelect(event.customer_id)}
                            className="flex w-full items-center gap-1 rounded-sm bg-muted/60 px-1.5 py-1 text-left transition-colors hover:bg-muted"
                            title={`${event.customer_name} · ${event.label}`}
                          >
                            {event.hardness === "lagstadgad" ? (
                              <Lock className="size-2.5 shrink-0 text-semantic-warning" />
                            ) : null}
                            <span className="truncate text-[11px] leading-tight">
                              {event.customer_name}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )
                })}

                {away.length > 0 ? (
                  <>
                    <div className="bg-background" />
                    <div className="col-span-7 flex flex-wrap items-center gap-1 bg-background px-2 py-1">
                      <Plane className="size-3 shrink-0 text-semantic-info" />
                      {away.map((absence) => (
                        <span
                          key={`${absence.profile_id}-${absence.start_date}`}
                          className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                          title={`${dateFormatter.format(new Date(`${absence.start_date}T00:00:00`))} – ${dateFormatter.format(new Date(`${absence.end_date}T00:00:00`))}`}
                        >
                          {absence.profile_name ?? "—"}
                        </span>
                      ))}
                    </div>
                  </>
                ) : null}
              </React.Fragment>
            )
          })}
        </div>

        <p className="mt-2 text-xs text-muted-foreground">
          {t(
            "belaggning.calendar.anchorNote",
            "Dates are derived from each customer's own facts: VAT period, payroll day and fiscal year end. The weekly bar is anchored work plus a flat share of the running work — a load indication, not a schedule.",
          )}
        </p>
      </div>
    </div>
  )
}
