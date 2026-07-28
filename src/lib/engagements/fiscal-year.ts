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
