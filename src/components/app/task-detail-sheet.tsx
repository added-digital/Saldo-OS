"use client"

import * as React from "react"
import Link from "next/link"
import { Loader2, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { createClient } from "@/lib/supabase/client"
import { useTranslation } from "@/hooks/use-translation"
import { useUser } from "@/hooks/use-user"
import type { TaskActivity, TaskBoardRow, TaskCategory, TaskStatus } from "@/types/task"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { DateInput } from "@/components/ui/date-input"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Textarea } from "@/components/ui/textarea"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

const NONE = "none"

/** Local edit buffer — the sheet saves explicitly, not on every keystroke. */
type Draft = {
  title: string
  description: string
  statusId: string
  categoryId: string
  assigneeId: string
  deadline: string
}

function draftFrom(row: TaskBoardRow): Draft {
  return {
    title: row.title,
    description: row.description ?? "",
    statusId: row.status_id ?? NONE,
    categoryId: row.category_id ?? NONE,
    assigneeId: row.assignee_id ?? NONE,
    deadline: row.deadline ?? "",
  }
}

export function TaskDetailSheet({
  row,
  statuses,
  categories,
  consultants,
  open,
  onOpenChange,
  onSaved,
  onDeleted,
}: {
  row: TaskBoardRow | null
  statuses: TaskStatus[]
  categories: TaskCategory[]
  consultants: Array<{ id: string; name: string }>
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: (row: TaskBoardRow) => void
  onDeleted: (id: string) => void
}) {
  const { t } = useTranslation()
  const { user, isAdmin } = useUser()
  const [draft, setDraft] = React.useState<Draft | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const [activity, setActivity] = React.useState<TaskActivity[] | null>(null)

  // Reload the buffer whenever a different task is opened.
  const rowId = row?.id ?? null
  React.useEffect(() => {
    setDraft(row ? draftFrom(row) : null)
  }, [rowId]) // eslint-disable-line react-hooks/exhaustive-deps

  React.useEffect(() => {
    if (!open || !rowId) {
      setActivity(null)
      return
    }
    let cancelled = false
    void (async () => {
      const supabase = createClient()
      const { data } = await supabase
        .from("task_activity")
        .select("*")
        .eq("task_id", rowId)
        .order("created_at", { ascending: false })
        .limit(50)
      if (!cancelled) setActivity((data ?? []) as TaskActivity[])
    })()
    return () => {
      cancelled = true
    }
  }, [open, rowId])

  if (!row || !draft) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent className="w-full sm:max-w-xl" />
      </Sheet>
    )
  }

  const nameById = new Map(consultants.map((c) => [c.id, c.name]))
  const statusById = new Map(statuses.map((s) => [s.id, s]))
  const canDelete = row.created_by === user?.id || isAdmin
  const dirty =
    draft.title !== row.title ||
    draft.description !== (row.description ?? "") ||
    draft.statusId !== (row.status_id ?? NONE) ||
    draft.categoryId !== (row.category_id ?? NONE) ||
    draft.assigneeId !== (row.assignee_id ?? NONE) ||
    draft.deadline !== (row.deadline ?? "")

  async function handleSave() {
    if (!row || !draft) return
    const trimmed = draft.title.trim()
    if (!trimmed) {
      toast.error(t("tasks.detail.titleRequired", "A task needs a title"))
      return
    }
    setSaving(true)
    const nextAssignee = draft.assigneeId === NONE ? null : draft.assigneeId
    const assigneeChanged = nextAssignee !== row.assignee_id

    const supabase = createClient()
    const { error } = await supabase
      .from("tasks")
      .update({
        title: trimmed,
        description: draft.description.trim() || null,
        status_id: draft.statusId === NONE ? null : draft.statusId,
        category_id: draft.categoryId === NONE ? null : draft.categoryId,
        assignee_id: nextAssignee,
        deadline: draft.deadline || null,
      } as never)
      .eq("id", row.id)

    if (error) {
      setSaving(false)
      toast.error(`${t("tasks.toast.saveFailed", "Couldn't save the task")}: ${error.message}`)
      return
    }

    // Only ping on a genuine handover to someone else.
    if (assigneeChanged && nextAssignee && nextAssignee !== user?.id) {
      const { error: notifyError } = await supabase.rpc(
        "create_task_assignment_notification" as never,
        { p_task_id: row.id, p_recipient_id: nextAssignee } as never,
      )
      if (notifyError) console.error("Task assignment notification failed", notifyError)
    }

    const { data: fresh } = await supabase.from("task_board").select("*").eq("id", row.id).single()
    setSaving(false)
    if (fresh) onSaved(fresh as TaskBoardRow)
    toast.success(t("tasks.toast.saved", "Task saved"))
  }

  async function handleDelete() {
    if (!row) return
    const supabase = createClient()
    const { error } = await supabase.from("tasks").delete().eq("id", row.id)
    if (error) {
      toast.error(`${t("tasks.toast.deleteFailed", "Couldn't delete the task")}: ${error.message}`)
      return
    }
    onDeleted(row.id)
    toast.success(t("tasks.toast.deleted", "Task deleted"))
  }

  function activityLabel(a: TaskActivity): string {
    switch (a.type) {
      case "created":
        return t("tasks.activity.created", "created the task")
      case "status_changed": {
        const to = a.to_status_id ? statusById.get(a.to_status_id)?.label : null
        return `${t("tasks.activity.movedTo", "moved it to")} ${to ?? "—"}`
      }
      case "assigned": {
        const to = a.metadata?.to ? nameById.get(a.metadata.to) : null
        return to
          ? `${t("tasks.activity.assignedTo", "assigned it to")} ${to}`
          : t("tasks.activity.unassigned", "removed the assignee")
      }
      case "comment":
        return a.message ?? ""
      default:
        return a.message ?? t("tasks.activity.updated", "updated the task")
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{row.title}</SheetTitle>
          <SheetDescription>
            {row.created_by_name
              ? `${t("tasks.detail.createdBy", "Created by")} ${row.created_by_name}`
              : t("tasks.detail.createdByUnknown", "Created by an unknown user")}
            {row.customer_name ? ` · ${row.customer_name}` : ""}
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-4 px-4 pb-6">
          <div className="space-y-1.5">
            <Label htmlFor="task-detail-title">{t("tasks.field.title", "Title")}</Label>
            <Input
              id="task-detail-title"
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="task-detail-description">{t("tasks.field.description", "Notes")}</Label>
            <Textarea
              id="task-detail-description"
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              rows={6}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>{t("tasks.field.status", "Status")}</Label>
              <Select
                value={draft.statusId}
                onValueChange={(v) => setDraft({ ...draft, statusId: v })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t("tasks.none", "None")}</SelectItem>
                  {statuses.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>{t("tasks.field.category", "Category")}</Label>
              <Select
                value={draft.categoryId}
                onValueChange={(v) => setDraft({ ...draft, categoryId: v })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t("tasks.none", "None")}</SelectItem>
                  {categories.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>{t("tasks.field.assignee", "Assigned to")}</Label>
              <Select
                value={draft.assigneeId}
                onValueChange={(v) => setDraft({ ...draft, assigneeId: v })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t("tasks.unassigned", "Unassigned")}</SelectItem>
                  {consultants.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="task-detail-deadline">{t("tasks.field.deadline", "Deadline")}</Label>
              <DateInput
                id="task-detail-deadline"
                value={draft.deadline}
                onChange={(v) => setDraft({ ...draft, deadline: v })}
              />
            </div>
          </div>

          {row.customer_id ? (
            <p className="text-sm text-muted-foreground">
              {t("tasks.field.customer", "Customer")}:{" "}
              <Link href={`/customers/${row.customer_id}`} className="underline underline-offset-2">
                {row.customer_name}
              </Link>
            </p>
          ) : null}

          <div className="flex items-center gap-2">
            <Button onClick={handleSave} disabled={saving || !dirty}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              {t("tasks.detail.save", "Save changes")}
            </Button>
            {canDelete ? (
              <Button
                variant="ghost"
                size="icon"
                className="ml-auto text-muted-foreground hover:text-semantic-error"
                onClick={() => setConfirmDelete(true)}
                title={t("tasks.detail.delete", "Delete task")}
              >
                <Trash2 className="size-4" />
                <span className="sr-only">{t("tasks.detail.delete", "Delete task")}</span>
              </Button>
            ) : null}
          </div>

          <Separator />

          <div className="space-y-2">
            <p className="text-sm font-medium">{t("tasks.detail.activity", "Activity")}</p>
            {activity === null ? (
              <p className="text-sm text-muted-foreground">{t("tasks.detail.loading", "Loading…")}</p>
            ) : activity.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("tasks.detail.noActivity", "No activity yet.")}
              </p>
            ) : (
              <ul className="space-y-2">
                {activity.map((a) => (
                  <li key={a.id} className="text-sm">
                    <span className="font-medium">
                      {a.actor_id ? nameById.get(a.actor_id) ?? "—" : t("tasks.activity.system", "System")}
                    </span>{" "}
                    <span className="text-muted-foreground">{activityLabel(a)}</span>
                    <span className="block text-xs text-muted-foreground">
                      {new Date(a.created_at).toLocaleString("sv-SE")}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <ConfirmDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          title={t("tasks.detail.confirmDeleteTitle", "Delete this task?")}
          description={t(
            "tasks.detail.confirmDeleteBody",
            "The task and its history are removed for everyone. This cannot be undone.",
          )}
          confirmLabel={t("tasks.detail.delete", "Delete task")}
          cancelLabel={t("tasks.create.cancel", "Cancel")}
          variant="destructive"
          onConfirm={handleDelete}
        />
      </SheetContent>
    </Sheet>
  )
}
