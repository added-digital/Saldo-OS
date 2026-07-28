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

/**
 * Propose the fiscal-year end for a NEW engagement on a given customer.
 *
 * The customer's räkenskapsår (Bolagsverket → SIE → manual, resolved upstream)
 * is a recurring shape — it tells us the month-day, never which year is next up.
 * Bolagsverket's value is the latest *filed* annual report and SIE's follows
 * Fortnox's open books, so neither can be trusted for the year. Instead:
 *
 *   1. start at the most recent occurrence that has already passed — the year
 *      you would actually be closing today;
 *   2. walk forward one year at a time past every occurrence that already has
 *      an engagement.
 *
 * So a 31-Dec customer on 2026-07-28 with a 2025 card already on the board gets
 * 2026-12-31 ("kommande"), while one whose 2025 card was never created gets
 * 2025-12-31 so the gap can still be filled. Skipping taken years also keeps the
 * dialog off the (customer_id, fiscal_year_end) unique constraint.
 *
 * @param yearEndSource  Customer's räkenskapsår end, any year. Only MM-DD used.
 * @param todayISO       Today as "YYYY-MM-DD" (injected so this stays pure).
 * @param takenYearEnds  Fiscal-year ends this customer already has engagements
 *                       for, as ISO dates.
 * @param fallback       engagement_config.active_fiscal_year_end — supplies the
 *                       month-day when the customer has no räkenskapsår, and is
 *                       returned verbatim if nothing usable can be derived.
 */
export function proposeFiscalYearEnd({
  yearEndSource,
  todayISO,
  takenYearEnds = [],
  fallback,
}: {
  yearEndSource: string | null | undefined
  todayISO: string
  takenYearEnds?: Iterable<string>
  fallback: string
}): string {
  const monthDay = monthDayOf(yearEndSource) ?? monthDayOf(fallback)
  if (!monthDay || !/^\d{4}-\d{2}-\d{2}$/.test(todayISO)) return fallback

  // The occurrence for the current calendar year hasn't happened yet → the most
  // recent completed one is a year earlier. (Ending exactly today counts as
  // completed: the books are closed, the bokslut is due.)
  let year = Number(todayISO.slice(0, 4))
  if (stampYear(year, monthDay) > todayISO) year -= 1

  const taken = new Set(takenYearEnds)
  // Bounded so a customer with a long history can't spin forever; 12 is far
  // past any realistic backlog and still lands on a sane date.
  for (let i = 0; i < 12; i++) {
    const candidate = stampYear(year + i, monthDay)
    if (!taken.has(candidate)) return candidate
  }
  return stampYear(year, monthDay)
}
