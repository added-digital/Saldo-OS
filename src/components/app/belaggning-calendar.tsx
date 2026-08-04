"use client"

import * as React from "react"
import { Lock } from "lucide-react"

import { cn } from "@/lib/utils"
import { useTranslation } from "@/hooks/use-translation"
import type { ResourceBoardRow } from "@/types/resource"

const hourFormatter = new Intl.NumberFormat("sv-SE", { maximumFractionDigits: 1 })

/** Monday-first, matching Swedish convention. */
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0]

function isWeekend(date: Date) {
  const day = date.getDay()
  return day === 0 || day === 6
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
  inMonth: boolean
  events: ResourceBoardRow[]
}

/**
 * Month view of a single period.
 *
 * Two kinds of work are shown differently on purpose:
 *
 *   Händelsestyrt sits on its actual day, because bokslut and INK2 have real
 *   dates derived from each customer's own räkenskapsårsslut.
 *
 *   Löpande has no day-level signal anywhere in the data — only a monthly
 *   total per customer. Rather than invent a schedule, it is spread evenly
 *   across the month's working days and shown as a per-week load, labelled as
 *   spread. A week bar therefore answers "is this week too full", not "this
 *   work happens Tuesday".
 */
export function BelaggningCalendar({
  rows,
  year,
  month,
  weeklyCapacityHours,
  onSelect,
}: {
  rows: ResourceBoardRow[]
  year: number
  month: number
  /** Capacity of everyone currently in view, per week. */
  weeklyCapacityHours: number
  onSelect: (row: ResourceBoardRow) => void
}) {
  const { t, language } = useTranslation()
  const locale = language === "sv" ? "sv-SE" : "en-GB"

  const weeks = React.useMemo(() => {
    const first = new Date(year, month - 1, 1)
    const last = new Date(year, month, 0)

    // Back up to the Monday on or before the 1st, forward to the Sunday on or
    // after the last day, so the grid is always whole weeks.
    const start = new Date(first)
    start.setDate(first.getDate() - ((first.getDay() + 6) % 7))
    const end = new Date(last)
    end.setDate(last.getDate() + (7 - ((last.getDay() + 6) % 7) - 1))

    const eventsByDay = new Map<string, ResourceBoardRow[]>()
    for (const row of rows) {
      if (!row.event_due_date) continue
      const list = eventsByDay.get(row.event_due_date) ?? []
      list.push(row)
      eventsByDay.set(row.event_due_date, list)
    }

    const out: DayCell[][] = []
    let cursor = new Date(start)
    while (cursor <= end) {
      const week: DayCell[] = []
      for (let i = 0; i < 7; i += 1) {
        const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(cursor.getDate()).padStart(2, "0")}`
        week.push({
          date: new Date(cursor),
          inMonth: cursor.getMonth() === month - 1,
          events: eventsByDay.get(key) ?? [],
        })
        cursor.setDate(cursor.getDate() + 1)
      }
      out.push(week)
    }
    return out
  }, [rows, year, month])

  // Löpande spread: total monthly hours divided across the month's working
  // days, then re-gathered per week. Working days only, because nobody plans
  // löpande onto a Saturday.
  const workingDaysInMonth = React.useMemo(() => {
    let count = 0
    const last = new Date(year, month, 0).getDate()
    for (let day = 1; day <= last; day += 1) {
      if (!isWeekend(new Date(year, month - 1, day))) count += 1
    }
    return count
  }, [year, month])

  const lopandeTotal = rows.reduce((sum, row) => sum + Number(row.effective_hours ?? 0), 0)
  const perWorkingDay = workingDaysInMonth > 0 ? lopandeTotal / workingDaysInMonth : 0

  const weekdayNames = React.useMemo(() => {
    const formatter = new Intl.DateTimeFormat(locale, { weekday: "short" })
    // 2024-01-01 was a Monday; walk from there so the labels match the order.
    return WEEKDAY_ORDER.map((_, index) =>
      formatter.format(new Date(2024, 0, 1 + index)),
    )
  }, [locale])

  const today = new Date()

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[52rem]">
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
            const workingDays = week.filter(
              (cell) => cell.inMonth && !isWeekend(cell.date),
            ).length
            const spread = perWorkingDay * workingDays
            const load = weeklyCapacityHours > 0 ? spread / weeklyCapacityHours : 0

            return (
              <React.Fragment key={week[0].date.toISOString()}>
                <div className="flex flex-col justify-center gap-1 bg-background px-2 py-2">
                  <span className="text-xs font-medium text-muted-foreground">
                    v{isoWeek(week[0].date)}
                  </span>
                  {spread > 0 ? (
                    <>
                      <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className={cn(
                            "h-full rounded-full",
                            load > 1
                              ? "bg-semantic-error"
                              : load > 0.85
                                ? "bg-semantic-warning"
                                : "bg-semantic-success",
                          )}
                          style={{ width: `${Math.min(load * 100, 100)}%` }}
                        />
                      </div>
                      <span className="text-[10px] tabular-nums text-muted-foreground">
                        {hourFormatter.format(spread)} h
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
                      key={cell.date.toISOString()}
                      className={cn(
                        "min-h-[5.5rem] bg-background p-1.5",
                        !cell.inMonth && "opacity-40",
                        isWeekend(cell.date) && "bg-muted/30",
                      )}
                    >
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

                      <div className="mt-1 space-y-1">
                        {cell.events.map((row) => (
                          <button
                            key={row.customer_id}
                            type="button"
                            onClick={() => onSelect(row)}
                            className="flex w-full items-center gap-1 rounded-sm bg-muted/60 px-1.5 py-1 text-left transition-colors hover:bg-muted"
                            title={`${row.customer_name} · ${row.event_label ?? ""}`}
                          >
                            {row.event_hardness === "lagstadgad" ? (
                              <Lock className="size-2.5 shrink-0 text-semantic-warning" />
                            ) : null}
                            <span className="truncate text-[11px] leading-tight">
                              {row.customer_name}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </React.Fragment>
            )
          })}
        </div>

        <p className="mt-2 text-xs text-muted-foreground">
          {t(
            "belaggning.calendar.spreadNote",
            "Dates show statutory work anchored to each customer's fiscal year. Weekly load spreads the running work evenly across working days — it is a load indication, not a schedule.",
          )}
        </p>
      </div>
    </div>
  )
}
