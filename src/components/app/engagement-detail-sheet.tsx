"use client"

import * as React from "react"
import Link from "next/link"
import { ChevronDown, Loader2, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { createClient } from "@/lib/supabase/client"
import { cn } from "@/lib/utils"
import { useTranslation } from "@/hooks/use-translation"
import type {
  ChecklistValue,
  EngagementActivity,
  EngagementBoardRow,
  EngagementChecklistField,
  EngagementStatus,
} from "@/types/engagement"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
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

// Click-cycle order for a checklist value: unset → yes → no → na → unset.
const CYCLE: Array<ChecklistValue | undefined> = [undefined, "yes", "no", "na"]
function nextValue(v: ChecklistValue | undefined): ChecklistValue | undefined {
  return CYCLE[(CYCLE.indexOf(v) + 1) % CYCLE.length]
}

function fmtDateTime(value: string): string {
  return new Date(value).toLocaleString("sv-SE", { dateStyle: "medium", timeStyle: "short" })
}

function withStatus(
  row: EngagementBoardRow,
  workflow: "bokslut" | "ink2",
  status: EngagementStatus | null,
): EngagementBoardRow {
  const now = new Date().toISOString()
  if (workflow === "bokslut") {
    return {
      ...row,
      bokslut_status_id: status?.id ?? null,
      bokslut_status_key: status?.key ?? null,
      bokslut_status_label: status?.label ?? null,
      bokslut_status_sort: status?.sort_order ?? null,
      bokslut_status_is_done: status?.is_done ?? null,
      bokslut_status_changed_at: now,
    }
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

export function EngagementDetailSheet({
  row,
  statuses,
  consultants,
  checklistFields,
  userNames,
  open,
  onOpenChange,
  onSaved,
  onDeleted,
}: {
  row: EngagementBoardRow | null
  statuses: EngagementStatus[]
  consultants: Array<{ id: string; name: string }>
  checklistFields: EngagementChecklistField[]
  userNames: Record<string, string>
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: (row: EngagementBoardRow) => void
  onDeleted: (id: string) => void
}) {
  const { t } = useTranslation()
  const [bokslutStatusId, setBokslutStatusId] = React.useState<string>(NONE)
  const [ink2StatusId, setInk2StatusId] = React.useState<string>(NONE)
  const [consultantId, setConsultantId] = React.useState<string>(NONE)
  const [deadline, setDeadline] = React.useState<string>("")
  const [bokslutComment, setBokslutComment] = React.useState<string>("")
  const [nextYearNote, setNextYearNote] = React.useState<string>("")
  const [generalComment, setGeneralComment] = React.useState<string>("")
  const [saving, setSaving] = React.useState(false)
  const [deleteOpen, setDeleteOpen] = React.useState(false)
  const [deleting, setDeleting] = React.useState(false)
  const [activity, setActivity] = React.useState<EngagementActivity[]>([])

  // Checklist: per-year (engagement) values vs durable (customer) values.
  const [yearSetup, setYearSetup] = React.useState<Record<string, ChecklistValue>>({})
  // Durable client setup is read-only here — the customer card owns it.
  const [customerSetup, setCustomerSetup] = React.useState<Record<string, ChecklistValue>>({})

  const bokslutStatuses = React.useMemo(
    () => statuses.filter((s) => s.workflow === "bokslut").sort((a, b) => a.sort_order - b.sort_order),
    [statuses],
  )
  const ink2Statuses = React.useMemo(
    () => statuses.filter((s) => s.workflow === "ink2").sort((a, b) => a.sort_order - b.sort_order),
    [statuses],
  )
  const statusById = React.useMemo(() => new Map(statuses.map((s) => [s.id, s])), [statuses])

  const yearFields = React.useMemo(() => checklistFields.filter((f) => f.scope === "engagement"), [checklistFields])
  const customerFields = React.useMemo(() => checklistFields.filter((f) => f.scope === "customer"), [checklistFields])

  React.useEffect(() => {
    if (!row) return
    setBokslutStatusId(row.bokslut_status_id ?? NONE)
    setInk2StatusId(row.ink2_status_id ?? NONE)
    setConsultantId(row.consultant_id ?? NONE)
    setDeadline(row.deadline ?? "")
    setBokslutComment(row.bokslut_comment ?? "")
    setNextYearNote(row.next_year_note ?? "")
    setGeneralComment(row.general_comment ?? "")
    setYearSetup((row.setup ?? {}) as Record<string, ChecklistValue>)
  }, [row])

  // Load activity and durable customer setup for the open row.
  React.useEffect(() => {
    if (!open || !row) return
    let cancelled = false
    void (async () => {
      const supabase = createClient()
      const [actRes, custRes] = await Promise.all([
        supabase.from("engagement_activity").select("*").eq("engagement_id", row.id).order("created_at", { ascending: false }).limit(100),
        supabase.from("customers").select("bokslut_setup").eq("id", row.customer_id).maybeSingle(),
      ])
      if (cancelled) return
      setActivity((actRes.data ?? []) as EngagementActivity[])
      const cust = custRes.data as { bokslut_setup: Record<string, ChecklistValue> | null } | null
      setCustomerSetup(cust?.bokslut_setup ?? {})
    })()
    return () => {
      cancelled = true
    }
  }, [open, row])

  if (!row) return null

  async function handleSave() {
    if (!row) return
    setSaving(true)
    const supabase = createClient()

    const patch = {
      bokslut_status_id: bokslutStatusId === NONE ? null : bokslutStatusId,
      ink2_status_id: ink2StatusId === NONE ? null : ink2StatusId,
      consultant_id: consultantId === NONE ? null : consultantId,
      deadline: deadline || null,
      bokslut_comment: bokslutComment || null,
      next_year_note: nextYearNote || null,
      general_comment: generalComment || null,
      setup: yearSetup,
    }

    const { error } = await supabase.from("engagements").update(patch as never).eq("id", row.id)
    setSaving(false)
    if (error) {
      toast.error(`${t("engagements.toast.error", "Couldn't update engagement")}: ${error.message}`)
      return
    }

    let merged: EngagementBoardRow = { ...row }
    merged = withStatus(merged, "bokslut", patch.bokslut_status_id ? statusById.get(patch.bokslut_status_id) ?? null : null)
    merged = withStatus(merged, "ink2", patch.ink2_status_id ? statusById.get(patch.ink2_status_id) ?? null : null)
    merged = {
      ...merged,
      consultant_id: patch.consultant_id,
      consultant_name: patch.consultant_id ? consultants.find((c) => c.id === patch.consultant_id)?.name ?? null : null,
      deadline: patch.deadline,
      is_overdue: Boolean(patch.deadline && new Date(patch.deadline) < new Date() && !merged.bokslut_status_is_done),
      bokslut_comment: patch.bokslut_comment,
      next_year_note: patch.next_year_note,
      general_comment: patch.general_comment,
      setup: yearSetup,
    }
    onSaved(merged)
    toast.success(t("engagements.toast.moved", "Status updated"))
    onOpenChange(false)
  }

  async function handleDelete() {
    if (!row) return
    setDeleting(true)
    const supabase = createClient()
    const { error } = await supabase.from("engagements").delete().eq("id", row.id)
    setDeleting(false)
    if (error) {
      toast.error(`${t("engagements.toast.error", "Couldn't update engagement")}: ${error.message}`)
      return
    }
    setDeleteOpen(false)
    onDeleted(row.id)
    toast.success(t("engagements.toast.deleted", "Engagement deleted"))
    onOpenChange(false)
  }

  function renderActivityLine(a: EngagementActivity): string {
    const who = a.actor_id ? userNames[a.actor_id] ?? "—" : "System"
    if (a.type === "created") return `${who} ${t("engagements.activity.created", "created the engagement")}`
    if (a.type === "status_changed") {
      const wf = a.workflow === "ink2" ? "INK2" : "Bokslut"
      const from = a.from_status_id ? statusById.get(a.from_status_id)?.label ?? "—" : t("engagements.noStatus", "No status")
      const to = a.to_status_id ? statusById.get(a.to_status_id)?.label ?? "—" : t("engagements.noStatus", "No status")
      return `${who} • ${wf}: ${from} → ${to}`
    }
    return a.message ?? `${who} • ${a.type}`
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{row.customer_name}</SheetTitle>
          <SheetDescription>
            {row.org_number ? `${row.org_number} · ` : ""}
            {row.fiscal_year_end}
            {row.group_name ? ` · ${row.group_name}` : ""}
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-4 px-4 pb-6">
          <div className="grid grid-cols-1 gap-3">
            <div className="space-y-1.5">
              <Label>{t("engagements.detail.bokslutStatus", "Bokslut status")}</Label>
              <StatusSelect value={bokslutStatusId} onChange={setBokslutStatusId} options={bokslutStatuses} t={t} />
            </div>
            <div className="space-y-1.5">
              <Label>{t("engagements.detail.ink2Status", "INK2 status")}</Label>
              <StatusSelect value={ink2StatusId} onChange={setInk2StatusId} options={ink2Statuses} t={t} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t("engagements.detail.consultant", "Consultant")}</Label>
              <Select value={consultantId} onValueChange={setConsultantId}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="—" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>—</SelectItem>
                  {consultants.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="eng-deadline">{t("engagements.detail.deadline", "Deadline")}</Label>
              <Input id="eng-deadline" type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
            </div>
          </div>

          {/* Per-year material checklist (resets each fiscal year). */}
          {yearFields.length > 0 ? (
            <ChecklistGroup
              title={t("engagements.detail.thisYear", "This year")}
              fields={yearFields}
              values={yearSetup}
              onCycle={(key) => setYearSetup((cur) => applyCycle(cur, key))}
            />
          ) : null}

          {/* Durable client setup — read-only here; the customer card owns it. */}
          {customerFields.length > 0 ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label>{t("engagements.detail.clientSetup", "Client setup")}</Label>
                <Link
                  href={`/customers/${row.customer_id}`}
                  className="text-xs text-primary hover:underline"
                >
                  {t("engagements.detail.editOnCustomer", "Edit on customer")}
                </Link>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {customerFields.map((f) => {
                  const value = customerSetup[f.key]
                  return (
                    <Badge
                      key={f.key}
                      variant="outline"
                      className={cn(
                        "gap-1 text-[11px]",
                        value === "yes" && "border-semantic-success/40 text-semantic-success",
                        value === "no" && "border-semantic-error/40 text-semantic-error",
                        (value === "na" || value === undefined) && "text-muted-foreground",
                      )}
                    >
                      {f.label}: {value === "yes" ? "Ja" : value === "no" ? "Nej" : value === "na" ? "–" : "?"}
                    </Badge>
                  )
                })}
              </div>
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="eng-bokslut-comment">{t("engagements.detail.bokslutComment", "Bokslut comment")}</Label>
            <Textarea id="eng-bokslut-comment" rows={2} value={bokslutComment} onChange={(e) => setBokslutComment(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="eng-next-year">{t("engagements.detail.nextYearNote", "For next year")}</Label>
            <Textarea id="eng-next-year" rows={2} value={nextYearNote} onChange={(e) => setNextYearNote(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="eng-general">{t("engagements.detail.generalComment", "General comment")}</Label>
            <Textarea id="eng-general" rows={2} value={generalComment} onChange={(e) => setGeneralComment(e.target.value)} />
          </div>

          <Button onClick={handleSave} disabled={saving} className="w-full">
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            {saving ? t("engagements.detail.saving", "Saving…") : t("engagements.detail.save", "Save changes")}
          </Button>

          <Separator />

          <Collapsible>
            <CollapsibleTrigger className="group flex w-full cursor-pointer items-center justify-between gap-2 rounded-md py-1 text-left">
              <span className="flex items-center gap-2 text-sm font-medium">
                {t("engagements.detail.activity", "Activity")}
                {activity.length > 0 ? (
                  <Badge variant="outline" className="text-[11px]">
                    {activity.length}
                  </Badge>
                ) : null}
              </span>
              <ChevronDown className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-2">
              {activity.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("engagements.detail.noActivity", "No activity yet.")}</p>
              ) : (
                <ul className="space-y-2">
                  {activity.map((a) => (
                    <li key={a.id} className="text-xs">
                      <p className="text-foreground">{renderActivityLine(a)}</p>
                      <p className="text-muted-foreground">{fmtDateTime(a.created_at)}</p>
                    </li>
                  ))}
                </ul>
              )}
            </CollapsibleContent>
          </Collapsible>

          <Separator />

          <Button
            variant="ghost"
            onClick={() => setDeleteOpen(true)}
            className="w-full text-semantic-error hover:bg-semantic-error/10 hover:text-semantic-error"
          >
            <Trash2 className="size-4" />
            {t("engagements.detail.delete", "Delete engagement")}
          </Button>
        </div>
      </SheetContent>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={(o) => {
          if (!deleting) setDeleteOpen(o)
        }}
        title={t("engagements.delete.title", "Delete engagement")}
        description={t(
          "engagements.delete.description",
          "This permanently removes the engagement and its activity history. Client setup on the customer is kept. This can't be undone.",
        )}
        confirmLabel={t("engagements.detail.delete", "Delete engagement")}
        variant="destructive"
        loading={deleting}
        onConfirm={handleDelete}
      />
    </Sheet>
  )
}

function applyCycle(
  cur: Record<string, ChecklistValue>,
  key: string,
): Record<string, ChecklistValue> {
  const next = nextValue(cur[key])
  const updated = { ...cur }
  if (next === undefined) delete updated[key]
  else updated[key] = next
  return updated
}

function ChecklistGroup({
  title,
  fields,
  values,
  onCycle,
}: {
  title: string
  fields: EngagementChecklistField[]
  values: Record<string, ChecklistValue>
  onCycle: (key: string) => void
}) {
  return (
    <div className="space-y-2">
      <Label>{title}</Label>
      <div className="flex flex-wrap gap-1.5">
        {fields.map((f) => {
          const value = values[f.key]
          return (
            <button
              key={f.key}
              type="button"
              onClick={() => onCycle(f.key)}
              className={cn(
                "inline-flex cursor-pointer items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
                value === "yes" && "border-semantic-success/40 bg-semantic-success/10 text-semantic-success",
                value === "no" && "border-semantic-error/40 bg-semantic-error/10 text-semantic-error",
                value === "na" && "border-border bg-muted text-muted-foreground",
                value === undefined && "border-dashed border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )}
            >
              {f.label}
              <span className="opacity-70">
                {value === "yes" ? "Ja" : value === "no" ? "Nej" : value === "na" ? "–" : "?"}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function StatusSelect({
  value,
  onChange,
  options,
  t,
}: {
  value: string
  onChange: (value: string) => void
  options: EngagementStatus[]
  t: (key: string, fallback?: string) => string
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>{t("engagements.noStatus", "No status")}</SelectItem>
        {options.map((s) => (
          <SelectItem key={s.id} value={s.id}>
            {s.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
