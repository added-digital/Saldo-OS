"use client";

import NumberFlow from "@number-flow/react";
import { ArrowDown, ArrowUp, ArrowUpRight } from "lucide-react";

import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/hooks/use-translation";
import { cn } from "@/lib/utils";

type KpiValues = {
  turnover: number;
  invoices: number;
  hours: number;
  contractValue: number;
};

interface KpiCardsProps {
  values: KpiValues;
  /**
   * Comparison-period values. When provided, each card renders a small
   * percentage-change pill against `values`. Pass `null`/omit to hide pills.
   */
  previousValues?: KpiValues | null;
  /**
   * Override the current contract value used for the comparison pill only
   * (display value still comes from `values.contractValue`). Useful when the
   * live source for display differs from the rollup source used for prior
   * periods — passing the rollup-equivalent here keeps the pill apples-to-
   * apples even if the displayed number comes from somewhere else.
   */
  comparisonContractValue?: number | null;
  compact?: boolean;
  hoursMode?: "hours" | "turnoverPerHour";
  turnoverPerHour?: number;
  previousTurnoverPerHour?: number;
  onOpenInvoices?: () => void;
  /**
   * Number of overdue invoices (unpaid + past due date) in the current scope.
   * When provided (and > 0), a small "(N overdue)" label is rendered next to
   * the Invoices title.
   */
  overdueInvoices?: number;
}

type ComparisonPillProps = {
  current: number;
  previous: number | undefined | null;
};

const COMPARISON_PILL_CAP = 999;

function ComparisonPill({ current, previous }: ComparisonPillProps) {
  const { t } = useTranslation();

  // Hide pill in ambiguous cases so users don't misread an inflated number:
  //   - no prior data at all (null/undefined) → first period of history
  //   - prior was zero → ratio is undefined; "+∞%" is misleading
  if (previous === null || previous === undefined) return null;
  if (!Number.isFinite(previous) || previous === 0) return null;
  if (!Number.isFinite(current)) return null;

  const delta = current - previous;
  const ratio = (delta / Math.abs(previous)) * 100;
  if (!Number.isFinite(ratio)) return null;

  const direction = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  const isCapped = Math.abs(ratio) > COMPARISON_PILL_CAP;
  const percentFormatter = new Intl.NumberFormat("sv-SE", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
  const tooltipFormatter = new Intl.NumberFormat("sv-SE", {
    maximumFractionDigits: 0,
  });
  const sign = ratio > 0 ? "+" : "";
  const label = isCapped
    ? ratio > 0
      ? `>+${COMPARISON_PILL_CAP}%`
      : `<-${COMPARISON_PILL_CAP}%`
    : `${sign}${percentFormatter.format(ratio)}%`;

  const microcopy = t(
    "kpi.comparison.limitedPriorData",
    "Limited prior data.",
  );

  // When the comparison is unreliable (capped), the % pill is more
  // misleading than informative, so we suppress it and surface the
  // microcopy in its place. Hovering still reveals the raw values.
  if (isCapped) {
    return (
      <span
        className="text-[11px] italic leading-tight text-muted-foreground"
        title={`${microcopy} (${tooltipFormatter.format(previous)} → ${tooltipFormatter.format(current)})`}
      >
        {microcopy}
      </span>
    );
  }

  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-medium",
        direction === "up" && "bg-semantic-success/15 text-semantic-success",
        direction === "down" && "bg-semantic-error/15 text-semantic-error",
        direction === "flat" && "bg-muted text-muted-foreground",
      )}
      title={`${tooltipFormatter.format(previous)} → ${tooltipFormatter.format(current)}`}
    >
      {direction === "up" ? (
        <ArrowUp className="size-3" />
      ) : direction === "down" ? (
        <ArrowDown className="size-3" />
      ) : null}
      {label}
    </span>
  );
}

function KpiCards({
  values,
  previousValues = null,
  comparisonContractValue,
  compact = false,
  hoursMode = "hours",
  turnoverPerHour = 0,
  previousTurnoverPerHour,
  onOpenInvoices,
  overdueInvoices,
}: KpiCardsProps) {
  const { t } = useTranslation();
  const valueClassName = compact
    ? "text-2xl font-semibold leading-tight"
    : "text-4xl font-semibold leading-tight";
  const cardHeaderClassName = compact ? "p-6 pb-1 pt-0" : "p-6 pb-0";
  const cardContentClassName = compact ? "p-6 pt-0 pb-0" : "p-6 pt-0";
  const gridClassName = compact
    ? "grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4"
    : "grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4";

  const thirdKpiLabel =
    hoursMode === "turnoverPerHour"
      ? t("kpi.labels.turnoverPerHoursAvg", "Turnover / Hours Avg (kr/h)")
      : t("kpi.labels.hours", "Hours (h)");

  const thirdKpiCurrent =
    hoursMode === "turnoverPerHour" ? turnoverPerHour : values.hours;
  const thirdKpiPrevious =
    hoursMode === "turnoverPerHour"
      ? previousTurnoverPerHour
      : previousValues?.hours;

  return (
    <div className={gridClassName}>
      <Card className={compact ? "gap-2" : ""}>
        <CardHeader className={cardHeaderClassName}>
          <CardTitle className="text-sm font-medium text-muted-foreground">
            {t("kpi.labels.turnover", "Turnover (kr)")}
          </CardTitle>
        </CardHeader>
        <CardContent className={cardContentClassName}>
          <div className="flex flex-wrap items-center gap-2">
            <p className={valueClassName}>
              <NumberFlow
                value={values.turnover}
                locales="sv-SE"
                format={{
                  style: "decimal",
                  maximumFractionDigits: 0,
                }}
              />
            </p>
            <ComparisonPill
              current={values.turnover}
              previous={previousValues?.turnover}
            />
          </div>
        </CardContent>
      </Card>

      <Card className={compact ? "gap-2" : ""}>
        <CardHeader className={cardHeaderClassName}>
          <CardTitle className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
            {t("kpi.labels.invoices", "Invoices (pcs)")}
            {overdueInvoices && overdueInvoices > 0 ? (
              <span className="text-xs font-normal text-semantic-error">
                ({overdueInvoices.toLocaleString("sv-SE")} {t("kpi.labels.overdue", "overdue")})
              </span>
            ) : null}
          </CardTitle>
          {onOpenInvoices ? (
            <CardAction>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6 text-muted-foreground hover:text-foreground"
                onClick={onOpenInvoices}
                aria-label={t("kpi.actions.openInvoiceDetails", "Open invoice details")}
                title={t("kpi.actions.openInvoiceDetails", "Open invoice details")}
              >
                <ArrowUpRight className="size-3.5" />
              </Button>
            </CardAction>
          ) : null}
        </CardHeader>
        <CardContent className={cardContentClassName}>
          <div className="flex flex-wrap items-center gap-2">
            <p className={valueClassName}>
              <NumberFlow
                value={values.invoices}
                locales="sv-SE"
                format={{
                  style: "decimal",
                  maximumFractionDigits: 0,
                }}
              />
            </p>
            <ComparisonPill
              current={values.invoices}
              previous={previousValues?.invoices}
            />
          </div>
        </CardContent>
      </Card>

      <Card className={compact ? "gap-2" : ""}>
        <CardHeader className={cardHeaderClassName}>
          <CardTitle className="text-sm font-medium text-muted-foreground">
            {thirdKpiLabel}
          </CardTitle>
        </CardHeader>
        <CardContent className={cardContentClassName}>
          <div className="flex flex-wrap items-center gap-2">
            <p className={valueClassName}>
              <NumberFlow
                value={thirdKpiCurrent}
                locales="sv-SE"
                format={{
                  maximumFractionDigits: hoursMode === "turnoverPerHour" ? 0 : 1,
                  minimumFractionDigits: hoursMode === "turnoverPerHour" ? 0 : 1,
                }}
              />
            </p>
            <ComparisonPill
              current={thirdKpiCurrent}
              previous={thirdKpiPrevious}
            />
          </div>
        </CardContent>
      </Card>

      <Card className={compact ? "gap-2" : ""}>
        <CardHeader className={cardHeaderClassName}>
          <CardTitle className="text-sm font-medium text-muted-foreground">
            {t("kpi.labels.contractValue", "Contract Value (kr)")}
          </CardTitle>
        </CardHeader>
        <CardContent className={cardContentClassName}>
          <div className="flex flex-wrap items-center gap-2">
            <p className={valueClassName}>
              <NumberFlow
                value={values.contractValue}
                locales="sv-SE"
                format={{
                  style: "decimal",
                  maximumFractionDigits: 0,
                }}
              />
            </p>
            <ComparisonPill
              current={
                comparisonContractValue ?? values.contractValue
              }
              previous={previousValues?.contractValue}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export { KpiCards, type KpiCardsProps };
