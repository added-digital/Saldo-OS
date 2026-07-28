/**
 * Map a customer's recurring räkenskapsår (financial-year end) onto a specific
 * close cycle.
 *
 * The customer's year-end is a recurring *shape* (a month-day, e.g. "ends 31
 * Dec" or "ends 30 Jun"). The SIE-derived value carries whatever calendar year
 * Fortnox's books currently sit on (which can be ahead of the cycle you're
 * closing), so we deliberately use only its MONTH-DAY and stamp it onto the
 * active close cycle's YEAR.
 *
 * @param yearEndSource  Customer's räkenskapsår end as an ISO date (any year),
 *                       e.g. "2026-12-31" or "2025-06-30". Only MM-DD is used.
 * @param cycleEndDate   The active close cycle's year-end
 *                       (engagement_config.active_fiscal_year_end), e.g.
 *                       "2025-12-31". Only its YEAR is used.
 * @returns ISO date "<cycleYear>-MM-DD"; falls back to `cycleEndDate` unchanged
 *          when the customer has no/!malformed räkenskapsår.
 */
export function fiscalYearEndForCycle(
  yearEndSource: string | null | undefined,
  cycleEndDate: string,
): string {
  if (!yearEndSource) return cycleEndDate
  const monthDay = yearEndSource.slice(5, 10) // "MM-DD"
  const cycleYear = cycleEndDate.slice(0, 4) // "YYYY"
  if (!/^\d{2}-\d{2}$/.test(monthDay) || !/^\d{4}$/.test(cycleYear)) {
    return cycleEndDate
  }
  return `${cycleYear}-${monthDay}`
}

/**
 * Propose a deadline from a fiscal-year end: the year-end date shifted forward
 * by `offsetMonths` months (e.g. an AB filing target). The day is clamped to
 * the target month's last day so adding months to a 31st never rolls into the
 * following month (2025-12-31 + 3 → 2026-03-31; a hypothetical +2 → 2026-02-28).
 *
 * This only *suggests* a deadline — the UI lets the user override it by hand.
 *
 * @param fiscalYearEnd  ISO date "YYYY-MM-DD" (the engagement's räkenskapsårsslut).
 * @param offsetMonths   Whole months to add. Non-finite/negative → treated as 0.
 * @returns ISO date "YYYY-MM-DD", or "" when the input date is missing/malformed.
 */
export function deadlineForFiscalYearEnd(
  fiscalYearEnd: string | null | undefined,
  offsetMonths: number,
): string {
  if (!fiscalYearEnd) return ""
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fiscalYearEnd)
  if (!m) return ""
  const months = Number.isFinite(offsetMonths) ? Math.max(0, Math.trunc(offsetMonths)) : 0
  const year = Number(m[1])
  const monthIdx = Number(m[2]) - 1
  const day = Number(m[3])

  // Work on the 1st to avoid JS month-overflow, then clamp the day.
  const shifted = new Date(Date.UTC(year, monthIdx + months, 1))
  const lastDay = new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0),
  ).getUTCDate()
  const yy = shifted.getUTCFullYear()
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, "0")
  const dd = String(Math.min(day, lastDay)).padStart(2, "0")
  return `${yy}-${mm}-${dd}`
}

/** Stamp a recurring MM-DD onto a year, clamping the day to that month's end. */
function stampYear(year: number, monthDay: string): string {
  const month = Number(monthDay.slice(0, 2))
  const day = Number(monthDay.slice(3, 5))
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const dd = String(Math.min(day, lastDay)).padStart(2, "0")
  return `${year}-${monthDay.slice(0, 2)}-${dd}`
}

/** "YYYY-MM-DD" → "MM-DD", or null when the input isn't a usable ISO date. */
function monthDayOf(value: string | null | undefined): string | null {
  if (!value) return null
  const monthDay = value.slice(5, 10)
  return /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(monthDay) ? monthDay : null
}

/** Year part of an ISO date, or null when it isn't one. */
function yearOf(value: string | null | undefined): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  return Number(value.slice(0, 4))
}

/**
 * Propose the fiscal-year end for a NEW engagement on a given customer.
 *
 * The accounting rule this encodes: a bokslut can only be made for a
 * räkenskapsår that has ENDED, and the one you want is the oldest such year
 * that isn't accounted for yet. So the default is the earliest ended year with
 * no annual report registered and no card on the board — and only when
 * everything ended is done does it roll on to the year currently running
 * (planning ahead for the next close).
 *
 * Sources for the YEAR, in order:
 *
 *   1. **Bolagsverket** (`financial_year_to_bv`) — the latest annual report BV
 *      has registered. That year is provably done, so start at the one after.
 *   2. **SIE** (`financial_year_to_sie`) — the newest book year imported from
 *      Fortnox, i.e. the period open in the ledger. Proposed as-is, not +1.
 *   3. **Neither** — the most recently ended occurrence, which is what you'd be
 *      closing today.
 *
 * Every start is floored at that most-recently-ended occurrence, so a lagging
 * or gappy BV history (the dataset only covers digital filings from 2020) can't
 * drag the proposal back to a 2022 bokslut. Finally it rolls forward past any
 * year the customer already has an engagement for, which also keeps the create
 * dialog off the (customer_id, fiscal_year_end) unique constraint.
 *
 * The MONTH-DAY always comes from the first source that has one (BV → SIE →
 * manual → config fallback), so broken räkenskapsår keep their shape.
 *
 * @param bvYearEnd      customers.financial_year_to_bv (latest filed period).
 * @param sieYearEnd     customers.financial_year_to_sie (newest imported book year).
 * @param manualYearEnd  customers.financial_year_to_manual (hand-entered shape).
 * @param todayISO       Today as "YYYY-MM-DD" (injected so this stays pure).
 * @param takenYearEnds  Fiscal-year ends this customer already has engagements for.
 * @param fallback       engagement_config.active_fiscal_year_end — supplies the
 *                       month-day when the customer has nothing, and is
 *                       returned verbatim if nothing usable can be derived.
 */
export function proposeFiscalYearEnd({
  bvYearEnd,
  sieYearEnd,
  manualYearEnd,
  todayISO,
  takenYearEnds = [],
  fallback,
}: {
  bvYearEnd?: string | null
  sieYearEnd?: string | null
  manualYearEnd?: string | null
  todayISO: string
  takenYearEnds?: Iterable<string>
  fallback: string
}): string {
  const monthDay =
    monthDayOf(bvYearEnd) ??
    monthDayOf(sieYearEnd) ??
    monthDayOf(manualYearEnd) ??
    monthDayOf(fallback)
  if (!monthDay || !/^\d{4}-\d{2}-\d{2}$/.test(todayISO)) return fallback

  // The occurrence for the current calendar year hasn't happened yet → the most
  // recent ended one is a year earlier. (Ending exactly today counts as ended:
  // the books are shut, the bokslut is due.)
  const thisYear = Number(todayISO.slice(0, 4))
  const endedYear = stampYear(thisYear, monthDay) > todayISO ? thisYear - 1 : thisYear

  const bvYear = monthDayOf(bvYearEnd) ? yearOf(bvYearEnd) : null
  const sieYear = monthDayOf(sieYearEnd) ? yearOf(sieYearEnd) : null

  let startYear: number
  if (bvYear != null) {
    startYear = Math.max(bvYear + 1, endedYear)
  } else if (sieYear != null) {
    startYear = Math.max(sieYear, endedYear)
  } else {
    startYear = endedYear
  }

  const taken = new Set(takenYearEnds)
  // Bounded so a customer with a long history can't spin forever; 12 is far
  // past any realistic backlog and still lands on a sane date.
  for (let i = 0; i < 12; i++) {
    const candidate = stampYear(startYear + i, monthDay)
    if (!taken.has(candidate)) return candidate
  }
  return stampYear(startYear, monthDay)
}
