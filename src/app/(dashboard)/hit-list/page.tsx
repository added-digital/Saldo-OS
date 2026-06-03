"use client"

import * as React from "react"
import Link from "next/link"
import { AlertTriangle, ArrowRight, ChevronRight, Target } from "lucide-react"

import { createClient } from "@/lib/supabase/client"
import { cn } from "@/lib/utils"
import { useTranslation } from "@/hooks/use-translation"
import { useUser } from "@/hooks/use-user"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import {
  HIT_LIST_RULES,
  accountsForRules,
  kpiKeysForRules,
  resolveValue,
  ruleMatches,
  type CustomerFinancials,
  type HitListRule,
  type HitListUnit,
} from "@/lib/fortnox-sie/hit-list-definitions"

/**
 * /hit-list — Träfflista.
 *
 * One expandable row per rule. Collapsed: rule name, purpose and a count of
 * matching companies. Expanded: the full description, the matching rule, the
 * possible advisory services, and the list of companies (with synced SIE
 * files) whose account balances satisfy the rule for the current financial
 * year. Admin-only — RLS on the SIE tables enforces this server-side too.
 */

interface MatchRow {
  customerId: string
  customerName: string
  fortnoxCustomerNumber: string | null
  value: number | null
}

const KR_FORMATTER = new Intl.NumberFormat("sv-SE", {
  maximumFractionDigits: 0,
})

function formatValue(value: number | null, unit: HitListUnit): string {
  if (value == null || !Number.isFinite(value)) return "—"
  if (unit === "kr") return `${KR_FORMATTER.format(value)} kr`
  if (unit === "%") return `${value.toLocaleString("sv-SE", { maximumFractionDigits: 1 })} %`
  return value.toLocaleString("sv-SE", { maximumFractionDigits: 1 })
}

export default function HitListPage() {
  const { isAdmin } = useUser()
  const { t, language } = useTranslation()

  const [matchesByRule, setMatchesByRule] = React.useState<
    Record<string, MatchRow[]>
  >({})
  const [loading, setLoading] = React.useState(true)
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({})

  const currentYear = new Date().getFullYear()
  const yearFrom = `${currentYear}-01-01`
  const hasAccess = isAdmin

  React.useEffect(() => {
    if (!hasAccess) {
      setLoading(false)
      return
    }
    let cancelled = false

    void (async () => {
      setLoading(true)
      const supabase = createClient()

      // Distinct accounts and KPI keys across all rules — one query each.
      const accounts = accountsForRules(HIT_LIST_RULES)
      const kpiKeys = kpiKeysForRules(HIT_LIST_RULES)

      // customerId → financials (account balances + YEAR KPI values).
      const finByCustomer = new Map<string, CustomerFinancials>()
      const finFor = (customerId: string): CustomerFinancials => {
        let fin = finByCustomer.get(customerId)
        if (!fin) {
          fin = { accounts: new Map(), kpis: new Map() }
          finByCustomer.set(customerId, fin)
        }
        return fin
      }

      const [balanceRes, kpiRes] = await Promise.all([
        accounts.length > 0
          ? supabase
              .from("sie_account_balances")
              .select("customer_id, account_number, kind, amount")
              .eq("financial_year_from", yearFrom)
              .in("kind", ["ub", "ib"])
              .in("account_number", accounts)
          : Promise.resolve({ data: [], error: null }),
        kpiKeys.length > 0
          ? supabase
              .from("sie_kpis")
              .select("customer_id, kpi_key, value")
              .eq("financial_year_from", yearFrom)
              .eq("period", "YEAR")
              .in("kpi_key", kpiKeys)
          : Promise.resolve({ data: [], error: null }),
      ])

      if (cancelled) return

      if (balanceRes.error || kpiRes.error) {
        console.error(
          "[hit-list] failed to load SIE data:",
          balanceRes.error ?? kpiRes.error,
        )
        setMatchesByRule({})
        setLoading(false)
        return
      }

      for (const row of (balanceRes.data ?? []) as Array<{
        customer_id: string
        account_number: string
        kind: string
        amount: number | string | null
      }>) {
        const accountMap = finFor(row.customer_id).accounts
        let entry = accountMap.get(row.account_number)
        if (!entry) {
          entry = { ub: null, ib: null }
          accountMap.set(row.account_number, entry)
        }
        const amount = row.amount == null ? null : Number(row.amount)
        if (row.kind === "ub") entry.ub = amount
        else if (row.kind === "ib") entry.ib = amount
      }

      for (const row of (kpiRes.data ?? []) as Array<{
        customer_id: string
        kpi_key: string
        value: number | string | null
      }>) {
        finFor(row.customer_id).kpis.set(
          row.kpi_key,
          row.value == null ? null : Number(row.value),
        )
      }

      // Evaluate every rule against every customer's financials.
      const rawMatches: Record<
        string,
        Array<{ customerId: string; value: number | null }>
      > = {}
      const matchedCustomerIds = new Set<string>()
      for (const rule of HIT_LIST_RULES) {
        const list: Array<{ customerId: string; value: number | null }> = []
        for (const [customerId, fin] of finByCustomer) {
          if (!ruleMatches(rule, fin)) continue
          list.push({ customerId, value: resolveValue(rule.displayValue, fin) })
          matchedCustomerIds.add(customerId)
        }
        rawMatches[rule.key] = list
      }

      // Resolve names for all matched customers in one query.
      const nameById = new Map<
        string,
        { name: string; fortnoxCustomerNumber: string | null }
      >()
      if (matchedCustomerIds.size > 0) {
        const { data: customerData } = await supabase
          .from("customers")
          .select("id, name, fortnox_customer_number")
          .in("id", Array.from(matchedCustomerIds))

        if (cancelled) return

        for (const c of (customerData ?? []) as Array<{
          id: string
          name: string
          fortnox_customer_number: string | null
        }>) {
          nameById.set(c.id, {
            name: c.name,
            fortnoxCustomerNumber: c.fortnox_customer_number,
          })
        }
      }

      const resolved: Record<string, MatchRow[]> = {}
      for (const rule of HIT_LIST_RULES) {
        const dir = rule.sort === "asc" ? 1 : -1
        resolved[rule.key] = (rawMatches[rule.key] ?? [])
          .map((m) => {
            const info = nameById.get(m.customerId)
            return {
              customerId: m.customerId,
              customerName: info?.name ?? "—",
              fortnoxCustomerNumber: info?.fortnoxCustomerNumber ?? null,
              value: m.value,
            }
          })
          .sort((a, b) => ((a.value ?? 0) - (b.value ?? 0)) * dir)
      }

      setMatchesByRule(resolved)
      setLoading(false)
    })()

    return () => {
      cancelled = true
    }
  }, [hasAccess, yearFrom])

  if (!hasAccess) {
    return (
      <div className="rounded-md border bg-muted/20 p-8 text-center text-sm text-muted-foreground">
        {t(
          "hitList.noAccess",
          "You don't have access to the hit list. Ask an admin to grant access.",
        )}
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <Target className="size-5 text-muted-foreground" />
          {t("hitList.title", "Hit list")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t(
            "hitList.subtitle",
            "Financial warnings and opportunities scoped from synced SIE files.",
          )}
        </p>
      </div>

      {loading ? (
        <div className="divide-y overflow-hidden rounded-md border">
          {HIT_LIST_RULES.map((rule) => (
            <div key={rule.key} className="px-4 py-3">
              <Skeleton className="h-9 w-full" />
            </div>
          ))}
        </div>
      ) : (
        <div className="divide-y overflow-hidden rounded-md border">
          {HIT_LIST_RULES.map((rule) => (
            <HitListRow
              key={rule.key}
              rule={rule}
              matches={matchesByRule[rule.key] ?? []}
              open={expanded[rule.key] ?? false}
              onToggle={() =>
                setExpanded((prev) => ({ ...prev, [rule.key]: !prev[rule.key] }))
              }
              language={language}
              t={t}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function HitListRow({
  rule,
  matches,
  open,
  onToggle,
  language,
  t,
}: {
  rule: HitListRule
  matches: MatchRow[]
  open: boolean
  onToggle: () => void
  language: "sv" | "en"
  t: (key: string, fallback?: string) => string
}) {
  const count = matches.length

  return (
    <div className={cn("transition-colors", count > 0 && "bg-semantic-warning/[0.04]")}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/40"
      >
        <ChevronRight
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        <AlertTriangle
          className={cn(
            "size-4 shrink-0",
            count > 0 ? "text-semantic-warning" : "text-muted-foreground",
          )}
        />
        <div className="min-w-0 flex-1">
          <span className="text-sm font-medium">{rule.names[language]}</span>
          <span className="ml-2 text-xs text-muted-foreground">
            {rule.summary[language]}
          </span>
        </div>
        <Badge
          variant="outline"
          className={cn(
            "shrink-0 tabular-nums",
            count > 0 && "border-semantic-warning text-semantic-warning",
          )}
        >
          {count}{" "}
          {count === 1
            ? t("hitList.companySingular", "company")
            : t("hitList.companyPlural", "companies")}
        </Badge>
      </button>

      {open ? (
        <div className="border-t bg-muted/20">
          {/* Possible advisory services */}
          <div className="px-4 py-3 pl-11">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t("hitList.section.services", "Possible advisory services")}
            </h4>
            <ul className="mt-1.5 flex flex-wrap gap-1.5">
              {rule.advisoryServices[language].map((service, i) => (
                <li key={i}>
                  <Badge variant="secondary" className="font-normal">
                    {service}
                  </Badge>
                </li>
              ))}
            </ul>
          </div>

          {count === 0 ? (
            <p className="border-t px-4 py-4 pl-11 text-sm text-muted-foreground">
              {t(
                "hitList.noMatches",
                "No companies match this rule for the current year.",
              )}
            </p>
          ) : (
            <div className="border-t">
              {/* Column header */}
              <div className="flex items-center gap-3 border-b bg-muted/40 py-2 pl-11 pr-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <span className="flex-1">
                  {t("hitList.columns.company", "Company")}
                </span>
                <span className="w-40 text-right">{rule.valueLabel[language]}</span>
                <span className="w-6" />
              </div>
              <div className="divide-y">
                {matches.map((m) => (
                  <div
                    key={m.customerId}
                    className="flex items-center gap-3 py-2 pl-11 pr-4"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">
                        {m.customerName}
                      </div>
                      {m.fortnoxCustomerNumber ? (
                        <div className="text-xs text-muted-foreground">
                          Fortnox #{m.fortnoxCustomerNumber}
                        </div>
                      ) : null}
                    </div>
                    <div className="w-40 text-right text-sm tabular-nums">
                      {formatValue(m.value, rule.valueUnit)}
                    </div>
                    <Link
                      href={`/key-metrics/${m.customerId}`}
                      className="flex w-6 shrink-0 justify-end text-muted-foreground hover:text-foreground"
                      aria-label={t("hitList.openKeyMetrics", "Open key metrics")}
                      title={t("hitList.openKeyMetrics", "Open key metrics")}
                    >
                      <ArrowRight className="size-4" />
                    </Link>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}
