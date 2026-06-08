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
import { Button } from "@/components/ui/button"
import { SearchInput } from "@/components/app/search-input"

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
  consultantId: string | null
  consultantName: string | null
  costCenter: string | null
}

// Stored handling status for a company under a given rule. "none" is the
// default and is represented by a NULL status (or no row at all).
type HitStatus = "under_hantering" | "hanterad"
// Manually set priority for a company under a given rule, stored alongside
// the status in hit_list_statuses. "none" = NULL / no row.
type HitPriority = "high" | "medium" | "low"
// Sentinel used as the Select value for the "no status"/"no priority"
// options — Radix Select can't use an empty string as an item value.
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
  const [priorities, setPriorities] = React.useState<Record<string, HitPriority>>({})
  const [loading, setLoading] = React.useState(true)
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({})

  // Toolbar filters.
  const [searchQuery, setSearchQuery] = React.useState("")
  const [consultantFilter, setConsultantFilter] = React.useState("all")
  const [priorityFilter, setPriorityFilter] = React.useState<HitPriority | typeof STATUS_NONE | "all">("all")
  const [statusFilter, setStatusFilter] = React.useState<HitStatus | typeof STATUS_NONE | "all">("all")
  const [clientScope, setClientScope] = React.useState<"all" | "mine">("all")

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

      // Resolve names + consultant (customer manager) for all matched
      // customers. Consultants are resolved the same way as on /customers:
      // customers.fortnox_cost_center → profiles.fortnox_cost_center.
      const nameById = new Map<
        string,
        {
          name: string
          fortnoxCustomerNumber: string | null
          costCenter: string | null
        }
      >()
      const consultantByCostCenter = new Map<
        string,
        { id: string; name: string }
      >()
      if (matchedCustomerIds.size > 0) {
        const [{ data: customerData }, { data: profileData }] =
          await Promise.all([
            supabase
              .from("customers")
              .select("id, name, fortnox_customer_number, fortnox_cost_center")
              .in("id", Array.from(matchedCustomerIds)),
            supabase
              .from("profiles")
              .select("id, full_name, email, fortnox_cost_center")
              .eq("is_active", true)
              .not("fortnox_cost_center", "is", null),
          ])

        if (cancelled) return

        for (const p of (profileData ?? []) as Array<{
          id: string
          full_name: string | null
          email: string
          fortnox_cost_center: string
        }>) {
          consultantByCostCenter.set(p.fortnox_cost_center, {
            id: p.id,
            name: p.full_name ?? p.email,
          })
        }

        for (const c of (customerData ?? []) as Array<{
          id: string
          name: string
          fortnox_customer_number: string | null
          fortnox_cost_center: string | null
        }>) {
          nameById.set(c.id, {
            name: c.name,
            fortnoxCustomerNumber: c.fortnox_customer_number,
            costCenter: c.fortnox_cost_center,
          })
        }
      }

      const resolved: Record<string, MatchRow[]> = {}
      for (const rule of HIT_LIST_RULES) {
        const dir = rule.sort === "asc" ? 1 : -1
        resolved[rule.key] = (rawMatches[rule.key] ?? [])
          .map((m) => {
            const info = nameById.get(m.customerId)
            const consultant = info?.costCenter
              ? consultantByCostCenter.get(info.costCenter) ?? null
              : null
            return {
              customerId: m.customerId,
              customerName: info?.name ?? "—",
              fortnoxCustomerNumber: info?.fortnoxCustomerNumber ?? null,
              value: m.value,
              consultantId: consultant?.id ?? null,
              consultantName: consultant?.name ?? null,
              costCenter: info?.costCenter ?? null,
            }
          })
          .sort((a, b) => ((a.value ?? 0) - (b.value ?? 0)) * dir)
      }

      // Load any saved handling statuses + priorities for the matched
      // companies. Keyed per (rule, customer). NULL / absent row means "no
      // status" / "no priority".
      const statusMap: Record<string, HitStatus> = {}
      const priorityMap: Record<string, HitPriority> = {}
      if (matchedCustomerIds.size > 0) {
        const { data: statusData, error: statusError } = await supabase
          .from("hit_list_statuses")
          .select("customer_id, rule_key, status, priority")
          .in("customer_id", Array.from(matchedCustomerIds))

        if (cancelled) return

        if (statusError) {
          // Non-fatal: the list still works, statuses just start blank.
          console.error("[hit-list] failed to load statuses:", statusError)
        } else {
          for (const row of (statusData ?? []) as Array<{
            customer_id: string
            rule_key: string
            status: HitStatus | null
            priority: HitPriority | null
          }>) {
            const key = statusKey(row.rule_key, row.customer_id)
            if (row.status) statusMap[key] = row.status
            if (row.priority) priorityMap[key] = row.priority
          }
        }
      }

      setStatuses(statusMap)
      setPriorities(priorityMap)
      setMatchesByRule(resolved)
      setLoading(false)
    })()

    return () => {
      cancelled = true
    }
  }, [hasAccess, yearFrom])

  // Persist a status or priority change for one company under one rule. Both
  // live on the same hit_list_statuses row, so we recompute the row from the
  // current maps: if both fields end up empty the row is deleted, otherwise
  // it's upserted. Optimistic with rollback. Admin-only RLS authorizes writes.
  const updateRow = React.useCallback(
    async (
      ruleKey: string,
      customerId: string,
      field: "status" | "priority",
      next: HitStatus | HitPriority | "none",
    ) => {
      const key = statusKey(ruleKey, customerId)
      const previousStatus = statuses[key]
      const previousPriority = priorities[key]

      const nextStatus =
        field === "status"
          ? next === STATUS_NONE
            ? undefined
            : (next as HitStatus)
          : previousStatus
      const nextPriority =
        field === "priority"
          ? next === STATUS_NONE
            ? undefined
            : (next as HitPriority)
          : previousPriority

      const setKeyed = (
        setter: React.Dispatch<React.SetStateAction<Record<string, never>>>,
        value: unknown,
      ) =>
        setter((prev) => {
          const copy = { ...prev } as Record<string, unknown>
          if (value === undefined) delete copy[key]
          else copy[key] = value
          return copy as Record<string, never>
        })

      setKeyed(setStatuses as never, nextStatus)
      setKeyed(setPriorities as never, nextPriority)

      const supabase = createClient()
      try {
        if (nextStatus === undefined && nextPriority === undefined) {
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
              status: nextStatus ?? null,
              priority: nextPriority ?? null,
              updated_by: user.id,
            } as never,
            { onConflict: "customer_id,rule_key" } as never,
          )
          if (error) throw error
        }
      } catch (err) {
        // Roll back both fields on failure.
        setKeyed(setStatuses as never, previousStatus)
        setKeyed(setPriorities as never, previousPriority)
        toast.error(
          `${t("hitList.status.saveFailed", "Failed to save")}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    },
    [statuses, priorities, user.id, t],
  )

  const updateStatus = React.useCallback(
    (ruleKey: string, customerId: string, next: HitStatus | "none") =>
      updateRow(ruleKey, customerId, "status", next),
    [updateRow],
  )

  const updatePriority = React.useCallback(
    (ruleKey: string, customerId: string, next: HitPriority | "none") =>
      updateRow(ruleKey, customerId, "priority", next),
    [updateRow],
  )

  // Distinct consultants across all matched companies (for the select).
  const consultants = React.useMemo(() => {
    const map = new Map<string, string>()
    for (const rows of Object.values(matchesByRule)) {
      for (const m of rows) {
        if (m.consultantId && m.consultantName && !map.has(m.consultantId)) {
          map.set(m.consultantId, m.consultantName)
        }
      }
    }
    return Array.from(map, ([id, name]) => ({ id, name })).sort((a, b) =>
      a.name.localeCompare(b.name)
    )
  }, [matchesByRule])

  // Rule-level filter: search (name/summary) hides whole rules.
  const visibleRules = React.useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return HIT_LIST_RULES
    return HIT_LIST_RULES.filter((rule) => {
      const haystack = `${rule.names[language]} ${rule.summary[language]}`.toLowerCase()
      return haystack.includes(q)
    })
  }, [searchQuery, language])

  // Company-level filters: consultant, priority, status and All/My Clients
  // narrow the matches inside each rule; rules stay visible with an updated
  // count.
  const filteredMatchesByRule = React.useMemo(() => {
    const result: Record<string, MatchRow[]> = {}
    for (const rule of HIT_LIST_RULES) {
      result[rule.key] = (matchesByRule[rule.key] ?? []).filter((m) => {
        const key = statusKey(rule.key, m.customerId)
        if (
          clientScope === "mine" &&
          (!user.fortnox_cost_center || m.costCenter !== user.fortnox_cost_center)
        ) {
          return false
        }
        if (consultantFilter !== "all" && m.consultantId !== consultantFilter) {
          return false
        }
        if (statusFilter !== "all") {
          const status = statuses[key]
          if (statusFilter === STATUS_NONE ? status !== undefined : status !== statusFilter) {
            return false
          }
        }
        if (priorityFilter !== "all") {
          const priority = priorities[key]
          if (priorityFilter === STATUS_NONE ? priority !== undefined : priority !== priorityFilter) {
            return false
          }
        }
        return true
      })
    }
    return result
  }, [
    matchesByRule,
    statuses,
    priorities,
    clientScope,
    consultantFilter,
    statusFilter,
    priorityFilter,
    user.fortnox_cost_center,
  ])

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

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <SearchInput
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder={t("hitList.filters.search", "Search lists...")}
          className="w-full lg:max-w-xs"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Select value={consultantFilter} onValueChange={setConsultantFilter}>
            <SelectTrigger size="sm" className="h-9 w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">
                {t("hitList.filters.allConsultants", "All Consultants")}
              </SelectItem>
              {consultants.map((consultant) => (
                <SelectItem key={consultant.id} value={consultant.id}>
                  {consultant.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={priorityFilter}
            onValueChange={(next) =>
              setPriorityFilter(next as HitPriority | typeof STATUS_NONE | "all")
            }
          >
            <SelectTrigger size="sm" className="h-9 w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">
                {t("hitList.filters.allPriorities", "All Priorities")}
              </SelectItem>
              <SelectItem value={STATUS_NONE}>
                {t("hitList.priority.none", "No priority")}
              </SelectItem>
              <SelectItem value="high">{t("hitList.priority.high", "High")}</SelectItem>
              <SelectItem value="medium">{t("hitList.priority.medium", "Medium")}</SelectItem>
              <SelectItem value="low">{t("hitList.priority.low", "Low")}</SelectItem>
            </SelectContent>
          </Select>

          <Select
            value={statusFilter}
            onValueChange={(next) =>
              setStatusFilter(next as HitStatus | typeof STATUS_NONE | "all")
            }
          >
            <SelectTrigger size="sm" className="h-9 w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">
                {t("hitList.filters.allStatuses", "All Statuses")}
              </SelectItem>
              <SelectItem value={STATUS_NONE}>
                {t("hitList.status.none", "No status")}
              </SelectItem>
              <SelectItem value="under_hantering">
                {t("hitList.status.underHantering", "Under hantering")}
              </SelectItem>
              <SelectItem value="hanterad">
                {t("hitList.status.hanterad", "Hanterad")}
              </SelectItem>
            </SelectContent>
          </Select>

          <div className="flex items-center rounded-md border p-0.5">
            <Button
              variant={clientScope === "all" ? "secondary" : "ghost"}
              size="sm"
              className="h-8 px-3 text-xs"
              onClick={() => setClientScope("all")}
            >
              {t("hitList.filters.scopeAll", "All")}
            </Button>
            <Button
              variant={clientScope === "mine" ? "secondary" : "ghost"}
              size="sm"
              className="h-8 px-3 text-xs"
              onClick={() => setClientScope("mine")}
            >
              {t("hitList.filters.scopeMine", "My Clients")}
            </Button>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="divide-y overflow-hidden rounded-md border">
          {HIT_LIST_RULES.map((rule) => (
            <div key={rule.key} className="px-4 py-3">
              <Skeleton className="h-9 w-full" />
            </div>
          ))}
        </div>
      ) : visibleRules.length === 0 ? (
        <div className="rounded-md border bg-muted/20 p-8 text-center text-sm text-muted-foreground">
          {t("hitList.filters.noRules", "No lists match your filters.")}
        </div>
      ) : (
        <div className="divide-y overflow-hidden rounded-md border">
          {visibleRules.map((rule) => (
            <HitListRow
              key={rule.key}
              rule={rule}
              matches={filteredMatchesByRule[rule.key] ?? []}
              statuses={statuses}
              priorities={priorities}
              onStatusChange={updateStatus}
              onPriorityChange={updatePriority}
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
  priorities,
  onStatusChange,
  onPriorityChange,
  open,
  onToggle,
  language,
  t,
}: {
  rule: HitListRule
  matches: MatchRow[]
  statuses: Record<string, HitStatus>
  priorities: Record<string, HitPriority>
  onStatusChange: (
    ruleKey: string,
    customerId: string,
    next: HitStatus | "none",
  ) => void
  onPriorityChange: (
    ruleKey: string,
    customerId: string,
    next: HitPriority | "none",
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
                      <TableHead className="min-w-[140px]">
                        {t("hitList.columns.consultant", "Consultant")}
                      </TableHead>
                      <TableHead className="text-right whitespace-nowrap">
                        {rule.valueLabel[language]}
                      </TableHead>
                      <TableHead className="w-40">
                        {t("hitList.columns.priority", "Priority")}
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
                        <TableCell>
                          {m.consultantName ?? (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right whitespace-nowrap tabular-nums">
                          {formatValue(m.value, rule.valueUnit)}
                        </TableCell>
                        <TableCell>
                          <PriorityPicker
                            value={priorities[statusKey(rule.key, m.customerId)]}
                            onChange={(next) =>
                              onPriorityChange(rule.key, m.customerId, next)
                            }
                            t={t}
                          />
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

function PriorityPicker({
  value,
  onChange,
  t,
}: {
  value: HitPriority | undefined
  onChange: (next: HitPriority | "none") => void
  t: (key: string, fallback?: string) => string
}) {
  return (
    <Select
      value={value ?? STATUS_NONE}
      onValueChange={(next) => onChange(next as HitPriority | "none")}
    >
      <SelectTrigger
        size="sm"
        className={cn(
          "h-8 w-full",
          value === "high" && "border-semantic-error/40 text-semantic-error",
          value === "medium" && "border-semantic-warning/40 text-semantic-warning",
        )}
        // Sits inside an expandable rule row — stop the toggle from firing.
        onClick={(event) => event.stopPropagation()}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={STATUS_NONE}>
          <span className="text-muted-foreground">
            {t("hitList.priority.none", "No priority")}
          </span>
        </SelectItem>
        <SelectItem value="high">{t("hitList.priority.high", "High")}</SelectItem>
        <SelectItem value="medium">{t("hitList.priority.medium", "Medium")}</SelectItem>
        <SelectItem value="low">{t("hitList.priority.low", "Low")}</SelectItem>
      </SelectContent>
    </Select>
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
