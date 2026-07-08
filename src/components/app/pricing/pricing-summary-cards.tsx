"use client"

import * as React from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"

const sek = new Intl.NumberFormat("sv-SE", { maximumFractionDigits: 0 })

export function formatSek(n: number): string {
  return sek.format(Math.round(n))
}

interface SummaryLike {
  invoicedCount: number
  totalInvoicedFortnox: number
  totalListPrice: number
  totalFixedCost: number
  totalExtraCost: number
  result: number
  marginPct: number
  totalInvoicedReda: number
  totalRedaCost: number
  redaResult: number
  totalInvoicedNvr: number
  totalNvrRecurring: number
  totalNvrStartFees: number
  nvrShareholders: number
  aktiebokCount: number
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string
  value: string
  sub?: string
  tone?: "default" | "positive" | "muted"
}) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={cn(
          "text-lg font-semibold tabular-nums",
          tone === "positive" && "text-[var(--color-success)]",
          tone === "muted" && "text-muted-foreground",
        )}
      >
        {value}
      </p>
      {sub ? <p className="text-xs text-muted-foreground">{sub}</p> : null}
    </div>
  )
}

export function PricingSummaryCards({
  summary,
  period,
  t,
}: {
  summary: SummaryLike
  period: string
  t: (key: string, fallback: string) => string
}) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t("pricing.summary.fortnox", "Fortnox")}
          </CardTitle>
          <CardDescription>
            {period
              ? t("pricing.summary.period", "Period") + ": " + period
              : t("pricing.summary.fortnoxDesc", "Licensfakturering")}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Stat
            label={t("pricing.summary.invoiced", "Fakturerat")}
            value={formatSek(summary.totalInvoicedFortnox)}
            sub={`${summary.invoicedCount} ${t("pricing.summary.companies", "bolag")}`}
          />
          <Stat
            label={t("pricing.summary.listPrice", "Listpris")}
            value={formatSek(summary.totalListPrice)}
            tone="muted"
          />
          <Stat
            label={t("pricing.summary.fixedCost", "Kostnad fastpris")}
            value={formatSek(summary.totalFixedCost)}
            tone="muted"
          />
          <Stat
            label={t("pricing.summary.extraCost", "Kostnad extra")}
            value={formatSek(summary.totalExtraCost)}
            tone="muted"
          />
          <Stat
            label={t("pricing.summary.result", "Resultat")}
            value={formatSek(summary.result)}
            sub={`${summary.marginPct}% ${t("pricing.summary.margin", "marginal")}`}
            tone="positive"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("pricing.summary.reda", "Reda")}</CardTitle>
          <CardDescription>
            {t("pricing.summary.redaDesc", "Skanning av leverantörsfakturor")}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Stat
            label={t("pricing.summary.invoiced", "Fakturerat")}
            value={formatSek(summary.totalInvoicedReda)}
          />
          <Stat
            label={t("pricing.summary.cost", "Kostnad")}
            value={formatSek(summary.totalRedaCost)}
            tone="muted"
          />
          <Stat
            label={t("pricing.summary.result", "Resultat")}
            value={formatSek(summary.redaResult)}
            tone="positive"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("pricing.summary.nvr", "NVR / Aktiebok")}</CardTitle>
          <CardDescription>
            {t("pricing.summary.nvrDesc", "Aktiebok — pris per aktieägare + startavgift")}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Stat
            label={t("pricing.summary.invoiced", "Fakturerat")}
            value={formatSek(summary.totalInvoicedNvr)}
            sub={`${summary.aktiebokCount} ${t("pricing.summary.companies", "bolag")}`}
            tone="positive"
          />
          <Stat
            label={t("pricing.summary.nvrRecurring", "Löpande")}
            value={formatSek(summary.totalNvrRecurring)}
            sub={`${summary.nvrShareholders} ${t("pricing.summary.shareholders", "aktieägare")}`}
            tone="muted"
          />
          <Stat
            label={t("pricing.summary.nvrStartFees", "Startavgifter")}
            value={formatSek(summary.totalNvrStartFees)}
            tone="muted"
          />
        </CardContent>
      </Card>
    </div>
  )
}
