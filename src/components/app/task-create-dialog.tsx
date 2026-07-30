"use client"

import * as React from "react"
import { Check, Loader2 } from "lucide-react"
import { toast } from "sonner"

import { createClient } from "@/lib/supabase/client"
import { cn } from "@/lib/utils"
import { useTranslation } from "@/hooks/use-translation"
import { useUser } from "@/hooks/use-user"
import type { TaskBoardRow, TaskCategory, TaskStatus } from "@/types/task"
import { Button } from "@/components/ui/button"
import { DateInput } from "@/components/ui/date-input"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

const NONE = "none"

type CustomerOption = {
  id: string
  name: string
  org_number: string | null
  /** Carries the customer↔manager link (each consultant has their own). */
  fortnox_cost_center: string | null
}

export function TaskCreateDialog({
  open,
  onOpenChange,
  statuses,
  categories,
  consultants,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  statuses: TaskStatus[]
  categories: TaskCategory[]
  consultants: Array<{ id: string; name: string; costCenter: string | null }>
  onCreated: (row: TaskBoardRow) => void
}) {
  const { t } = useTranslation()
  const { user } = useUser()
  const [title, setTitle] = React.useState("")
  const [description, setDescription] = React.useState("")
  const [categoryId, setCategoryId] = React.useState<string>(NONE)
  const [assigneeId, setAssigneeId] = React.useState<string>(NONE)
  const [customerId, setCustomerId] = React.useState<string | null>(null)
  const [deadline, setDeadline] = React.useState("")
  const [saving, setSaving] = React.useState(false)

  // Customers load lazily the first time the dialog opens — the picker is
  // optional, so most task creations never need the list at all.
  const [customers, setCustomers] = React.useState<CustomerOption[] | null>(null)
  const [customerQuery, setCustomerQuery] = React.useState("")

  React.useEffect(() => {
    if (!open || customers !== null) return
    let cancelled = false
    void (async () => {
      const supabase = createClient()
      const { data, error } = await supabase
        .from("customers")
        .select("id, name, org_number, fortnox_cost_center")
        .eq("status", "active")
        .order("name")
        .limit(5000)
      if (cancelled) return
      if (error) {
        toast.error(error.message)
        return
      }
      setCustomers((data ?? []) as CustomerOption[])
    })()
    return () => {
      cancelled = true
    }
  }, [open, customers])

  // Reset the form each time the dialog opens so a cancelled draft never leaks
  // into the next task.
  React.useEffect(() => {
    if (!open) return
    setTitle("")
    setDescription("")
    setCategoryId(NONE)
    setAssigneeId(NONE)
    setCustomerId(null)
    setDeadline("")
  }, [open])

  // Map each consultant's cost centre → their id, so a customer's cost centre
  // resolves to its customer manager — the same link the bokslut board uses.
  const ccToConsultant = React.useMemo(() => {
    const m = new Map<string, string>()
    for (const c of consultants) {
      if (c.costCenter && c.costCenter.trim() && !m.has(c.costCenter)) m.set(c.costCenter, c.id)
    }
    return m
  }, [consultants])

  // Picking a customer proposes their customer manager as the assignee. Unlike
  // the bokslut dialog this never clears an existing pick: on a task the
  // assignee is often chosen first and deliberately, so a customer without a
  // resolvable manager must not wipe that choice.
  React.useEffect(() => {
    if (!customerId) return
    const cc = customers?.find((c) => c.id === customerId)?.fortnox_cost_center
    const managerId = cc && cc.trim() ? ccToConsultant.get(cc) : undefined
    if (managerId) setAssigneeId(managerId)
  }, [customerId, customers, ccToConsultant])

  const selectedCustomer = customers?.find((c) => c.id === customerId) ?? null
  const q = customerQuery.trim().toLowerCase()
  const customerMatches = React.useMemo(() => {
    const list = customers ?? []
    const filtered =
      q === ""
        ? list
        : list.filter(
            (c) =>
              c.name.toLowerCase().includes(q) ||
              (c.org_number ?? "").toLowerCase().includes(q),
          )
    return filtered.slice(0, 50)
  }, [customers, q])

  // The leftmost stage, so a new card lands at the start of the pipeline.
  const firstStatus = React.useMemo(
    () => [...statuses].sort((a, b) => a.sort_order - b.sort_order)[0] ?? null,
    [statuses],
  )

  async function handleSubmit() {
    const trimmed = title.trim()
    if (!trimmed || !user?.id) return
    setSaving(true)
    const supabase = createClient()
    const { data, error } = await supabase
      .from("tasks")
      .insert({
        title: trimmed,
        description: description.trim() || null,
        status_id: firstStatus?.id ?? null,
        category_id: categoryId === NONE ? null : categoryId,
        customer_id: customerId,
        assignee_id: assigneeId === NONE ? null : assigneeId,
        created_by: user.id,
        deadline: deadline || null,
      } as never)
      .select("id")
      .single()

    if (error || !data) {
      setSaving(false)
      toast.error(`${t("tasks.toast.createFailed", "Couldn't create the task")}: ${error?.message ?? ""}`)
      return
    }

    const newId = (data as { id: string }).id

    // Tell the assignee, unless they assigned it to themselves.
    if (assigneeId !== NONE && assigneeId !== user.id) {
      const { error: notifyError } = await supabase.rpc(
        "create_task_assignment_notification" as never,
        { p_task_id: newId, p_recipient_id: assigneeId } as never,
      )
      // A missed notification must not look like a failed save — the task is
      // already created and visible on the board.
      if (notifyError) console.error("Task assignment notification failed", notifyError)
    }

    // Read the row back through the board view so the card carries the same
    // denormalized fields as everything else on the board.
    const { data: row } = await supabase.from("task_board").select("*").eq("id", newId).single()
    setSaving(false)
    if (row) onCreated(row as TaskBoardRow)
    toast.success(t("tasks.toast.created", "Task created"))
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("tasks.create.title", "New task")}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="task-title">{t("tasks.field.title", "Title")}</Label>
            <Input
              id="task-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("tasks.create.titlePlaceholder", "What needs doing?")}
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="task-description">{t("tasks.field.description", "Notes")}</Label>
            <Textarea
              id="task-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t(
                "tasks.create.descriptionPlaceholder",
                "What the task involves, background, what's expected…",
              )}
              rows={4}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>{t("tasks.field.category", "Category")}</Label>
              <Select value={categoryId} onValueChange={setCategoryId}>
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
              <Select value={assigneeId} onValueChange={setAssigneeId}>
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
          </div>

          <div className="space-y-1.5">
            <Label>
              {t("tasks.field.customer", "Customer")}{" "}
              <span className="text-xs font-normal text-muted-foreground">
                {t("tasks.field.optional", "(optional)")}
              </span>
            </Label>
            {selectedCustomer ? (
              <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                <span className="truncate">{selectedCustomer.name}</span>
                <Button variant="ghost" size="xs" onClick={() => setCustomerId(null)}>
                  {t("tasks.create.clearCustomer", "Clear")}
                </Button>
              </div>
            ) : (
              <Command className="rounded-md border">
                <CommandInput
                  value={customerQuery}
                  onValueChange={setCustomerQuery}
                  placeholder={t("tasks.create.searchCustomer", "Search customer…")}
                />
                <CommandList className="max-h-40">
                  <CommandEmpty>
                    {customers === null
                      ? t("tasks.create.loadingCustomers", "Loading customers…")
                      : t("tasks.create.noCustomers", "No matches.")}
                  </CommandEmpty>
                  {customerMatches.map((c) => (
                    <CommandItem key={c.id} value={c.name} onSelect={() => setCustomerId(c.id)}>
                      <Check className={cn("size-4", customerId === c.id ? "opacity-100" : "opacity-0")} />
                      <span className="truncate">{c.name}</span>
                    </CommandItem>
                  ))}
                </CommandList>
              </Command>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="task-deadline">{t("tasks.field.deadline", "Deadline")}</Label>
            <DateInput id="task-deadline" value={deadline} onChange={setDeadline} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t("tasks.create.cancel", "Cancel")}
          </Button>
          <Button onClick={handleSubmit} disabled={saving || title.trim() === ""}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            {t("tasks.create.submit", "Create task")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
