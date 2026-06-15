"use client"

import * as React from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Plus, CalendarClock, Building2, User as UserIcon, Search, AlertTriangle } from "lucide-react"
import { toast } from "sonner"

import { createClient } from "@/lib/supabase/client"
import { cn } from "@/lib/utils"
import { useTranslation } from "@/hooks/use-translation"
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

  const [draggingId, setDraggingId] = React.useState<string | null>(null)
  const [dragOverCol, setDragOverCol] = React.useState<string | null>(null)
  const [detailId, setDetailId] = React.useState<string | null>(null)
  const [createOpen, setCreateOpen] = React.useState(false)

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
    return [{ id: NO_STATUS, label: t("engagements.noStatus", "No status") }, ...ofWorkflow.map((s) => ({ id: s.id, label: s.label }))]
  }, [statuses, workflow, t])

  // Distinct filter option lists derived from the loaded rows.
  const consultantOptions = React.useMemo(() => {
    const map = new Map<string, string>()
    for (const r of rows) if (r.consultant_id) map.set(r.consultant_id, r.consultant_name ?? r.consultant_id)
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

  const customerQuery = filterCustomer.trim().toLowerCase()
  const filteredRows = React.useMemo(
    () =>
      rows.filter(
        (r) =>
          (filterConsultant === ALL || r.consultant_id === filterConsultant) &&
          (filterGroup === ALL || r.group_name === filterGroup) &&
          (filterYear === ALL || r.fiscal_year_end === filterYear) &&
          (!filterOverdue || r.is_overdue) &&
          (customerQuery === "" || r.customer_name.toLowerCase().includes(customerQuery)),
      ),
    [rows, filterConsultant, filterGroup, filterYear, filterOverdue, customerQuery],
  )

  const overdueCount = React.useMemo(() => rows.filter((r) => r.is_overdue).length, [rows])

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
        <Button size="sm" onClick={() => setCreateOpen(true)}>
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
              onClick={() => setWorkflow(wf)}
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
            onClick={() => setFilterOverdue((v) => !v)}
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
          <FilterSelect
            value={filterConsultant}
            onChange={setFilterConsultant}
            allLabel={t("engagements.filter.consultant", "Consultant")}
            options={consultantOptions.map((c) => ({ value: c.id, label: c.name }))}
          />
          <FilterSelect
            value={filterGroup}
            onChange={setFilterGroup}
            allLabel={t("engagements.filter.group", "Group")}
            options={groupOptions.map((g) => ({ value: g, label: g }))}
          />
          <FilterSelect
            value={filterYear}
            onChange={setFilterYear}
            allLabel={t("engagements.filter.year", "Fiscal year")}
            options={yearOptions.map((y) => ({ value: y, label: y }))}
          />
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
                )}
              >
                <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
                  <span className="truncate text-sm font-medium">{col.label}</span>
                  <Badge variant="outline" className="shrink-0 text-[11px]">
                    {colRows.length}
                  </Badge>
                </div>
                <div className="flex min-h-[40px] flex-1 flex-col gap-2 overflow-y-auto p-2">
                  {colRows.map((row) => (
                    <EngagementCard
                      key={row.id}
                      row={row}
                      dragging={draggingId === row.id}
                      onDragStart={() => setDraggingId(row.id)}
                      onDragEnd={() => {
                        setDraggingId(null)
                        setDragOverCol(null)
                      }}
                      onClick={() => setDetailId(row.id)}
                      overdueLabel={t("engagements.overdue", "Overdue")}
                    />
                  ))}
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
        groupOptions={groupOptions}
        onCreated={(row) => setRows((prev) => [row, ...prev])}
      />

      <EngagementDetailSheet
        row={detailRow}
        statuses={statuses}
        consultants={consultants}
        groupOptions={groupOptions}
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

function EngagementCard({
  row,
  dragging,
  onDragStart,
  onDragEnd,
  onClick,
  overdueLabel,
}: {
  row: EngagementBoardRow
  dragging: boolean
  onDragStart: () => void
  onDragEnd: () => void
  onClick: () => void
  overdueLabel: string
}) {
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onClick}
      className={cn(
        "cursor-pointer rounded-md border bg-background p-2.5 text-left shadow-sm transition-opacity hover:border-border-strong",
        dragging && "opacity-50",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{row.customer_name}</p>
        {row.customer_setup?.holdingbolag === "yes" ? (
          <Badge variant="outline" className="shrink-0 text-[10px]">
            Holding
          </Badge>
        ) : null}
      </div>

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

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
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
}
