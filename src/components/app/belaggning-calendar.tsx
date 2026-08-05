"use client"

import * as React from "react"
import { Lock, Plane } from "lucide-react"

import { cn } from "@/lib/utils"
import { useTranslation } from "@/hooks/use-translation"
import type { ResourceMonthEvent } from "@/types/resource"

/** Monday-first, matching Swedish convention. */
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0]

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
  holiday: string | null
  events: CalendarEvent[]
}

/**
 * Dated work, on its date. Nothing else.
 *
 * Every event here comes from a fact about the customer: momsperiod puts moms
 * and AGI on the 12th (the 26th for stora företag), payroll_run_day puts lönerna
 * on the 25th, and the engagement's own dates place bokslut and INK2.
 *
 * Löpande hours are deliberately absent. They carry no day-level signal
 * anywhere in the data, and the week bars that used to spread them were the
 * month total divided by workdays — identical by construction, inviting a
 * comparison between weeks that could never come out any way but even. A grid
 * is a claim about *when*, and the parent renders no calendar at all in a month
 * with no derivable dates rather than offering to show an empty one.
 */
export function BelaggningCalendar({
  year,
  month,
  events,
  holidays,
  absences,
  onSelect,
}: {
  year: number
  month: number
  events: CalendarEvent[]
  holidays: Array<{ date: string; name: string }>
  absences: CalendarAbsence[]
  onSelect: (customerId: string) => void
}) {
  const { language } = useTranslation()
  const locale = language === "sv" ? "sv-SE" : "en-GB"

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
        week.push({
          date: new Date(cursor),
          key,
          inMonth: cursor.getMonth() === month - 1,
          holiday: holidayByDate.get(key) ?? null,
          events: eventsByDay.get(key) ?? [],
        })
        cursor.setDate(cursor.getDate() + 1)
      }
      out.push(week)
    }
    return out
  }, [events, holidayByDate, year, month])

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

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[52rem]">
        <div className="grid grid-cols-[3rem_repeat(7,1fr)] gap-px">
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

        <div className="grid grid-cols-[3rem_repeat(7,1fr)] gap-px rounded-lg bg-border">
          {weeks.map((week) => {
            const weekStart = week[0].key
            const weekEnd = week[6].key
            const away = absences.filter(
              (absence) => absence.start_date <= weekEnd && absence.end_date >= weekStart,
            )

            return (
              <React.Fragment key={weekStart}>
                <div className="flex items-center justify-center bg-background px-2 py-2">
                  <span className="text-xs font-medium text-muted-foreground">
                    v{isoWeek(week[0].date)}
                  </span>
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
                        "min-h-[4.5rem] bg-background p-1.5",
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
                              <Lock className="size-2.5 shrink-0 text-semantic-error" />
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
      </div>
    </div>
  )
}
