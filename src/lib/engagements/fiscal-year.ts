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
