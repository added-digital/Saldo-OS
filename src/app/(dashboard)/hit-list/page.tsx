"use client"

import * as React from "react"
import Link from "next/link"
import { AlertTriangle, ChevronRight, Target } from "lucide-react"
import { toast } from "sonner"

import { createClient } from "@/lib/supabase/client"
import { cn } from "@/lib/utils"
import { useTranslation } from "@/hooks/use-translation"
import { useUser } from "@/hooks/use-user"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
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

// Stored handling status for a company under a given rule. "none" is the
// default and is represented by the absence of a hit_list_statuses row.
type HitStatus = "under_hantering" | "hanterad"
// Sentinel used as the Select value for the "no status" option — Radix Select
// can't use an empty string as an item value.
const STATUS_NONE = "none"

// State key: one status per (rule, customer) pair.
function statusKey(ruleKey: string, customerId: string): string {
  return `${ruleKey}|${customerId}`
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
  const { isAdmin, user } = useUser()
  const { t, language } = useTranslation()

  const [matchesByRule, setMatchesByRule] = React.useState<
    Record<string, MatchRow[]>
  >({})
  const [statuses, setStatuses] = React.useState<Record<string, HitStatus>>({})
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

      // Load any saved handling statuses for the matched companies. Scoped by
      // customer; we key the resulting map per (rule, customer). Absence of a
      // row means "no status".
      const statusMap: Record<string, HitStatus> = {}
      if (matchedCustomerIds.size > 0) {
        const { data: statusData, error: statusError } = await supabase
          .from("hit_list_statuses")
          .select("customer_id, rule_key, status")
          .in("customer_id", Array.from(matchedCustomerIds))

        if (cancelled) return

        if (statusError) {
          // Non-fatal: the list still works, statuses just start blank.
          console.error("[hit-list] failed to load statuses:", statusError)
        } else {
          for (const row of (statusData ?? []) as Array<{
            customer_id: string
            rule_key: string
            status: HitStatus
          }>) {
            statusMap[statusKey(row.rule_key, row.customer_id)] = row.status
          }
        }
      }

      setStatuses(statusMap)
      setMatchesByRule(resolved)
      setLoading(false)
    })()

    return () => {
      cancelled = true
    }
  }, [hasAccess, yearFrom])

  // Persist a status change for one company under one rule. Optimistic: we
  // update local state immediately, then upsert (or delete, for "none") and
  // roll back on failure. Writes go straight through the browser client —
  // admin-only RLS on hit_list_statuses authorizes them.
  const updateStatus = React.useCallback(
    async (ruleKey: string, customerId: string, next: HitStatus | "none") => {
      const key = statusKey(ruleKey, customerId)
      const previous = statuses[key]

      setStatuses((prev) => {
        const copy = { ...prev }
        if (next === STATUS_NONE) delete copy[key]
        else copy[key] = next
        return copy
      })

      const supabase = createClient()
      try {
        if (next === STATUS_NONE) {
          const { error } = await supabase
            .from("hit_list_statuses")
            .delete()
            .eq("customer_id", customerId)
            .eq("rule_key", ruleKey)
          if (error) throw error
        } else {
          const { error } = await supabase.from("hit_list_statuses").upsert(
            {
              customer_id: customerId,
              rule_key: ruleKey,
              status: next,
              updated_by: user.id,
            } as never,
            { onConflict: "customer_id,rule_key" } as never,
          )
          if (error) throw error
        }
      } catch (err) {
        // Roll back to the previous value on failure.
        setStatuses((prev) => {
          const copy = { ...prev }
          if (previous) copy[key] = previous
          else delete copy[key]
          return copy
        })
        toast.error(
          `${t("hitList.status.saveFailed", "Failed to save status")}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    },
    [statuses, user.id, t],
  )

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
              statuses={statuses}
              onStatusChange={updateStatus}
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
  statuses,
  onStatusChange,
  open,
  onToggle,
  language,
  t,
}: {
  rule: HitListRule
  matches: MatchRow[]
  statuses: Record<string, HitStatus>
  onStatusChange: (
    ruleKey: string,
    customerId: string,
    next: HitStatus | "none",
  ) => void
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
            <div className="px-4 pb-4 pl-11">
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="min-w-[200px]">
                        {t("hitList.columns.company", "Company")}
                      </TableHead>
                      <TableHead className="text-right whitespace-nowrap">
                        {rule.valueLabel[language]}
                      </TableHead>
                      <TableHead className="w-48">
                        {t("hitList.columns.status", "Status")}
                      </TableHead>
                      <TableHead className="w-[44px]" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {matches.map((m) => (
                      <TableRow key={m.customerId}>
                        <TableCell>
                          <Link
                            href={`/key-metrics/${m.customerId}`}
                            className="font-medium hover:underline"
                          >
                            {m.customerName}
                          </Link>
                          {m.fortnoxCustomerNumber ? (
                            <div className="text-xs text-muted-foreground">
                              #{m.fortnoxCustomerNumber}
                            </div>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-right whitespace-nowrap tabular-nums">
                          {formatValue(m.value, rule.valueUnit)}
                        </TableCell>
                        <TableCell>
                          <StatusPicker
                            value={statuses[statusKey(rule.key, m.customerId)]}
                            onChange={(next) =>
                              onStatusChange(rule.key, m.customerId, next)
                            }
                            t={t}
                          />
                        </TableCell>
                        <TableCell className="w-[44px] text-right">
                          <Link
                            href={`/key-metrics/${m.customerId}`}
                            aria-label={t(
                              "hitList.openKeyMetrics",
                              "Open key metrics",
                            )}
                            className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                          >
                            <ChevronRight className="size-4" />
                          </Link>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}

function StatusPicker({
  value,
  onChange,
  t,
}: {
  value: HitStatus | undefined
  onChange: (next: HitStatus | "none") => void
  t: (key: string, fallback?: string) => string
}) {
  return (
    <Select
      value={value ?? STATUS_NONE}
      onValueChange={(next) => onChange(next as HitStatus | "none")}
    >
      <SelectTrigger
        size="sm"
        className={cn(
          "h-8 w-full",
          value === "hanterad" &&
            "border-semantic-success/40 text-semantic-success",
          value === "under_hantering" &&
            "border-semantic-warning/40 text-semantic-warning",
        )}
        // Sits inside an expandable rule row — stop the toggle from firing.
        onClick={(event) => event.stopPropagation()}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={STATUS_NONE}>
          <span className="text-muted-foreground">
            {t("hitList.status.none", "No status")}
          </span>
        </SelectItem>
        <SelectItem value="under_hantering">
          {t("hitList.status.underHantering", "Under hantering")}
        </SelectItem>
        <SelectItem value="hanterad">
          {t("hitList.status.hanterad", "Hanterad")}
        </SelectItem>
      </SelectContent>
    </Select>
  )
}
