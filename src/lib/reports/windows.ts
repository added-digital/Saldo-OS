import {
  formatSwedishMonthShort,
  formatSwedishMonthYear,
} from "./formatters";
import type {
  ComparisonMode,
  CustomerMonthlyEconomicsRow,
  ReportingWindowMode,
  RollingMonth,
  SelectOption,
} from "./types";

export function toMonthKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

export function toDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function parseMonthKey(monthKey: string): {
  year: number;
  month: number;
} {
  const [yearPart, monthPart] = monthKey.split("-");
  const year = Number(yearPart);
  const month = Number(monthPart);

  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    month < 1 ||
    month > 12
  ) {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() + 1 };
  }

  return { year, month };
}

export function createMonthOptions(count: number): SelectOption[] {
  const now = new Date();
  const minSelectableMonth = "2025-01";
  const options: SelectOption[] = [];

  for (let i = 0; i < count; i += 1) {
    const valueDate = new Date(now.getFullYear(), now.getMonth() - i, 1);
    options.push({
      id: toMonthKey(valueDate),
      label: formatSwedishMonthYear(valueDate),
    });
  }

  return options.filter((option) => option.id >= minSelectableMonth);
}

export type ReportingWindowOptions = {
  /**
   * When `true` (default) and `mode` is a rolling window, anchor the window
   * at the current calendar month and end it at today's date so the current,
   * in-progress month is included in calculations. When `false`, anchor at
   * `selectedMonthKey` (which defaults to the last completed month) and end
   * at the last day of that month so the unfinished current month is
   * excluded.
   *
   * Ignored for `current-month` mode — the explicit month picker fully
   * specifies the window in that mode.
   */
  includeCurrentMonth?: boolean;
};

export function getReportingWindowRange(
  selectedMonthKey: string,
  mode: ReportingWindowMode,
  options: ReportingWindowOptions = {},
): {
  from: string;
  to: string;
  months: RollingMonth[];
  title: string;
} {
  const { includeCurrentMonth = true } = options;

  // For rolling modes, the toggle lets the user pick the anchor: either
  // today's calendar month (include current/partial) or the last completed
  // month (exclude it). For current-month mode, the explicit picker wins
  // and the toggle is ignored.
  const today = new Date();
  const useLiveAnchor = mode !== "current-month" && includeCurrentMonth;
  const anchorYear = useLiveAnchor ? today.getFullYear() : parseMonthKey(selectedMonthKey).year;
  const anchorMonth = useLiveAnchor
    ? today.getMonth() + 1
    : parseMonthKey(selectedMonthKey).month;

  const year = anchorYear;
  const month = anchorMonth;
  const monthDate = new Date(year, month - 1, 1);
  // When the anchor is the live current month, end the window at today so
  // the partial month flows through. Otherwise end at the last day of the
  // anchor month (existing behavior).
  const endDate = useLiveAnchor ? today : new Date(year, month, 0);
  const startDate =
    mode === "current-month"
      ? new Date(year, month - 1, 1)
      : mode === "rolling-year"
        ? new Date(year, 0, 1)
        : new Date(year, month - 12, 1);
  const months: RollingMonth[] = [];

  if (mode === "current-month") {
    months.push({
      key: toMonthKey(monthDate),
      label: formatSwedishMonthShort(monthDate),
      year: monthDate.getFullYear(),
      month: monthDate.getMonth() + 1,
    });

    return {
      from: toMonthKey(startDate) + "-01",
      to: toDateKey(endDate),
      months,
      title: formatSwedishMonthYear(monthDate),
    };
  }

  const monthCount = mode === "rolling-year" ? month : 12;

  for (let i = 0; i < monthCount; i += 1) {
    const monthDate = new Date(
      startDate.getFullYear(),
      startDate.getMonth() + i,
      1,
    );
    months.push({
      key: toMonthKey(monthDate),
      label: formatSwedishMonthShort(monthDate),
      year: monthDate.getFullYear(),
      month: monthDate.getMonth() + 1,
    });
  }

  return {
    from: toMonthKey(startDate) + "-01",
    to: toDateKey(endDate),
    months,
    title:
      mode === "rolling-year"
        ? String(year)
        : formatSwedishMonthYear(new Date(year, month - 1, 1)),
  };
}

export function getMonthDateRange(monthKey: string): {
  from: string;
  to: string;
} {
  const { year, month } = parseMonthKey(monthKey);
  const firstDay = new Date(year, month - 1, 1);
  const lastDay = new Date(year, month, 0);
  return {
    from: toMonthKey(firstDay) + "-01",
    to: toDateKey(lastDay),
  };
}

export function getDefaultReportsMonthKey(): string {
  const now = new Date();
  return toMonthKey(new Date(now.getFullYear(), now.getMonth() - 1, 1));
}

export function compareMonthKeys(a: string, b: string): number {
  if (a === "average" && b === "average") return 0;
  if (a === "average") return 1;
  if (b === "average") return -1;
  return a.localeCompare(b);
}

export function compareMonthKeysWithAverageFixed(
  a: CustomerMonthlyEconomicsRow,
  b: CustomerMonthlyEconomicsRow,
): number {
  if (a.monthKey === "average" || b.monthKey === "average") {
    return 0;
  }

  return a.monthKey.localeCompare(b.monthKey);
}

/**
 * Returns the comparison-period equivalent of a reporting window.
 *
 * Year-over-year always shifts back by 12 months, regardless of mode — the
 * usual "this March vs last March" mental model.
 *
 * Period-over-period shifts back by the window's own length:
 *   - current-month (1 month) → the immediately preceding month
 *   - rolling-12-months (12 months) → the 12 months before that (collides
 *     with year-over-year, intentionally)
 *   - rolling-year (Jan–N months) → the N months immediately before
 */
export function getPreviousReportingWindowRange(
  selectedMonthKey: string,
  mode: ReportingWindowMode,
  comparison: ComparisonMode,
  options: ReportingWindowOptions = {},
): {
  from: string;
  to: string;
  months: RollingMonth[];
  title: string;
} {
  const { includeCurrentMonth = true } = options;
  const current = getReportingWindowRange(selectedMonthKey, mode, options);
  const monthCount = current.months.length;
  const shiftMonths = comparison === "year-over-year" ? 12 : monthCount;

  const previousMonths: RollingMonth[] = current.months.map((entry) => {
    const shiftedDate = new Date(entry.year, entry.month - 1 - shiftMonths, 1);
    return {
      key: toMonthKey(shiftedDate),
      label: formatSwedishMonthShort(shiftedDate),
      year: shiftedDate.getFullYear(),
      month: shiftedDate.getMonth() + 1,
    };
  });

  const firstMonth = previousMonths[0];
  const lastMonth = previousMonths[previousMonths.length - 1];
  const startDate = new Date(firstMonth.year, firstMonth.month - 1, 1);
  // When the current window includes the in-progress month, mirror that
  // onto the comparison: truncate the comparison's last month to the same
  // day-of-month as today so we compare apples to apples (e.g. May 1–28
  // 2026 vs. May 1–28 2025), not partial-vs-full. We cap the day at the
  // last valid day of the target month to handle month-length differences.
  const useLiveAnchor = mode !== "current-month" && includeCurrentMonth;
  const today = new Date();
  const lastDayOfTargetMonth = new Date(
    lastMonth.year,
    lastMonth.month,
    0,
  ).getDate();
  const targetDay = useLiveAnchor
    ? Math.min(today.getDate(), lastDayOfTargetMonth)
    : lastDayOfTargetMonth;
  const endDate = new Date(lastMonth.year, lastMonth.month - 1, targetDay);

  const title =
    monthCount === 1
      ? formatSwedishMonthYear(startDate)
      : `${formatSwedishMonthYear(startDate)} – ${formatSwedishMonthYear(
          new Date(lastMonth.year, lastMonth.month - 1, 1),
        )}`;

  return {
    from: toMonthKey(startDate) + "-01",
    to: toDateKey(endDate),
    months: previousMonths,
    title,
  };
}
