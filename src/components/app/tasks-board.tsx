"use client"

import * as React from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { AlertTriangle, Building2, CalendarClock, Plus, Search, User as UserIcon } from "lucide-react"
import { toast } from "sonner"

import { createClient } from "@/lib/supabase/client"
import { cn } from "@/lib/utils"
import { useTranslation } from "@/hooks/use-translation"
import { useUser } from "@/hooks/use-user"
import type { TaskBoardRow, TaskCategory, TaskStatus } from "@/types/task"
import { PageHeader } from "@/components/app/page-header"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { ManagerFilter } from "@/components/app/engagement-filters"
import { TaskCreateDialog } from "@/components/app/task-create-dialog"
import { TaskDetailSheet } from "@/components/app/task-detail-sheet"
import { TaskFilters } from "@/components/app/task-filters"

const NO_STATUS = "none"
const ALL = "all"
/** Sentinel for "tasks nobody has picked up" in the assignee filter. */
const UNASSIGNED = "unassigned"

/** Cost centre carries the customer↔manager link, so the create dialog can
 *  resolve a customer's manager the same way the bokslut board does. */
type Consultant = { id: string; name: string; costCenter: string | null }

/**
 * Within-column ordering: manually-positioned cards first (ascending), then any
 * never-ordered cards by recency (newest first). Stable id tiebreak so the order
 * is deterministic across renders. Mirrors the engagement board.
 */
function compareInColumn(a: TaskBoardRow, b: TaskBoardRow): number {
  if (a.position != null && b.position != null && a.position !== b.position) {
    return a.position - b.position
  }
  if (a.position != null && b.position == null) return -1
  if (a.position == null && b.position != null) return 1
  if (a.position == null && b.position == null) {
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
function applyStatus(row: TaskBoardRow, status: TaskStatus | null): TaskBoardRow {
  const next: TaskBoardRow = {
    ...row,
    status_id: status?.id ?? null,
    status_key: status?.key ?? null,
    status_label: status?.label ?? null,
    status_sort: status?.sort_order ?? null,
    status_is_done: status?.is_done ?? null,
    status_changed_at: new Date().toISOString(),
  }
  next.is_overdue = Boolean(
    next.deadline && new Date(next.deadline) < new Date() && !next.status_is_done,
  )
  return next
}

export function TasksBoard() {
  const { t } = useTranslation()
  const { user } = useUser()
  const router = useRouter()
  const searchParams = useSearchParams()

  const [loading, setLoading] = React.useState(true)
  const [statuses, setStatuses] = React.useState<TaskStatus[]>([])
  const [categories, setCategories] = React.useState<TaskCategory[]>([])
  const [rows, setRows] = React.useState<TaskBoardRow[]>([])
  const [consultants, setConsultants] = React.useState<Consultant[]>([])

  const [filterAssignee, setFilterAssignee] = React.useState<string>(ALL)
  const [filterCategories, setFilterCategories] = React.useState<string[]>([])
  const [filterOverdue, setFilterOverdue] = React.useState(false)
  const [query, setQuery] = React.useState("")

  const [draggingId, setDraggingId] = React.useState<string | null>(null)
  const [dragOverCol, setDragOverCol] = React.useState<string | null>(null)
  const [dropTarget, setDropTarget] = React.useState<{ colId: string; line: number } | null>(null)
  const [detailId, setDetailId] = React.useState<string | null>(null)
  const [createOpen, setCreateOpen] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      const supabase = createClient()
      const [statusRes, categoryRes, boardRes, profRes] = await Promise.all([
        supabase.from("task_statuses").select("*").order("sort_order"),
        supabase.from("task_categories").select("*").order("sort_order"),
        supabase.from("task_board").select("*"),
        supabase
          .from("profiles")
          .select("id, full_name, email, fortnox_cost_center")
          .eq("is_active", true)
          .order("full_name")
          .limit(500),
      ])
      if (cancelled) return
      setStatuses((statusRes.data ?? []) as TaskStatus[])
      setCategories((categoryRes.data ?? []) as TaskCategory[])
      setRows((boardRes.data ?? []) as TaskBoardRow[])
      setConsultants(
        (
          (profRes.data ?? []) as Array<{
            id: string
            full_name: string | null
            email: string
            fortnox_cost_center: string | null
          }>
        ).map((p) => ({
          id: p.id,
          name: p.full_name ?? p.email,
          costCenter: p.fortnox_cost_center,
        })),
      )
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Deep-link: open a specific task when arriving via ?task=<id> (from the
  // notification bell). Waits for the row to be present on the board.
  React.useEffect(() => {
    const target = searchParams.get("task")
    if (target && rows.some((r) => r.id === target)) setDetailId(target)
  }, [searchParams, rows])

  // Land on your own work: if the signed-in user is on any task, preselect them
  // in the assignee filter. Applied once; they can switch to All.
  const scopeAppliedRef = React.useRef(false)
  React.useEffect(() => {
    if (scopeAppliedRef.current || !user?.id || rows.length === 0) return
    scopeAppliedRef.current = true
    if (rows.some((r) => r.assignee_id === user.id)) setFilterAssignee(user.id)
  }, [user, rows])

  const statusById = React.useMemo(() => new Map(statuses.map((s) => [s.id, s])), [statuses])

  // Columns: the ordered stages, plus a leading "No status" bucket only when
  // some card actually sits there (tasks normally get a status on creation).
  const columns = React.useMemo(() => {
    const stages = [...statuses]
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((s) => ({ id: s.id, label: s.label, done: s.is_done }))
    const hasUnset = rows.some((r) => !r.status_id)
    return hasUnset
      ? [{ id: NO_STATUS, label: t("tasks.noStatus", "No status"), done: false }, ...stages]
      : stages
  }, [statuses, rows, t])

  const assigneeOptions = React.useMemo(() => {
    const map = new Map<string, string>()
    for (const r of rows) {
      if (r.assignee_id) map.set(r.assignee_id, r.assignee_name ?? r.assignee_id)
    }
    const list = Array.from(map, ([id, name]) => ({ id, name })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )
    return [{ id: UNASSIGNED, name: t("tasks.unassigned", "Unassigned") }, ...list]
  }, [rows, t])

  // Deferred so typing stays responsive — filtering runs at low priority.
  const deferredQuery = React.useDeferredValue(query)
  const q = deferredQuery.trim().toLowerCase()

  const filteredRows = React.useMemo(
    () =>
      rows.filter(
        (r) =>
          (filterAssignee === ALL ||
            (filterAssignee === UNASSIGNED ? r.assignee_id == null : r.assignee_id === filterAssignee)) &&
          (filterCategories.length === 0 ||
            (r.category_id != null && filterCategories.includes(r.category_id))) &&
          (!filterOverdue || r.is_overdue) &&
          (q === "" ||
            r.title.toLowerCase().includes(q) ||
            (r.customer_name ?? "").toLowerCase().includes(q) ||
            (r.description ?? "").toLowerCase().includes(q)),
      ),
    [rows, filterAssignee, filterCategories, filterOverdue, q],
  )

  const overdueCount = React.useMemo(() => rows.filter((r) => r.is_overdue).length, [rows])

  const filtersActive =
    filterAssignee !== ALL || filterCategories.length > 0 || filterOverdue || query.trim() !== ""

  const resetFilters = React.useCallback(() => {
    React.startTransition(() => {
      setFilterAssignee(ALL)
      setFilterCategories([])
      setFilterOverdue(false)
      setQuery("")
    })
  }, [])

  const toggleCategory = React.useCallback((id: string) => {
    React.startTransition(() =>
      setFilterCategories((prev) =>
        prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id],
      ),
    )
  }, [])

  const rowsByColumn = React.useMemo(() => {
    const map = new Map<string, TaskBoardRow[]>()
    for (const col of columns) map.set(col.id, [])
    for (const r of filteredRows) {
      const key = r.status_id ?? NO_STATUS
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(r)
    }
    for (const list of map.values()) list.sort(compareInColumn)
    return map
  }, [columns, filteredRows])

  const detailRow = detailId ? rows.find((r) => r.id === detailId) ?? null : null

  const handleCardClick = React.useCallback((id: string) => {
    React.startTransition(() => setDetailId(id))
  }, [])
  const handleCardDragStart = React.useCallback((id: string) => setDraggingId(id), [])
  const handleCardDragEnd = React.useCallback(() => {
    setDraggingId(null)
    setDragOverCol(null)
    setDropTarget(null)
  }, [])

  // Which column the dragged card currently lives in — drives whether a hover
  // is a cross-column move (→ top) or an in-column reorder (→ cursor gap).
  const draggedColumnKey = React.useCallback((): string | null => {
    if (!draggingId) return null
    const r = rows.find((x) => x.id === draggingId)
    if (!r) return null
    return r.status_id ?? NO_STATUS
  }, [draggingId, rows])

  // Cross-column drops move the card and put it at the top; in-column drops
  // reorder to the cursor. Both are applied optimistically, then persisted —
  // the status as a normal update (keeps the activity log) and the order via
  // the atomic reorder_tasks RPC.
  async function handleDrop(e: React.DragEvent<HTMLDivElement>, columnId: string) {
    const id = draggingId
    setDraggingId(null)
    setDragOverCol(null)
    setDropTarget(null)
    if (!id) return

    const dragged = rows.find((r) => r.id === id)
    if (!dragged) return

    const currentColumn = dragged.status_id ?? NO_STATUS
    const crossColumn = currentColumn !== columnId
    const toStatusId = columnId === NO_STATUS ? null : columnId

    const beforeId = crossColumn
      ? null
      : computeDropLine(e.currentTarget, e.clientY, id).beforeId

    // The destination column's existing cards (all rows, not just the visible
    // ones) in display order, excluding the dragged card.
    const destExisting = rows
      .filter((r) => r.id !== id && (r.status_id ?? NO_STATUS) === columnId)
      .sort(compareInColumn)

    const insertAt = beforeId ? destExisting.findIndex((r) => r.id === beforeId) + 1 : 0
    const newOrderIds = [
      ...destExisting.slice(0, insertAt).map((r) => r.id),
      id,
      ...destExisting.slice(insertAt).map((r) => r.id),
    ]

    // No-op: same column, unchanged order — skip the round-trip.
    if (!crossColumn) {
      const currentOrder = rows
        .filter((r) => (r.status_id ?? NO_STATUS) === columnId)
        .sort(compareInColumn)
        .map((r) => r.id)
      if (
        currentOrder.length === newOrderIds.length &&
        currentOrder.every((rid, i) => rid === newOrderIds[i])
      ) {
        return
      }
    }

    const positionById = new Map(newOrderIds.map((rid, i) => [rid, i + 1]))
    const snapshot = rows
    setRows((prev) =>
      prev.map((r) => {
        if (!positionById.has(r.id)) return r
        let next = r
        if (r.id === id && crossColumn) {
          next = applyStatus(next, toStatusId ? statusById.get(toStatusId) ?? null : null)
        }
        return { ...next, position: positionById.get(r.id)! }
      }),
    )

    const supabase = createClient()
    if (crossColumn) {
      const { error } = await supabase
        .from("tasks")
        .update({ status_id: toStatusId } as never)
        .eq("id", id)
      if (error) {
        setRows(snapshot)
        toast.error(`${t("tasks.toast.saveFailed", "Couldn't save the task")}: ${error.message}`)
        return
      }
    }

    const { error: reorderError } = await supabase.rpc("reorder_tasks" as never, {
      p_ids: newOrderIds,
    } as never)
    if (reorderError) {
      setRows(snapshot)
      toast.error(`${t("tasks.toast.saveFailed", "Couldn't save the task")}: ${reorderError.message}`)
    }
  }

  const overdueLabel = t("tasks.overdue", "Overdue")

  return (
    <div className="flex h-full flex-col gap-4">
      <PageHeader
        title={t("tasks.title", "Tasks")}
        description={t(
          "tasks.description",
          "Ad-hoc work outside the recurring services — advisory, follow-ups, and anything handed between colleagues.",
        )}
      >
        <Button size="sm" onClick={() => React.startTransition(() => setCreateOpen(true))}>
          <Plus className="size-4" />
          {t("tasks.new", "New task")}
        </Button>
      </PageHeader>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-[240px]">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("tasks.filter.search", "Search tasks…")}
            className="h-8 pl-8"
          />
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant={filterOverdue ? "default" : "outline"}
            className="h-8"
            onClick={() => React.startTransition(() => setFilterOverdue((v) => !v))}
            aria-pressed={filterOverdue}
          >
            <AlertTriangle className="size-4" />
            {t("tasks.filter.overdue", "Overdue")}
            {overdueCount > 0 ? (
              <Badge variant={filterOverdue ? "secondary" : "outline"} className="ml-1 text-[10px]">
                {overdueCount}
              </Badge>
            ) : null}
          </Button>
          <ManagerFilter
            value={filterAssignee}
            onChange={(v) => React.startTransition(() => setFilterAssignee(v))}
            allLabel={t("tasks.filter.allAssignees", "Everyone")}
            searchPlaceholder={t("tasks.filter.searchAssignees", "Search people...")}
            options={assigneeOptions}
          />
          <TaskFilters
            t={t}
            categories={categories}
            selected={filterCategories}
            onToggle={toggleCategory}
            onClearAll={resetFilters}
            clearDisabled={!filtersActive}
          />
        </div>
      </div>

      {loading ? (
        <div className="flex gap-3 overflow-hidden">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-64 w-[260px] shrink-0 rounded-lg" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-md border bg-muted/20 p-10 text-center text-sm text-muted-foreground">
          {t("tasks.empty", "No tasks yet. Create one to get started.")}
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
                  const line =
                    draggedColumnKey() === col.id
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
                  col.done && "bg-transparent",
                )}
              >
                <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
                  <span
                    className={cn("truncate text-sm font-medium", col.done && "text-muted-foreground")}
                  >
                    {col.label}
                  </span>
                  <Badge variant="outline" className="shrink-0 text-[11px]">
                    {colRows.length}
                  </Badge>
                </div>
                <div className="flex min-h-[40px] flex-1 flex-col gap-2 overflow-y-auto p-2">
                  {colRows.map((row, i) => (
                    <React.Fragment key={row.id}>
                      {dropTarget?.colId === col.id && dropTarget.line === i ? <DropLine /> : null}
                      <TaskCard
                        row={row}
                        dragging={draggingId === row.id}
                        onDragStart={handleCardDragStart}
                        onDragEnd={handleCardDragEnd}
                        onClick={handleCardClick}
                        overdueLabel={overdueLabel}
                      />
                    </React.Fragment>
                  ))}
                  {dropTarget?.colId === col.id && dropTarget.line === colRows.length ? (
                    <DropLine />
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <TaskCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        statuses={statuses}
        categories={categories}
        consultants={consultants}
        onCreated={(row) => setRows((prev) => [row, ...prev])}
      />

      <TaskDetailSheet
        row={detailRow}
        statuses={statuses}
        categories={categories}
        consultants={consultants}
        open={detailId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDetailId(null)
            // Drop the deep-link param so the sheet doesn't re-open on re-render.
            if (searchParams.get("task")) router.replace("/uppgifter")
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

// The drop-position guide: a thin accented bar marking where the card lands.
function DropLine() {
  return (
    <div className="relative h-0.5 rounded-full bg-primary" aria-hidden>
      <span className="absolute -left-0.5 top-1/2 size-1.5 -translate-y-1/2 rounded-full bg-primary" />
    </div>
  )
}

const TaskCard = React.memo(function TaskCard({
  row,
  dragging,
  onDragStart,
  onDragEnd,
  onClick,
  overdueLabel,
}: {
  row: TaskBoardRow
  dragging: boolean
  onDragStart: (id: string) => void
  onDragEnd: () => void
  onClick: (id: string) => void
  overdueLabel: string
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
        "[content-visibility:auto] [contain-intrinsic-size:auto_104px]",
        dragging && "opacity-50",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 flex-1 text-sm font-medium text-foreground">{row.title}</p>
        {row.category_label ? (
          <Badge variant="secondary" className="shrink-0 text-[10px]">
            {row.category_label}
          </Badge>
        ) : null}
      </div>

      {/* The note: what the task involves. Two lines on the card; the rest is
          in the detail sheet. */}
      {row.description ? (
        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{row.description}</p>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {row.assignee_name ? (
          <span className="inline-flex items-center gap-1">
            <UserIcon className="size-3" />
            {row.assignee_name}
          </span>
        ) : null}
        {row.customer_name ? (
          <span className="inline-flex min-w-0 items-center gap-1">
            <Building2 className="size-3 shrink-0" />
            <span className="truncate">{row.customer_name}</span>
          </span>
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
