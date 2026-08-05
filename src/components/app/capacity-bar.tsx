"use client"

import * as React from "react"

import { cn } from "@/lib/utils"
import { useTranslation } from "@/hooks/use-translation"
import { loadTone } from "@/types/resource"

const hourFormatter = new Intl.NumberFormat("sv-SE", { maximumFractionDigits: 1 })

const TONE_CLASS: Record<ReturnType<typeof loadTone>, string> = {
  neutral: "bg-muted-foreground",
  success: "bg-semantic-success",
  warning: "bg-semantic-warning",
  error: "bg-semantic-error",
}

/**
 * Planerat mot tillgängligt.
 *
 * The planned number on its own says nothing — 80 h is half a month or two
 * months depending on who is asking and how much semester they have booked.
 * The bar is the same component in the page header and in every board column so
 * that one load never reads as two different states depending on where it sits.
 *
 * The track extends past full capacity and marks 100% with a tick, so an
 * overloaded column reads as fill past the mark instead of a bar that happens
 * to be full — 101% and 140% used to look identical.
 */
export function CapacityBar({
  plannedHours,
  availableHours,
  detail,
  className,
  compact = false,
}: {
  plannedHours: number
  /** 0 when nobody's capacity is known — the bar then shows hours only. */
  availableHours: number
  /** How the available number was arrived at, shown on hover. */
  detail?: string
  className?: string
  compact?: boolean
}) {
  const { t } = useTranslation()

  if (availableHours <= 0) {
    return (
      <p className={cn("text-xs text-muted-foreground tabular-nums", className)}>
        {hourFormatter.format(plannedHours)} h
      </p>
    )
  }

  const load = plannedHours / availableHours
  const tone = loadTone(load)
  const percent = Math.round(load * 100)

  // The track runs past 100% so that full capacity is a mark on it rather than
  // the end of it. Clamping the fill at the end made 101% and 140% look
  // identical, which is the one comparison the bar exists to make.
  const scale = Math.max(1.25, load)

  return (
    <div className={cn("space-y-1", className)}>
      <div
        className={cn(
          "relative w-full overflow-hidden rounded-full bg-muted",
          compact ? "h-1.5" : "h-2",
        )}
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={t("belaggning.capacity.aria", "Planned share of available hours")}
        title={detail}
      >
        <div
          className={cn("h-full rounded-full transition-all", TONE_CLASS[tone])}
          style={{ width: `${(Math.max(load, 0) / scale) * 100}%` }}
        />
        <span
          aria-hidden
          className="absolute inset-y-0 w-px bg-border-strong"
          style={{ left: `${(1 / scale) * 100}%` }}
        />
      </div>
      <p
        title={detail}
        className={cn(
          "tabular-nums",
          compact ? "text-[11px]" : "text-xs",
          tone === "error"
            ? "text-semantic-error"
            : tone === "warning"
              ? "text-semantic-warning"
              : "text-muted-foreground",
        )}
      >
        {compact
          ? `${hourFormatter.format(plannedHours)} / ${hourFormatter.format(availableHours)} h · ${percent} %`
          : t("belaggning.capacity.summary", "Planned {planned} h of {available} h · {percent} %")
              .replace("{planned}", hourFormatter.format(plannedHours))
              .replace("{available}", hourFormatter.format(availableHours))
              .replace("{percent}", String(percent))}
      </p>
    </div>
  )
}
