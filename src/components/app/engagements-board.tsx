"use client"

import * as React from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Plus, CalendarClock, Building2, User as UserIcon, Search, AlertTriangle, ClipboardList, CheckCircle2, RotateCcw, Check, ChevronDown } from "lucide-react"
import { toast } from "sonner"

import { createClient } from "@/lib/supabase/client"
import { cn } from "@/lib/utils"
import { useTranslation } from "@/hooks/use-translation"
import { useUser } from "@/hooks/use-user"
import type {
  EngagementBoardRow,
  EngagementChecklistField,
  EngagementStatus,
  EngagementWorkflow,
} from "@/types/engagement"
import { PageHeader } from "@/components/app/page-header"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { EngagementCreateDialog } from "@/components/app/engagement-create-dialog"
import { EngagementDetailSheet } from "@/components/app/engagement-detail-sheet"

const ALL = "all"
const NO_STATUS = "none"

type Consultant = { id: string; name: string }

function statusFieldsFor(workflow: EngagementWorkflow) {
  return workflow === "bokslut"
    ? {
        id: "bokslut_status_id",
        key: "bokslut_status_key",
        label: "bokslut_status_label",
        sort: "bokslut_status_sort",
        done: "bokslut_status_is_done",
        changed: "bokslut_status_changed_at",
      }
    : {
        id: "ink2_status_id",
        key: "ink2_status_key",
        label: "ink2_status_label",
        sort: "ink2_status_sort",
        done: "ink2_status_is_done",
        changed: "ink2_status_changed_at",
      }
}

/** Set a status onto a row's denormalized board fields (optimistic update). */
function applyStatus(
  row: EngagementBoardRow,
  workflow: EngagementWorkflow,
  status: EngagementStatus | null,
): EngagementBoardRow {
  const now = new Date().toISOString()
  if (workflow === "bokslut") {
    const next = {
      ...row,
      bokslut_status_id: status?.id ?? null,
      bokslut_status_key: status?.key ?? null,
      bokslut_status_label: status?.label ?? null,
      bokslut_status_sort: status?.sort_order ?? null,
      bokslut_status_is_done: status?.is_done ?? null,
      bokslut_status_changed_at: now,
    }
    next.is_overdue = Boolean(next.deadline && new Date(next.deadline) < new Date() && !next.bokslut_status_is_done)
    return next
  }
  return {
    ...row,
    ink2_status_id: status?.id ?? null,
    ink2_status_key: status?.key ?? null,
    ink2_status_label: status?.label ?? null,
    ink2_status_sort: status?.sort_order ?? null,
    ink2_status_is_done: status?.is_done ?? null,
    ink2_status_changed_at: now,
  }
}

export function EngagementsBoard() {
  const { t } = useTranslation()
  const { user } = useUser()
  const router = useRouter()
  const searchParams = useSearchParams()
  const [loading, setLoading] = React.useState(true)
  const [statuses, setStatuses] = React.useState<EngagementStatus[]>([])
  const [rows, setRows] = React.useState<EngagementBoardRow[]>([])
  const [consultants, setConsultants] = React.useState<Consultant[]>([])
  const [defaultFiscalYearEnd, setDefaultFiscalYearEnd] = React.useState("2025-12-31")
  const [checklistFields, setChecklistFields] = React.useState<EngagementChecklistField[]>([])

  const [workflow, setWorkflow] = React.useState<EngagementWorkflow>("bokslut")
  const [filterConsultant, setFilterConsultant] = React.useState<string>(ALL)
  const [filterGroup, setFilterGroup] = React.useState<string>(ALL)
  const [filterYear, setFilterYear] = React.useState<string>(ALL)
  const [filterCustomer, setFilterCustomer] = React.useState<string>("")
  const [filterOverdue, setFilterOverdue] = React.useState<boolean>(false)
  const [clearedMode, setClearedMode] = React.useState<"hide" | "show" | "only">("hide")

  const [draggingId, setDraggingId] = React.useState<string | null>(null)
  const [dragOverCol, setDragOverCol] = React.useState<string | null>(null)
  const [detailId, setDetailId] = React.useState<string | null>(null)
  const [createOpen, setCreateOpen] = React.useState(false)
  const [createForCustomerId, setCreateForCustomerId] = React.useState<string | undefined>(undefined)
  const [missingOpen, setMissingOpen] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      const supabase = createClient()
      const [statusRes, boardRes, profRes, configRes] = await Promise.all([
        supabase.from("engagement_statuses").select("*").order("workflow").order("sort_order"),
        supabase.from("engagement_board").select("*"),
        supabase.from("profiles").select("id, full_name, email").eq("is_active", true).order("full_name").limit(500),
        supabase.from("engagement_config").select("active_fiscal_year_end, checklist_fields").eq("id", 1).maybeSingle(),
      ])
      if (cancelled) return
      setStatuses((statusRes.data ?? []) as EngagementStatus[])
      setRows((boardRes.data ?? []) as EngagementBoardRow[])
      setConsultants(
        ((profRes.data ?? []) as Array<{ id: string; full_name: string | null; email: string }>).map((p) => ({
          id: p.id,
          name: p.full_name ?? p.email,
        })),
      )
      const cfg = configRes.data as {
        active_fiscal_year_end: string
        checklist_fields: EngagementChecklistField[] | null
      } | null
      if (cfg?.active_fiscal_year_end) setDefaultFiscalYearEnd(cfg.active_fiscal_year_end)
      if (Array.isArray(cfg?.checklist_fields)) setChecklistFields(cfg.checklist_fields)
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Deep-link: open a specific engagement when arriving via ?engagement=<id>
  // (e.g. from a notification). Waits for the row to be present in the board.
  React.useEffect(() => {
    const target = searchParams.get("engagement")
    if (target && rows.some((r) => r.id === target)) {
      setDetailId(target)
    }
  }, [searchParams, rows])

  // Default-scope the board to the logged-in user's own bokslut: once rows
  // load, if the current user is the consultant on any engagement, preselect
  // them in the consultant filter. Applied once; the user can switch to All.
  const scopeAppliedRef = React.useRef(false)
  React.useEffect(() => {
    if (scopeAppliedRef.current || !user?.id || rows.length === 0) return
    scopeAppliedRef.current = true
    if (rows.some((r) => r.consultant_id === user.id || r.co_consultant_id === user.id)) {
      setFilterConsultant(user.id)
    }
  }, [user, rows])

  const userNames = React.useMemo(
    () => Object.fromEntries(consultants.map((c) => [c.id, c.name])),
    [consultants],
  )
  const statusById = React.useMemo(() => new Map(statuses.map((s) => [s.id, s])), [statuses])

  // Columns for the active workflow: "No status" first, then ordered stages.
  const columns = React.useMemo(() => {
    const ofWorkflow = statuses
      .filter((s) => s.workflow === workflow)
      .sort((a, b) => a.sort_order - b.sort_order)
    // "Ej aktuell" (is_parked) is a side bucket, not a pipeline stage. Park it
    // at the far right and de-emphasize it so the linear flow reads left→right
    // through the pipeline, with the parked bucket set apart at the end.
    const parked = ofWorkflow.filter((s) => s.is_parked)
    const active = ofWorkflow.filter((s) => !s.is_parked)
    return [
      { id: NO_STATUS, label: t("engagements.noStatus", "No status"), parked: false },
      ...active.map((s) => ({ id: s.id, label: s.label, parked: false })),
      ...parked.map((s) => ({ id: s.id, label: s.label, parked: true })),
    ]
  }, [statuses, workflow, t])

  // Distinct filter option lists derived from the loaded rows.
  const consultantOptions = React.useMemo(() => {
    const map = new Map<string, string>()
    for (const r of rows) {
      if (r.consultant_id) map.set(r.consultant_id, r.consultant_name ?? r.consultant_id)
      if (r.co_consultant_id) map.set(r.co_consultant_id, r.co_consultant_name ?? r.co_consultant_id)
    }
    return Array.from(map, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
  }, [rows])
  const groupOptions = React.useMemo(() => {
    const set = new Set<string>()
    for (const r of rows) if (r.group_name) set.add(r.group_name)
    return Array.from(set).sort()
  }, [rows])
  const yearOptions = React.useMemo(() => {
    const set = new Set<string>()
    for (const r of rows) set.add(r.fiscal_year_end)
    return Array.from(set).sort().reverse()
  }, [rows])

  // Deferred so typing in the search box stays responsive — the (heavier)
  // board filtering runs in a low-priority render, not on every keystroke.
  const deferredCustomer = React.useDeferredValue(filterCustomer)
  const customerQuery = deferredCustomer.trim().toLowerCase()
  // Everything except the overdue toggle, so the overdue count reflects the
  // current scope (consultant / group / year / cleared / search) without being
  // circular with the toggle itself.
  const scopedRows = React.useMemo(
    () =>
      rows.filter(
        (r) =>
          (filterConsultant === ALL ||
            r.consultant_id === filterConsultant ||
            r.co_consultant_id === filterConsultant) &&
          (filterGroup === ALL || r.group_name === filterGroup) &&
          (filterYear === ALL || r.fiscal_year_end === filterYear) &&
          (clearedMode === "show" ||
            (clearedMode === "hide" && !r.cleared_at) ||
            (clearedMode === "only" && !!r.cleared_at)) &&
          (customerQuery === "" || r.customer_name.toLowerCase().includes(customerQuery)),
      ),
    [rows, filterConsultant, filterGroup, filterYear, clearedMode, customerQuery],
  )

  const filteredRows = React.useMemo(
    () => (filterOverdue ? scopedRows.filter((r) => r.is_overdue) : scopedRows),
    [scopedRows, filterOverdue],
  )

  const overdueCount = React.useMemo(
    () => scopedRows.filter((r) => r.is_overdue).length,
    [scopedRows],
  )

  const filtersActive =
    filterConsultant !== ALL ||
    filterGroup !== ALL ||
    filterYear !== ALL ||
    filterCustomer.trim() !== "" ||
    filterOverdue ||
    clearedMode !== "hide"

  const resetFilters = React.useCallback(() => {
    React.startTransition(() => {
      setFilterConsultant(ALL)
      setFilterGroup(ALL)
      setFilterYear(ALL)
      setFilterCustomer("")
      setFilterOverdue(false)
      setClearedMode("hide")
    })
  }, [])
  // Customers that already have at least one engagement on the board.
  const engagedCustomerIds = React.useMemo(
    () => new Set(rows.map((r) => r.customer_id)),
    [rows],
  )

  const rowsByColumn = React.useMemo(() => {
    const map = new Map<string, EngagementBoardRow[]>()
    for (const col of columns) map.set(col.id, [])
    for (const r of filteredRows) {
      const statusId = workflow === "bokslut" ? r.bokslut_status_id : r.ink2_status_id
      const key = statusId ?? NO_STATUS
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(r)
    }
    return map
  }, [columns, filteredRows, workflow])

  const detailRow = detailId ? rows.find((r) => r.id === detailId) ?? null : null

  // Stable handlers so memoized cards don't re-render on every board update
  // (e.g. opening the detail sheet). Card calls these with its own row id.
  // Defer the heavy detail-sheet mount into a transition so the click paints
  // immediately (keeps INP low); the sheet then renders without blocking.
  const handleCardClick = React.useCallback((id: string) => {
    React.startTransition(() => setDetailId(id))
  }, [])
  const handleCardDragStart = React.useCallback((id: string) => setDraggingId(id), [])
  const handleCardDragEnd = React.useCallback(() => {
    setDraggingId(null)
    setDragOverCol(null)
  }, [])
  const overdueLabel = t("engagements.overdue", "Overdue")
  const clearLabels = React.useMemo(
    () => ({
      mark: t("engagements.clear.mark", "Mark as cleared"),
      restore: t("engagements.clear.restore", "Restore to board"),
      badge: t("engagements.clear.badge", "Cleared"),
    }),
    [t],
  )

  // Toggle an engagement's cleared state (optimistic). rowsRef keeps the
  // handler stable so memoized cards don't re-render on every board update.
  const rowsRef = React.useRef(rows)
  rowsRef.current = rows
  const handleToggleCleared = React.useCallback(
    (id: string) => {
      const row = rowsRef.current.find((r) => r.id === id)
      if (!row) return
      const next = row.cleared_at ? null : new Date().toISOString()
      const snapshot = rowsRef.current
      setRows((prev) => prev.map((r) => (r.id === id ? { ...r, cleared_at: next } : r)))
      void (async () => {
        const supabase = createClient()
        const { error } = await supabase
          .from("engagements")
          .update({ cleared_at: next } as never)
          .eq("id", id)
        if (error) {
          setRows(snapshot)
          toast.error(`${t("engagements.toast.error", "Couldn't update engagement")}: ${error.message}`)
          return
        }
        if (next) {
          toast.success(t("engagements.clear.toastCleared", "Cleared and hidden from the board"), {
            action: {
              label: t("engagements.clear.undo", "Undo"),
              onClick: () => handleToggleCleared(id),
            },
          })
        } else {
          toast.success(t("engagements.clear.toastRestored", "Restored to the board"))
        }
      })()
    },
    [t],
  )

  async function moveEngagement(id: string, toStatusId: string | null) {
    const row = rows.find((r) => r.id === id)
    if (!row) return
    const currentId = workflow === "bokslut" ? row.bokslut_status_id : row.ink2_status_id
    if (currentId === toStatusId) return

    const snapshot = rows
    const status = toStatusId ? statusById.get(toStatusId) ?? null : null
    setRows((prev) => prev.map((r) => (r.id === id ? applyStatus(r, workflow, status) : r)))

    const supabase = createClient()
    const field = statusFieldsFor(workflow).id
    const { error } = await supabase
      .from("engagements")
      .update({ [field]: toStatusId } as never)
      .eq("id", id)

    if (error) {
      setRows(snapshot) // revert
      toast.error(`${t("engagements.toast.error", "Couldn't update engagement")}: ${error.message}`)
    }
  }

  function handleDrop(columnId: string) {
    const id = draggingId
    setDraggingId(null)
    setDragOverCol(null)
    if (!id) return
    void moveEngagement(id, columnId === NO_STATUS ? null : columnId)
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <PageHeader
        title={t("engagements.title", "Engagements")}
        description={t("engagements.description", "Year-end close and tax declaration workflow per client.")}
      >
        <Button
          size="sm"
          variant="outline"
          onClick={() => React.startTransition(() => setMissingOpen(true))}
        >
          <ClipboardList className="size-4" />
          {t("engagements.missing.button", "Without bokslut")}
        </Button>
        <Button
          size="sm"
          onClick={() =>
            React.startTransition(() => {
              setCreateForCustomerId(undefined)
              setCreateOpen(true)
            })
          }
        >
          <Plus className="size-4" />
          {t("engagements.new", "New engagement")}
        </Button>
      </PageHeader>

      {/* Controls: workflow toggle + filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-md border p-0.5">
          {(["bokslut", "ink2"] as const).map((wf) => (
            <button
              key={wf}
              type="button"
              onClick={() => React.startTransition(() => setWorkflow(wf))}
              className={cn(
                "cursor-pointer rounded px-3 py-1 text-sm font-medium transition-colors",
                workflow === wf ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {wf === "bokslut" ? "Bokslut" : "INK2"}
            </button>
          ))}
        </div>

        <div className="relative w-full sm:w-[220px]">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filterCustomer}
            onChange={(e) => setFilterCustomer(e.target.value)}
            placeholder={t("engagements.filter.customer", "Search customer…")}
            className="h-8 pl-8"
          />
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant={filterOverdue ? "default" : "outline"}
            onClick={() => React.startTransition(() => setFilterOverdue((v) => !v))}
            aria-pressed={filterOverdue}
          >
            <AlertTriangle className="size-4" />
            {t("engagements.filter.overdue", "Overdue")}
            {overdueCount > 0 ? (
              <Badge
                variant={filterOverdue ? "secondary" : "outline"}
                className="ml-1 text-[10px]"
              >
                {overdueCount}
              </Badge>
            ) : null}
          </Button>
          <ManagerFilter
            value={filterGroup}
            onChange={(v) => React.startTransition(() => setFilterGroup(v))}
            allLabel={t("reports.filters.allTeams", "All teams")}
            searchPlaceholder={t("reports.filters.searchTeams", "Search teams...")}
            options={groupOptions.map((g) => ({ id: g, name: g }))}
          />
          <ManagerFilter
            value={filterConsultant}
            onChange={(v) => React.startTransition(() => setFilterConsultant(v))}
            allLabel={t("reports.filters.allCustomerManagers", "All customer managers")}
            searchPlaceholder={t("reports.filters.searchCustomerManagers", "Search customer managers...")}
            options={consultantOptions}
          />
          <FilterSelect
            value={filterYear}
            onChange={(v) => React.startTransition(() => setFilterYear(v))}
            allLabel={t("engagements.filter.year", "Fiscal year")}
            options={yearOptions.map((y) => ({ value: y, label: y }))}
          />
          <Select
            value={clearedMode}
            onValueChange={(v) => React.startTransition(() => setClearedMode(v as typeof clearedMode))}
          >
            <SelectTrigger size="sm" className="w-[150px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="hide">{t("engagements.filter.cleared.hide", "Hide cleared")}</SelectItem>
              <SelectItem value="show">{t("engagements.filter.cleared.show", "Show cleared")}</SelectItem>
              <SelectItem value="only">{t("engagements.filter.cleared.only", "Only cleared")}</SelectItem>
            </SelectContent>
          </Select>
          {filtersActive ? (
            <Button type="button" size="sm" variant="ghost" onClick={resetFilters}>
              <RotateCcw className="size-4" />
              {t("engagements.filter.reset", "Reset filters")}
            </Button>
          ) : null}
        </div>
      </div>

      {loading ? (
        <div className="flex gap-3 overflow-hidden">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-64 w-[260px] shrink-0 rounded-lg" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-md border bg-muted/20 p-10 text-center text-sm text-muted-foreground">
          {t("engagements.empty", "No engagements yet. Create one to get started.")}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-2">
          {columns.map((col) => {
            const colRows = rowsByColumn.get(col.id) ?? []
            return (
              <div
                key={col.id}
                onDragOver={(e) => {
                  e.preventDefault()
                  setDragOverCol(col.id)
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                    setDragOverCol((cur) => (cur === col.id ? null : cur))
                  }
                }}
                onDrop={() => handleDrop(col.id)}
                className={cn(
                  "flex w-[270px] shrink-0 flex-col rounded-lg border bg-muted/20 transition-colors",
                  dragOverCol === col.id && "border-primary bg-primary/5",
                  // Parked ("Ej aktuell"): set apart at the end of the pipeline —
                  // dashed, transparent, de-emphasized, with a gap before it.
                  col.parked && "ml-3 border-dashed bg-transparent opacity-70",
                )}
              >
                <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
                  <span
                    className={cn(
                      "truncate text-sm font-medium",
                      col.parked && "text-muted-foreground",
                    )}
                  >
                    {col.label}
                  </span>
                  <Badge variant="outline" className="shrink-0 text-[11px]">
                    {colRows.length}
                  </Badge>
                </div>
                <div className="flex min-h-[40px] flex-1 flex-col gap-2 overflow-y-auto p-2">
                  {colRows.map((row) => {
                    const isDone =
                      workflow === "bokslut" ? row.bokslut_status_is_done : row.ink2_status_is_done
                    return (
                      <EngagementCard
                        key={row.id}
                        row={row}
                        dragging={draggingId === row.id}
                        cleared={!!row.cleared_at}
                        canClear={Boolean(isDone) || !!row.cleared_at}
                        onToggleCleared={handleToggleCleared}
                        clearLabels={clearLabels}
                        onDragStart={handleCardDragStart}
                        onDragEnd={handleCardDragEnd}
                        onClick={handleCardClick}
                        overdueLabel={overdueLabel}
                      />
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <EngagementCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        defaultFiscalYearEnd={defaultFiscalYearEnd}
        presetCustomerId={createForCustomerId}
        onCreated={(row) => setRows((prev) => [row, ...prev])}
      />

      <MissingBokslutDialog
        open={missingOpen}
        onOpenChange={setMissingOpen}
        engagedCustomerIds={engagedCustomerIds}
        onCreateForCustomer={(id) =>
          React.startTransition(() => {
            setCreateForCustomerId(id)
            setMissingOpen(false)
            setCreateOpen(true)
          })
        }
      />

      <EngagementDetailSheet
        row={detailRow}
        statuses={statuses}
        consultants={consultants}
        checklistFields={checklistFields}
        userNames={userNames}
        open={detailId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDetailId(null)
            // Drop the deep-link param so the sheet doesn't re-open on re-render.
            if (searchParams.get("engagement")) router.replace("/bokslut")
          }
        }}
        onSaved={(updated) => setRows((prev) => prev.map((r) => (r.id === updated.id ? updated : r)))}
        onDeleted={(id) => {
          setRows((prev) => prev.filter((r) => r.id !== id))
          setDetailId(null)
        }}
      />
    </div>
  )
}

function FilterSelect({
  value,
  onChange,
  allLabel,
  options,
}: {
  value: string
  onChange: (value: string) => void
  allLabel: string
  options: Array<{ value: string; label: string }>
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger size="sm" className="w-[150px]">
        <SelectValue placeholder={allLabel} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{allLabel}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

// Searchable manager picker (Popover + Command), mirroring the Reports filter.
function ManagerFilter({
  value,
  onChange,
  options,
  allLabel,
  searchPlaceholder,
}: {
  value: string
  onChange: (value: string) => void
  options: Array<{ id: string; name: string }>
  allLabel: string
  searchPlaceholder: string
}) {
  const [open, setOpen] = React.useState(false)
  const selected = options.find((o) => o.id === value) ?? null
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="w-[180px] justify-between font-normal">
          <span className="truncate">{value === ALL ? allLabel : selected?.name ?? allLabel}</span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) p-0" align="start">
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandItem
              value={allLabel}
              onSelect={() => {
                onChange(ALL)
                setOpen(false)
              }}
            >
              <Check className={cn("size-4", value === ALL ? "opacity-100" : "opacity-0")} />
              {allLabel}
            </CommandItem>
            <CommandEmpty>—</CommandEmpty>
            {options.map((o) => (
              <CommandItem
                key={o.id}
                value={o.name}
                onSelect={() => {
                  onChange(o.id)
                  setOpen(false)
                }}
              >
                <Check className={cn("size-4", value === o.id ? "opacity-100" : "opacity-0")} />
                <span className="truncate">{o.name}</span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

type ActiveCustomer = { id: string; name: string; org_number: string | null; office: string | null }

// Swedish org-number rule: the leading group digit 5 = aktiebolag (AB).
// The 3rd digit ≥ 2 disambiguates from a personnummer (enskild firma) that
// happens to start with 5 (e.g. a person born in the 1950s), since a
// personnummer's 3rd digit is the month tens (0–1).
function isAktiebolag(orgNumber: string | null): boolean {
  const d = (orgNumber ?? "").replace(/\D/g, "")
  return d.length === 10 && d[0] === "5" && d[2] >= "2"
}

function MissingBokslutDialog({
  open,
  onOpenChange,
  engagedCustomerIds,
  onCreateForCustomer,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  engagedCustomerIds: Set<string>
  onCreateForCustomer: (customerId: string) => void
}) {
  const { t } = useTranslation()
  const [customers, setCustomers] = React.useState<ActiveCustomer[] | null>(null)
  const [query, setQuery] = React.useState("")

  // Lazy-load active customers the first time the dialog opens.
  React.useEffect(() => {
    if (!open || customers !== null) return
    let cancelled = false
    void (async () => {
      const supabase = createClient()
      const { data } = await supabase
        .from("customers")
        .select("id, name, org_number, office")
        .eq("status", "active")
        .order("name")
        .limit(5000)
      if (cancelled) return
      setCustomers((data ?? []) as ActiveCustomer[])
    })()
    return () => {
      cancelled = true
    }
  }, [open, customers])

  // Only aktiebolag are relevant for the year-end close; exclude enskild firma,
  // HB/KB and föreningar from the gap list.
  const missing = React.useMemo(
    () =>
      (customers ?? []).filter(
        (c) => !engagedCustomerIds.has(c.id) && isAktiebolag(c.org_number),
      ),
    [customers, engagedCustomerIds],
  )
  const q = query.trim().toLowerCase()
  const filtered = React.useMemo(
    () =>
      q === ""
        ? missing
        : missing.filter(
            (c) =>
              c.name.toLowerCase().includes(q) ||
              (c.org_number ?? "").toLowerCase().includes(q),
          ),
    [missing, q],
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {t("engagements.missing.title", "Active customers without a bokslut")}
            {customers !== null ? (
              <Badge variant="outline" className="text-[11px]">
                {missing.length}
              </Badge>
            ) : null}
          </DialogTitle>
          <p className="text-sm text-muted-foreground">
            {t("engagements.missing.description", "Active customers that have no engagement mapped on the board.")}
          </p>
        </DialogHeader>

        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("engagements.missing.search", "Search customers…")}
            className="h-8 pl-8"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {customers === null ? (
            <div className="space-y-2 py-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-9 w-full rounded-md" />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t("engagements.missing.none", "No active customers are missing a bokslut.")}
            </p>
          ) : (
            <ul className="divide-y">
              {filtered.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-3 py-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{c.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {c.org_number ?? ""}
                    {c.office ? ` · ${c.office}` : ""}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="shrink-0"
                    title={t("engagements.missing.create", "Create engagement")}
                    onClick={() => onCreateForCustomer(c.id)}
                  >
                    <Plus className="size-4" />
                    <span className="sr-only">{t("engagements.missing.create", "Create engagement")}</span>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

const EngagementCard = React.memo(function EngagementCard({
  row,
  dragging,
  cleared,
  canClear,
  onToggleCleared,
  clearLabels,
  onDragStart,
  onDragEnd,
  onClick,
  overdueLabel,
}: {
  row: EngagementBoardRow
  dragging: boolean
  cleared: boolean
  canClear: boolean
  onToggleCleared: (id: string) => void
  clearLabels: { mark: string; restore: string; badge: string }
  onDragStart: (id: string) => void
  onDragEnd: () => void
  onClick: (id: string) => void
  overdueLabel: string
}) {
  return (
    <div
      draggable
      onDragStart={() => onDragStart(row.id)}
      onDragEnd={onDragEnd}
      onClick={() => onClick(row.id)}
      className={cn(
        "cursor-pointer rounded-md border bg-background p-2.5 text-left shadow-sm transition-opacity hover:border-border-strong",
        // Let the browser skip layout/paint for off-screen cards — cuts the
        // reflow cost when overlays (Select/Sheet) lock the page on open.
        "[content-visibility:auto] [contain-intrinsic-size:auto_92px]",
        dragging && "opacity-50",
        cleared && "opacity-60",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{row.customer_name}</p>
        {cleared ? (
          <Badge variant="secondary" className="shrink-0 gap-1 text-[10px]">
            <CheckCircle2 className="size-3" />
            {clearLabels.badge}
          </Badge>
        ) : null}
        {row.customer_setup?.holdingbolag === "yes" ? (
          <Badge variant="outline" className="shrink-0 text-[10px]">
            Holding
          </Badge>
        ) : null}
        {canClear ? (
          <button
            type="button"
            title={cleared ? clearLabels.restore : clearLabels.mark}
            onClick={(e) => {
              e.stopPropagation()
              onToggleCleared(row.id)
            }}
            className={cn(
              "shrink-0 cursor-pointer rounded-full p-0.5 transition-colors",
              cleared
                ? "text-muted-foreground hover:text-foreground"
                : "text-muted-foreground hover:text-semantic-success",
            )}
          >
            {cleared ? <RotateCcw className="size-4" /> : <CheckCircle2 className="size-4" />}
            <span className="sr-only">{cleared ? clearLabels.restore : clearLabels.mark}</span>
          </button>
        ) : null}
      </div>

      {/* Row 1: consultant + group together */}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {row.consultant_name ? (
          <span className="inline-flex items-center gap-1">
            <UserIcon className="size-3" />
            {row.consultant_name}
          </span>
        ) : null}
        {row.group_name ? (
          <span className="inline-flex items-center gap-1">
            <Building2 className="size-3" />
            {row.group_name}
          </span>
        ) : null}
      </div>

      {/* Row 2: co-helper + INK2 + deadline */}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {row.co_consultant_name ? (
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <UserIcon className="size-3" />
            {row.co_consultant_name}
          </span>
        ) : null}
        {row.ink2_status_label ? (
          <Badge variant="outline" className="text-[10px]">
            INK2: {row.ink2_status_label}
          </Badge>
        ) : null}
        {row.deadline ? (
          <span
            className={cn(
              "inline-flex items-center gap-1 text-[11px]",
              row.is_overdue ? "text-semantic-error" : "text-muted-foreground",
            )}
          >
            <CalendarClock className="size-3" />
            {row.deadline}
            {row.is_overdue ? ` · ${overdueLabel}` : ""}
          </span>
        ) : null}
      </div>
    </div>
  )
})
