"use client"

import * as React from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Plus, CalendarClock, Building2, User as UserIcon, Search, AlertTriangle, ClipboardList, CheckCircle2, RotateCcw, Check, ChevronDown, EyeOff, Eye, X, Landmark } from "lucide-react"
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

/** The cleared-flag column for a workflow — bokslut and INK2 clear independently. */
function clearedFieldFor(workflow: EngagementWorkflow): "bokslut_cleared_at" | "ink2_cleared_at" {
  return workflow === "bokslut" ? "bokslut_cleared_at" : "ink2_cleared_at"
}

/** This row's cleared timestamp for the active workflow (null = not cleared). */
function clearedOf(row: EngagementBoardRow, workflow: EngagementWorkflow): string | null {
  return row[clearedFieldFor(workflow)]
}

/** The manual-ordering column for a workflow. */
function positionFieldFor(workflow: EngagementWorkflow): "bokslut_position" | "ink2_position" {
  return workflow === "bokslut" ? "bokslut_position" : "ink2_position"
}

/** This row's manual position for the active workflow (null = never ordered). */
function positionOf(row: EngagementBoardRow, workflow: EngagementWorkflow): number | null {
  return row[positionFieldFor(workflow)]
}

/**
 * Within-column ordering: manually-positioned cards first (ascending), then any
 * never-ordered cards by recency (newest first). Stable id tiebreak so the order
 * is deterministic across renders. Mirrors the read model's intent in 00086.
 */
function compareInColumn(
  a: EngagementBoardRow,
  b: EngagementBoardRow,
  workflow: EngagementWorkflow,
): number {
  const pa = positionOf(a, workflow)
  const pb = positionOf(b, workflow)
  if (pa != null && pb != null && pa !== pb) return pa - pb
  if (pa != null && pb == null) return -1
  if (pa == null && pb != null) return 1
  if (pa == null && pb == null) {
    const byRecency = b.created_at.localeCompare(a.created_at)
    if (byRecency !== 0) return byRecency
  }
  return a.id.localeCompare(b.id)
}

/**
 * Read the live card DOM in a column to work out, for a given cursor Y:
 *   • `lineIndex` — the gap the drop-guide line should sit in (0 = above the
 *     first card … N = below the last), counting the cards as rendered.
 *   • `beforeId`  — the card to drop AFTER (null = drop at top), skipping the
 *     dragged card itself so hovering next to it doesn't anchor onto it.
 * Both the visual guide and the actual drop derive from this, so they agree.
 */
function computeDropLine(
  container: HTMLElement,
  clientY: number,
  draggedId: string | null,
): { lineIndex: number; beforeId: string | null } {
  const cardEls = Array.from(container.querySelectorAll<HTMLElement>("[data-card-id]"))
  const ids = cardEls.map((el) => el.dataset.cardId ?? "")
  let lineIndex = 0
  for (const el of cardEls) {
    const r = el.getBoundingClientRect()
    if (clientY > r.top + r.height / 2) lineIndex += 1
    else break
  }
  let beforeId = lineIndex > 0 ? ids[lineIndex - 1] : null
  if (beforeId === draggedId) beforeId = lineIndex >= 2 ? ids[lineIndex - 2] : null
  return { lineIndex, beforeId }
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
  const [deadlineOffsetMonths, setDeadlineOffsetMonths] = React.useState(3)
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
  // Which gap the drop-guide line is drawn in: { colId, line } (line = index
  // among the column's rendered cards). Null when not dragging over a column.
  const [dropTarget, setDropTarget] = React.useState<{ colId: string; line: number } | null>(null)
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
        supabase.from("engagement_config").select("active_fiscal_year_end, checklist_fields, deadline_offset_months").eq("id", 1).maybeSingle(),
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
        deadline_offset_months: number | null
      } | null
      if (cfg?.active_fiscal_year_end) setDefaultFiscalYearEnd(cfg.active_fiscal_year_end)
      if (Array.isArray(cfg?.checklist_fields)) setChecklistFields(cfg.checklist_fields)
      if (typeof cfg?.deadline_offset_months === "number") setDeadlineOffsetMonths(cfg.deadline_offset_months)
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
            (clearedMode === "hide" && !clearedOf(r, workflow)) ||
            (clearedMode === "only" && !!clearedOf(r, workflow))) &&
          (customerQuery === "" || r.customer_name.toLowerCase().includes(customerQuery)),
      ),
    [rows, filterConsultant, filterGroup, filterYear, clearedMode, customerQuery, workflow],
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
    for (const list of map.values()) list.sort((a, b) => compareInColumn(a, b, workflow))
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
    setDropTarget(null)
  }, [])

  // Where the dragged card currently lives (its column key for the active
  // workflow) — drives whether a hover is a cross-column move (→ top) or an
  // in-column reorder (→ cursor gap).
  const draggedColumnKey = React.useCallback((): string | null => {
    if (!draggingId) return null
    const r = rows.find((x) => x.id === draggingId)
    if (!r) return null
    const sid = workflow === "bokslut" ? r.bokslut_status_id : r.ink2_status_id
    return sid ?? NO_STATUS
  }, [draggingId, rows, workflow])
  const overdueLabel = t("engagements.overdue", "Overdue")
  const clearLabels = React.useMemo(
    () => ({
      mark: t("engagements.clear.mark", "Mark as cleared"),
      restore: t("engagements.clear.restore", "Restore to board"),
      badge: t("engagements.clear.badge", "Cleared"),
    }),
    [t],
  )
  // Trust badge for a Bolagsverket-confirmed registration. Only meaningful on
  // the bokslut board (INK2 has no BV registration).
  const verifiedLabels = React.useMemo(
    () => ({
      badge: t("engagements.bvVerified.badge", "Bolagsverket"),
      tooltip: t(
        "engagements.bvVerified.tooltip",
        "Confirmed registered with Bolagsverket",
      ),
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
      const field = clearedFieldFor(workflow)
      const next = clearedOf(row, workflow) ? null : new Date().toISOString()
      const snapshot = rowsRef.current
      setRows((prev) => prev.map((r) => (r.id === id ? { ...r, [field]: next } : r)))
      void (async () => {
        const supabase = createClient()
        const { error } = await supabase
          .from("engagements")
          .update({ [field]: next } as never)
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
    [t, workflow],
  )

  // Unified drop handler for both cross-column moves and within-column reorder.
  //
  // Rules (per the product spec):
  //   • Dropping a card into a DIFFERENT column moves it there and places it at
  //     the TOP of that column.
  //   • Dropping within the SAME column re-orders it to where the cursor is, so
  //     the team can arrange a column however they like.
  //
  // Implementation: we compute the destination column's new full id order
  // (anchored to the neighbouring card under the cursor so active filters can't
  // scramble hidden cards), optimistically apply both the status move and the
  // new positions, then persist — the status change as a normal update (keeps
  // the activity log) and the order via the atomic reorder_engagements RPC.
  async function handleDrop(e: React.DragEvent<HTMLDivElement>, columnId: string) {
    const id = draggingId
    setDraggingId(null)
    setDragOverCol(null)
    setDropTarget(null)
    if (!id) return

    const dragged = rows.find((r) => r.id === id)
    if (!dragged) return

    const currentStatusId = workflow === "bokslut" ? dragged.bokslut_status_id : dragged.ink2_status_id
    const currentColumn = currentStatusId ?? NO_STATUS
    const crossColumn = currentColumn !== columnId
    const toStatusId = columnId === NO_STATUS ? null : columnId

    // Anchor the insert to a real neighbour id from what's actually rendered, so
    // ordering is correct even when filters hide some cards. Cross-column drops
    // always land at the very top (beforeId = null).
    const beforeId = crossColumn
      ? null
      : computeDropLine(e.currentTarget, e.clientY, id).beforeId

    // The destination column's existing cards (all rows, not just visible), in
    // display order, excluding the dragged card.
    const destExisting = rows
      .filter((r) => r.id !== id && (workflow === "bokslut" ? r.bokslut_status_id : r.ink2_status_id) === toStatusId)
      .sort((a, b) => compareInColumn(a, b, workflow))

    const insertAt = beforeId
      ? destExisting.findIndex((r) => r.id === beforeId) + 1
      : 0
    const newOrderIds = [
      ...destExisting.slice(0, insertAt).map((r) => r.id),
      id,
      ...destExisting.slice(insertAt).map((r) => r.id),
    ]

    // No-op: same column and the order is unchanged — skip the round-trip.
    if (!crossColumn) {
      const currentOrder = rows
        .filter((r) => (workflow === "bokslut" ? r.bokslut_status_id : r.ink2_status_id) === toStatusId)
        .sort((a, b) => compareInColumn(a, b, workflow))
        .map((r) => r.id)
      if (currentOrder.length === newOrderIds.length && currentOrder.every((rid, i) => rid === newOrderIds[i])) {
        return
      }
    }

    const posField = positionFieldFor(workflow)
    const positionById = new Map(newOrderIds.map((rid, i) => [rid, i + 1]))

    const snapshot = rows
    setRows((prev) =>
      prev.map((r) => {
        if (!positionById.has(r.id)) return r
        let next = r
        // Apply the status move to the dragged card only.
        if (r.id === id && crossColumn) {
          next = applyStatus(next, workflow, toStatusId ? statusById.get(toStatusId) ?? null : null)
        }
        return { ...next, [posField]: positionById.get(r.id)! }
      }),
    )

    const supabase = createClient()
    if (crossColumn) {
      const field = statusFieldsFor(workflow).id
      const { error } = await supabase
        .from("engagements")
        .update({ [field]: toStatusId } as never)
        .eq("id", id)
      if (error) {
        setRows(snapshot)
        toast.error(`${t("engagements.toast.error", "Couldn't update engagement")}: ${error.message}`)
        return
      }
    }

    const { error: reorderError } = await supabase.rpc("reorder_engagements" as never, {
      p_workflow: workflow,
      p_ids: newOrderIds,
    } as never)
    if (reorderError) {
      setRows(snapshot)
      toast.error(`${t("engagements.toast.error", "Couldn't update engagement")}: ${reorderError.message}`)
    }
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
                  const line = draggedColumnKey() === col.id
                    ? computeDropLine(e.currentTarget, e.clientY, draggingId).lineIndex
                    : 0 // cross-column drops always land at the top
                  setDropTarget((cur) =>
                    cur && cur.colId === col.id && cur.line === line ? cur : { colId: col.id, line },
                  )
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                    setDragOverCol((cur) => (cur === col.id ? null : cur))
                    setDropTarget((cur) => (cur?.colId === col.id ? null : cur))
                  }
                }}
                onDrop={(e) => handleDrop(e, col.id)}
                className={cn(
                  "flex w-[270px] shrink-0 flex-col rounded-lg border bg-muted/20 transition-colors",
                  dragOverCol === col.id && "border-primary bg-primary/10 ring-2 ring-primary/40 ring-inset",
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
                  {colRows.map((row, i) => {
                    const showLine = dropTarget?.colId === col.id && dropTarget.line === i
                    return (
                      <React.Fragment key={row.id}>
                        {showLine ? <DropLine /> : null}
                        <EngagementCard
                          row={row}
                          dragging={draggingId === row.id}
                          cleared={!!clearedOf(row, workflow)}
                          // Clearing is allowed from ANY column (not just the
                          // "done" stage) — a card can be cleared at any point.
                          canClear
                          onToggleCleared={handleToggleCleared}
                          clearLabels={clearLabels}
                          onDragStart={handleCardDragStart}
                          onDragEnd={handleCardDragEnd}
                          onClick={handleCardClick}
                          overdueLabel={overdueLabel}
                          verifiedLabels={verifiedLabels}
                          showVerified={workflow === "bokslut"}
                        />
                      </React.Fragment>
                    )
                  })}
                  {dropTarget?.colId === col.id && dropTarget.line === colRows.length ? (
                    <DropLine />
                  ) : null}
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
        deadlineOffsetMonths={deadlineOffsetMonths}
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
        deadlineOffsetMonths={deadlineOffsetMonths}
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

type ActiveCustomer = { id: string; name: string; org_number: string | null; office: string | null; bokslut_relevant: boolean | null }

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
  // Which set to show: the gap list, or the ones marked not relevant.
  const [view, setView] = React.useState<"missing" | "notRelevant">("missing")
  // The row currently awaiting a hide confirmation (inline, no modal).
  const [confirmingId, setConfirmingId] = React.useState<string | null>(null)

  // Lazy-load active customers the first time the dialog opens.
  React.useEffect(() => {
    if (!open || customers !== null) return
    let cancelled = false
    void (async () => {
      const supabase = createClient()
      const { data, error } = await supabase
        .from("customers")
        .select("id, name, org_number, office, bokslut_relevant")
        .eq("status", "active")
        .order("name")
        .limit(5000)
      if (cancelled) return
      if (error) {
        // Surface the failure instead of silently rendering an empty list (which
        // would misleadingly read as "every customer already has a bokslut").
        console.error("Failed to load active customers for the bokslut gap list", error)
        toast.error(error.message)
        return
      }
      setCustomers((data ?? []) as ActiveCustomer[])
    })()
    return () => {
      cancelled = true
    }
  }, [open, customers])

  // Only aktiebolag are relevant for the year-end close; exclude enskild firma,
  // HB/KB and föreningar from the gap list. Also drop customers explicitly
  // marked as not relevant for Bokslut on their customer card.
  const missing = React.useMemo(
    () =>
      (customers ?? []).filter(
        (c) =>
          !engagedCustomerIds.has(c.id) &&
          isAktiebolag(c.org_number) &&
          c.bokslut_relevant !== false,
      ),
    [customers, engagedCustomerIds],
  )
  // The customers explicitly opted out of bokslut, shown under the other tab so
  // they can be reviewed and restored.
  const notRelevant = React.useMemo(
    () => (customers ?? []).filter((c) => c.bokslut_relevant === false),
    [customers],
  )
  const source = view === "missing" ? missing : notRelevant
  const q = query.trim().toLowerCase()
  const filtered = React.useMemo(
    () =>
      q === ""
        ? source
        : source.filter(
            (c) =>
              c.name.toLowerCase().includes(q) ||
              (c.org_number ?? "").toLowerCase().includes(q),
          ),
    [source, q],
  )

  function switchView(next: "missing" | "notRelevant") {
    setConfirmingId(null)
    setView(next)
  }

  // Mark a customer as not relevant for bokslut (sets bokslut_relevant = false).
  // Optimistically flips the local value so it moves to the "not relevant" tab.
  async function markNotRelevant(c: ActiveCustomer) {
    setConfirmingId(null)
    const supabase = createClient()
    const { error } = await supabase
      .from("customers")
      .update({ bokslut_relevant: false } as never)
      .eq("id", c.id)
    if (error) {
      toast.error(error.message)
      return
    }
    setCustomers((prev) =>
      (prev ?? []).map((x) => (x.id === c.id ? { ...x, bokslut_relevant: false } : x)),
    )
    toast.success(t("engagements.missing.markedNotRelevant", "Marked as not relevant for bokslut"))
  }

  // Put a customer back in the gap list by clearing the opt-out (back to "not
  // reviewed yet" / null).
  async function restoreRelevant(c: ActiveCustomer) {
    const supabase = createClient()
    const { error } = await supabase
      .from("customers")
      .update({ bokslut_relevant: null } as never)
      .eq("id", c.id)
    if (error) {
      toast.error(error.message)
      return
    }
    setCustomers((prev) =>
      (prev ?? []).map((x) => (x.id === c.id ? { ...x, bokslut_relevant: null } : x)),
    )
    toast.success(t("engagements.missing.restored", "Moved back to the bokslut list"))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {t("engagements.missing.title", "Active customers without a bokslut")}
            {customers !== null ? (
              <Badge variant="outline" className="text-[11px]">
                {source.length}
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

        {/* Switch between the gap list and the customers opted out of bokslut. */}
        <div className="flex items-center gap-1 rounded-md border p-0.5">
          <button
            type="button"
            onClick={() => switchView("missing")}
            className={cn(
              "flex-1 rounded-sm px-2 py-1 text-xs font-medium transition-colors",
              view === "missing"
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t("engagements.missing.tabMissing", "Without bokslut")}
            {customers !== null ? ` (${missing.length})` : ""}
          </button>
          <button
            type="button"
            onClick={() => switchView("notRelevant")}
            className={cn(
              "flex-1 rounded-sm px-2 py-1 text-xs font-medium transition-colors",
              view === "notRelevant"
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t("engagements.missing.tabNotRelevant", "Not relevant")}
            {customers !== null ? ` (${notRelevant.length})` : ""}
          </button>
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
              {view === "missing"
                ? t("engagements.missing.none", "No active customers are missing a bokslut.")
                : t("engagements.missing.noneNotRelevant", "No customers are marked as not relevant.")}
            </p>
          ) : (
            <ul className="divide-y">
              {filtered.map((c) => (
                <li
                  key={c.id}
                  className={cn(
                    "flex items-center justify-between gap-3 py-2",
                    view === "notRelevant" && "text-muted-foreground",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{c.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {c.org_number ?? ""}
                    {c.office ? ` · ${c.office}` : ""}
                  </span>
                  {view === "notRelevant" ? (
                    <div className="flex shrink-0 items-center gap-0.5">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        title={t("engagements.missing.restore", "Show in the bokslut list again")}
                        onClick={() => void restoreRelevant(c)}
                      >
                        <Eye className="size-4" />
                        <span className="sr-only">{t("engagements.missing.restore", "Show in the bokslut list again")}</span>
                      </Button>
                    </div>
                  ) : confirmingId === c.id ? (
                    <div className="flex shrink-0 items-center gap-1">
                      <span className="text-xs text-muted-foreground">
                        {t("engagements.missing.confirmHide", "Not relevant?")}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="text-semantic-error"
                        title={t("engagements.missing.confirmHideYes", "Confirm")}
                        onClick={() => void markNotRelevant(c)}
                      >
                        <Check className="size-4" />
                        <span className="sr-only">{t("engagements.missing.confirmHideYes", "Confirm")}</span>
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        title={t("engagements.missing.confirmHideCancel", "Cancel")}
                        onClick={() => setConfirmingId(null)}
                      >
                        <X className="size-4" />
                        <span className="sr-only">{t("engagements.missing.confirmHideCancel", "Cancel")}</span>
                      </Button>
                    </div>
                  ) : (
                    <div className="flex shrink-0 items-center gap-0.5">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="text-muted-foreground"
                        title={t("engagements.missing.markNotRelevant", "Not relevant for bokslut")}
                        onClick={() => setConfirmingId(c.id)}
                      >
                        <EyeOff className="size-4" />
                        <span className="sr-only">{t("engagements.missing.markNotRelevant", "Not relevant for bokslut")}</span>
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        title={t("engagements.missing.create", "Create engagement")}
                        onClick={() => onCreateForCustomer(c.id)}
                      >
                        <Plus className="size-4" />
                        <span className="sr-only">{t("engagements.missing.create", "Create engagement")}</span>
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

// The drop-position guide: a thin accented bar marking exactly where the card
// will land. The dot on the left makes the (otherwise 2px) line easy to spot.
function DropLine() {
  return (
    <div className="relative h-0.5 rounded-full bg-primary" aria-hidden>
      <span className="absolute -left-0.5 top-1/2 size-1.5 -translate-y-1/2 rounded-full bg-primary" />
    </div>
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
  verifiedLabels,
  showVerified,
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
  verifiedLabels: { badge: string; tooltip: string }
  showVerified: boolean
}) {
  return (
    <div
      draggable
      data-card-id={row.id}
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
        {showVerified && row.annual_report_registered_bv_at ? (
          <span
            className="mt-0.5 shrink-0 text-semantic-success"
            title={`${verifiedLabels.tooltip} · ${new Date(row.annual_report_registered_bv_at).toLocaleDateString("sv-SE")}`}
            aria-label={verifiedLabels.tooltip}
          >
            <Landmark className="size-4" />
          </span>
        ) : null}
        {cleared ? (
          <Badge variant="secondary" className="shrink-0 gap-1 text-[10px]">
            <CheckCircle2 className="size-3" />
            {clearLabels.badge}
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
