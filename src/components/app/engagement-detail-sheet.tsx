"use client"

import * as React from "react"
import Link from "next/link"
import { Check, ChevronDown, ChevronRight, Download, Loader2, MessageSquare, Paperclip, Pencil, Send, Trash2, Upload, X } from "lucide-react"
import { toast } from "sonner"

import { createClient } from "@/lib/supabase/client"
import { cn, formatBytes } from "@/lib/utils"
import { deadlineForFiscalYearEnd } from "@/lib/engagements/fiscal-year"
import { useTranslation } from "@/hooks/use-translation"
import { useUser } from "@/hooks/use-user"
import type {
  ChecklistValue,
  EngagementActivity,
  EngagementAttachment,
  EngagementBoardRow,
  EngagementChecklistField,
  EngagementComment,
  EngagementStatus,
} from "@/types/engagement"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { UserAvatar } from "@/components/app/user-avatar"
import { DateInput } from "@/components/ui/date-input"
import { Label } from "@/components/ui/label"
import { MentionTextarea, extractMentionIds } from "@/components/app/mention-textarea"
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

const STORAGE_BUCKET =
  process.env.NEXT_PUBLIC_SUPABASE_FILES_BUCKET ?? "crm-files"

// Attachment upload constraints (mirrors the product decision: 25 MB, common
// document types). Enforced client-side; the storage RLS prefix gates access.
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
const ALLOWED_ATTACHMENT_EXTENSIONS = [
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "csv",
  "txt",
  "zip",
]

function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".")
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ""
}

// Click-cycle order for a checklist value: unset → yes → no → na → unset.
const CYCLE: Array<ChecklistValue | undefined> = [undefined, "yes", "no", "na"]
function nextValue(v: ChecklistValue | undefined): ChecklistValue | undefined {
  return CYCLE[(CYCLE.indexOf(v) + 1) % CYCLE.length]
}

function fmtDateTime(value: string): string {
  return new Date(value).toLocaleString("sv-SE", { dateStyle: "medium", timeStyle: "short" })
}

// Stable, order-independent serialization of the checklist map for change
// detection (object key order must not register as a change).
function sortedSetup(setup: Record<string, ChecklistValue>): Record<string, ChecklistValue> {
  const out: Record<string, ChecklistValue> = {}
  for (const key of Object.keys(setup).sort()) out[key] = setup[key]
  return out
}

// A signature of just the editable fields, so we can tell whether the sheet has
// unsaved edits (current signature ≠ the row's saved baseline).
function editableSignature(v: {
  bokslutStatusId: string
  ink2StatusId: string
  coConsultantId: string
  deadline: string
  bokslutComment: string
  nextYearNote: string
  generalComment: string
  setup: Record<string, ChecklistValue>
}): string {
  return JSON.stringify({
    b: v.bokslutStatusId,
    i: v.ink2StatusId,
    c: v.coConsultantId,
    d: v.deadline,
    bc: v.bokslutComment,
    ny: v.nextYearNote,
    g: v.generalComment,
    s: sortedSetup(v.setup),
  })
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
  deadlineOffsetMonths,
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
  deadlineOffsetMonths: number
  userNames: Record<string, string>
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: (row: EngagementBoardRow) => void
  onDeleted: (id: string) => void
}) {
  const { t } = useTranslation()
  const { user, isAdmin } = useUser()
  // Mentions already present when the sheet opened — so we only notify on newly
  // added @-mentions, not every save.
  const initialMentionIdsRef = React.useRef<Set<string>>(new Set())
  const [bokslutStatusId, setBokslutStatusId] = React.useState<string>(NONE)
  const [ink2StatusId, setInk2StatusId] = React.useState<string>(NONE)
  const [consultantId, setConsultantId] = React.useState<string>(NONE)
  const [coConsultantId, setCoConsultantId] = React.useState<string>(NONE)
  const [deadline, setDeadline] = React.useState<string>("")
  const [bokslutComment, setBokslutComment] = React.useState<string>("")
  const [nextYearNote, setNextYearNote] = React.useState<string>("")
  const [generalComment, setGeneralComment] = React.useState<string>("")
  const [saving, setSaving] = React.useState(false)
  const [deleteOpen, setDeleteOpen] = React.useState(false)
  const [deleting, setDeleting] = React.useState(false)
  const [activity, setActivity] = React.useState<EngagementActivity[]>([])

  // Comments — a threaded feed (distinct posts, each with author + timestamp),
  // shown in the column beside the form.
  const [comments, setComments] = React.useState<EngagementComment[]>([])
  const [newComment, setNewComment] = React.useState<string>("")
  const [postingComment, setPostingComment] = React.useState(false)
  const [editingCommentId, setEditingCommentId] = React.useState<string | null>(null)
  const [editingBody, setEditingBody] = React.useState<string>("")
  const [savingEdit, setSavingEdit] = React.useState(false)
  const [deletingCommentId, setDeletingCommentId] = React.useState<string | null>(null)
  const [commentsOpen, setCommentsOpen] = React.useState(true)

  // Attachments
  const [attachments, setAttachments] = React.useState<EngagementAttachment[]>([])
  const [uploading, setUploading] = React.useState(false)
  const [deletingAttachmentId, setDeletingAttachmentId] = React.useState<string | null>(null)
  const fileInputRef = React.useRef<HTMLInputElement>(null)

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

  // Unsaved-changes guard: compare the live form against the row's saved
  // baseline. If the user edited anything and tries to close, prompt first —
  // same UX as the customer cards (common.unsavedChanges.* copy).
  const [confirmClose, setConfirmClose] = React.useState(false)
  const savedSignature = React.useMemo(
    () =>
      row
        ? editableSignature({
            bokslutStatusId: row.bokslut_status_id ?? NONE,
            ink2StatusId: row.ink2_status_id ?? NONE,
            coConsultantId: row.co_consultant_id ?? NONE,
            deadline: row.deadline ?? "",
            bokslutComment: row.bokslut_comment ?? "",
            nextYearNote: row.next_year_note ?? "",
            generalComment: row.general_comment ?? "",
            setup: (row.setup ?? {}) as Record<string, ChecklistValue>,
          })
        : "",
    [row],
  )
  const currentSignature = editableSignature({
    bokslutStatusId,
    ink2StatusId,
    coConsultantId,
    deadline,
    bokslutComment,
    nextYearNote,
    generalComment,
    setup: yearSetup,
  })
  const dirty = !!row && open && savedSignature !== currentSignature

  // Intercept close attempts (X, overlay click, Escape). Save/Delete call
  // onOpenChange(false) directly and so are never blocked by this guard.
  const requestClose = React.useCallback(
    (next: boolean) => {
      if (next) {
        onOpenChange(true)
        return
      }
      if (dirty) {
        setConfirmClose(true)
        return
      }
      onOpenChange(false)
    },
    [dirty, onOpenChange],
  )

  React.useEffect(() => {
    if (!row) return
    setBokslutStatusId(row.bokslut_status_id ?? NONE)
    setInk2StatusId(row.ink2_status_id ?? NONE)
    setConsultantId(row.consultant_id ?? NONE)
    setCoConsultantId(row.co_consultant_id ?? NONE)
    setDeadline(row.deadline ?? "")
    setBokslutComment(row.bokslut_comment ?? "")
    setNextYearNote(row.next_year_note ?? "")
    setGeneralComment(row.general_comment ?? "")
    setYearSetup((row.setup ?? {}) as Record<string, ChecklistValue>)
    const initialText = `${row.bokslut_comment ?? ""}\n${row.next_year_note ?? ""}\n${row.general_comment ?? ""}`
    initialMentionIdsRef.current = new Set(extractMentionIds(initialText, consultants))
  }, [row, consultants])

  // Load activity and durable customer setup for the open row.
  React.useEffect(() => {
    if (!open || !row) return
    let cancelled = false
    void (async () => {
      const supabase = createClient()
      const [actRes, custRes, attRes, comRes] = await Promise.all([
        supabase.from("engagement_activity").select("*").eq("engagement_id", row.id).order("created_at", { ascending: false }).limit(100),
        supabase.from("customers").select("bokslut_setup").eq("id", row.customer_id).maybeSingle(),
        supabase.from("engagement_attachments").select("*").eq("engagement_id", row.id).order("created_at", { ascending: false }),
        supabase.from("engagement_comments").select("*").eq("engagement_id", row.id).order("created_at", { ascending: true }),
      ])
      if (cancelled) return
      setActivity((actRes.data ?? []) as EngagementActivity[])
      const cust = custRes.data as { bokslut_setup: Record<string, ChecklistValue> | null } | null
      setCustomerSetup(cust?.bokslut_setup ?? {})
      setAttachments((attRes.data ?? []) as EngagementAttachment[])
      setComments((comRes.data ?? []) as EngagementComment[])
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
      // consultant_id + group_name are derived from the customer; not editable here.
      co_consultant_id: coConsultantId === NONE ? null : coConsultantId,
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

    // Notify newly @-mentioned consultants (excluding self and anyone already
    // mentioned before this edit). Best-effort — never blocks the save.
    const mentionText = `${bokslutComment}\n${nextYearNote}\n${generalComment}`
    const mentionedIds = extractMentionIds(mentionText, consultants)
    const newRecipientIds = mentionedIds.filter(
      (cid) => cid !== user?.id && !initialMentionIdsRef.current.has(cid),
    )
    if (newRecipientIds.length > 0) {
      await supabase.rpc("create_engagement_mention_notifications" as never, {
        p_engagement_id: row.id,
        p_recipient_ids: newRecipientIds,
      } as never)
      initialMentionIdsRef.current = new Set(mentionedIds)
    }

    let merged: EngagementBoardRow = { ...row }
    merged = withStatus(merged, "bokslut", patch.bokslut_status_id ? statusById.get(patch.bokslut_status_id) ?? null : null)
    merged = withStatus(merged, "ink2", patch.ink2_status_id ? statusById.get(patch.ink2_status_id) ?? null : null)
    merged = {
      ...merged,
      co_consultant_id: patch.co_consultant_id,
      co_consultant_name: patch.co_consultant_id ? consultants.find((c) => c.id === patch.co_consultant_id)?.name ?? null : null,
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

  async function handleUploadFiles(files: FileList | null) {
    if (!row || !files || files.length === 0) return
    const supabase = createClient()
    setUploading(true)
    try {
      for (const file of Array.from(files)) {
        const ext = fileExtension(file.name)
        if (!ALLOWED_ATTACHMENT_EXTENSIONS.includes(ext)) {
          toast.error(
            `${file.name}: ${t("engagements.detail.attachmentsBadType", "That file type isn't allowed")}`,
          )
          continue
        }
        if (file.size > MAX_ATTACHMENT_BYTES) {
          toast.error(
            `${file.name}: ${t("engagements.detail.attachmentsTooLarge", "File is too large (max 25 MB)")}`,
          )
          continue
        }

        const path = `engagements/${row.id}/${crypto.randomUUID()}.${ext}`
        const { error: uploadError } = await supabase.storage
          .from(STORAGE_BUCKET)
          .upload(path, file, {
            contentType: file.type || undefined,
            upsert: false,
          })
        if (uploadError) {
          toast.error(
            `${file.name}: ${t("engagements.detail.attachmentsUploadFailed", "Upload failed")}`,
          )
          continue
        }

        const { data: inserted, error: insertError } = await supabase
          .from("engagement_attachments")
          .insert({
            engagement_id: row.id,
            storage_path: path,
            file_name: file.name,
            file_type: file.type || null,
            file_size: file.size,
          } as never)
          .select("*")
          .single()

        if (insertError || !inserted) {
          // Roll back the orphaned storage object if the metadata insert failed.
          await supabase.storage.from(STORAGE_BUCKET).remove([path])
          toast.error(
            `${file.name}: ${t("engagements.detail.attachmentsUploadFailed", "Upload failed")}`,
          )
          continue
        }

        setAttachments((cur) => [inserted as EngagementAttachment, ...cur])
        toast.success(t("engagements.detail.attachmentsUploaded", "File attached"))
      }
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
  }

  async function handleOpenAttachment(att: EngagementAttachment) {
    const supabase = createClient()
    const { data, error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .createSignedUrl(att.storage_path, 60)
    if (error || !data?.signedUrl) {
      toast.error(t("engagements.detail.attachmentsOpenFailed", "Couldn't open file"))
      return
    }
    window.open(data.signedUrl, "_blank", "noopener,noreferrer")
  }

  async function handleDeleteAttachment(att: EngagementAttachment) {
    const supabase = createClient()
    setDeletingAttachmentId(att.id)
    const { error: removeError } = await supabase.storage
      .from(STORAGE_BUCKET)
      .remove([att.storage_path])
    // Even if the object is already gone, proceed to clear the metadata row.
    const { error: dbError } = await supabase
      .from("engagement_attachments")
      .delete()
      .eq("id", att.id)
    setDeletingAttachmentId(null)
    if (dbError || removeError) {
      toast.error(t("engagements.detail.attachmentsDeleteFailed", "Couldn't remove file"))
      if (dbError) return
    }
    setAttachments((cur) => cur.filter((a) => a.id !== att.id))
    toast.success(t("engagements.detail.attachmentsDeleted", "File removed"))
  }

  // Notify newly @-mentioned consultants in a comment (excludes self).
  async function notifyMentions(text: string) {
    if (!row) return
    const supabase = createClient()
    const mentionedIds = extractMentionIds(text, consultants).filter((cid) => cid !== user?.id)
    if (mentionedIds.length === 0) return
    await supabase.rpc("create_engagement_mention_notifications" as never, {
      p_engagement_id: row.id,
      p_recipient_ids: mentionedIds,
    } as never)
  }

  async function handlePostComment() {
    if (!row) return
    const body = newComment.trim()
    if (!body) return
    setPostingComment(true)
    const supabase = createClient()
    const { data, error } = await supabase
      .from("engagement_comments")
      .insert({ engagement_id: row.id, author_id: user?.id ?? null, body } as never)
      .select("*")
      .single()
    setPostingComment(false)
    if (error || !data) {
      toast.error(`${t("engagements.detail.comments.error", "Couldn't post comment")}: ${error?.message ?? ""}`)
      return
    }
    setComments((cur) => [...cur, data as EngagementComment])
    setNewComment("")
    await notifyMentions(body)
  }

  function handleStartEdit(c: EngagementComment) {
    setEditingCommentId(c.id)
    setEditingBody(c.body)
  }

  function handleCancelEdit() {
    setEditingCommentId(null)
    setEditingBody("")
  }

  async function handleSaveEdit(c: EngagementComment) {
    const body = editingBody.trim()
    if (!body) return
    setSavingEdit(true)
    const supabase = createClient()
    const { data, error } = await supabase
      .from("engagement_comments")
      .update({ body } as never)
      .eq("id", c.id)
      .select("*")
      .single()
    setSavingEdit(false)
    if (error || !data) {
      toast.error(`${t("engagements.detail.comments.error", "Couldn't save comment")}: ${error?.message ?? ""}`)
      return
    }
    setComments((cur) => cur.map((x) => (x.id === c.id ? (data as EngagementComment) : x)))
    handleCancelEdit()
    await notifyMentions(body)
  }

  async function handleDeleteComment(c: EngagementComment) {
    setDeletingCommentId(c.id)
    const supabase = createClient()
    const { error } = await supabase.from("engagement_comments").delete().eq("id", c.id)
    setDeletingCommentId(null)
    if (error) {
      toast.error(`${t("engagements.detail.comments.error", "Couldn't delete comment")}: ${error.message}`)
      return
    }
    setComments((cur) => cur.filter((x) => x.id !== c.id))
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
    <Sheet open={open} onOpenChange={requestClose}>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-3xl">
        <SheetHeader className="border-b pr-12">
          <SheetTitle>{row.customer_name}</SheetTitle>
          <SheetDescription>
            {row.org_number ? `${row.org_number} · ` : ""}
            {row.fiscal_year_end}
            {row.group_name ? ` · ${row.group_name}` : ""}
          </SheetDescription>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
        <div className="flex flex-col gap-4 px-4 pb-6 pt-4 lg:flex-1 lg:overflow-y-auto lg:border-r">
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
            {/* Consultant + group are derived from the customer / customer
                manager — shown here read-only. */}
            <div className="space-y-1.5">
              <Label>{t("engagements.detail.consultant", "Consultant")}</Label>
              <div className="flex h-9 w-full items-center rounded-md border bg-muted/30 px-3 text-sm text-muted-foreground">
                {row.consultant_name ?? "—"}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>{t("engagements.detail.group", "Group")}</Label>
              <div className="flex h-9 w-full items-center rounded-md border bg-muted/30 px-3 text-sm text-muted-foreground">
                {row.group_name ?? "—"}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t("engagements.detail.coConsultant", "Co-helper")}</Label>
              <Select value={coConsultantId} onValueChange={setCoConsultantId}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="—" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>—</SelectItem>
                  {consultants
                    .filter((c) => c.id !== row.consultant_id)
                    .map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="eng-deadline">{t("engagements.detail.deadline", "Deadline")}</Label>
                <button
                  type="button"
                  className="cursor-pointer text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  title={t("engagements.detail.deadlineAutoHint", "Set to fiscal year-end + {months} months").replace("{months}", String(deadlineOffsetMonths))}
                  onClick={() => setDeadline(deadlineForFiscalYearEnd(row?.fiscal_year_end, deadlineOffsetMonths))}
                >
                  {t("engagements.detail.deadlineAuto", "Auto")}
                </button>
              </div>
              <DateInput id="eng-deadline" value={deadline} onChange={setDeadline} />
            </div>
          </div>

          {/* Setup checklists (This year / Client setup) intentionally not shown
              here — they live on the customer card. */}

          <div className="space-y-1.5">
            <Label htmlFor="eng-bokslut-comment">{t("engagements.detail.bokslutComment", "Bokslut comment")}</Label>
            <MentionTextarea id="eng-bokslut-comment" rows={2} people={consultants} value={bokslutComment} onChange={setBokslutComment} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="eng-next-year">{t("engagements.detail.nextYearNote", "For next year")}</Label>
            <MentionTextarea id="eng-next-year" rows={2} people={consultants} value={nextYearNote} onChange={setNextYearNote} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="eng-general">{t("engagements.detail.generalComment", "General comment")}</Label>
            <MentionTextarea id="eng-general" rows={2} people={consultants} value={generalComment} onChange={setGeneralComment} />
          </div>

          <Button onClick={handleSave} disabled={saving} className="w-full">
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            {saving ? t("engagements.detail.saving", "Saving…") : t("engagements.detail.save", "Save changes")}
          </Button>

          <Separator />

          {/* Attachments — source files / supporting docs for this engagement. */}
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label className="flex items-center gap-2">
                <Paperclip className="size-4 text-muted-foreground" />
                {t("engagements.detail.attachments", "Attachments")}
                {attachments.length > 0 ? (
                  <Badge variant="outline" className="text-[11px]">
                    {attachments.length}
                  </Badge>
                ) : null}
              </Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={uploading}
                onClick={() => fileInputRef.current?.click()}
              >
                {uploading ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Upload className="size-4" />
                )}
                {uploading
                  ? t("engagements.detail.attachmentsUploading", "Uploading…")
                  : t("engagements.detail.attachmentsAdd", "Add file")}
              </Button>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              accept={ALLOWED_ATTACHMENT_EXTENSIONS.map((e) => `.${e}`).join(",")}
              onChange={(e) => handleUploadFiles(e.target.files)}
            />

            {attachments.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("engagements.detail.attachmentsEmpty", "No files attached yet.")}
              </p>
            ) : (
              <ul className="space-y-1.5">
                {attachments.map((att) => (
                  <li
                    key={att.id}
                    className="flex items-center gap-2 rounded-md border p-2"
                  >
                    <button
                      type="button"
                      onClick={() => handleOpenAttachment(att)}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      title={att.file_name}
                    >
                      <Download className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {att.file_name}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {formatBytes(att.file_size)} · {fmtDateTime(att.created_at)}
                        </span>
                      </span>
                    </button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7 shrink-0 text-muted-foreground hover:text-semantic-error"
                      disabled={deletingAttachmentId === att.id}
                      onClick={() => handleDeleteAttachment(att)}
                    >
                      {deletingAttachmentId === att.id ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="size-3.5" />
                      )}
                      <span className="sr-only">
                        {t("engagements.detail.attachmentsRemove", "Remove file")}
                      </span>
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            <p className="text-xs text-muted-foreground">
              {t(
                "engagements.detail.attachmentsHint",
                "Up to 25 MB. PDF, Office, images, CSV, TXT or ZIP.",
              )}
            </p>
          </div>

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

        {/* Comments — a threaded feed beside the form. Each post shows its
            author and when it was made; authors can edit/delete their own
            (admins can delete any). */}
        <div
          className={cn(
            "flex w-full shrink-0 flex-col border-t lg:border-t-0 lg:overflow-hidden",
            commentsOpen ? "lg:w-96" : "lg:w-12",
          )}
        >
          {!commentsOpen ? (
            <button
              type="button"
              onClick={() => setCommentsOpen(true)}
              title={t("engagements.detail.comments.show", "Show comments")}
              className="flex cursor-pointer items-center gap-2 px-4 py-3 text-sm font-medium text-muted-foreground hover:text-foreground lg:h-full lg:flex-col lg:gap-3 lg:px-0 lg:py-4"
            >
              <MessageSquare className="size-4" />
              <span className="lg:hidden">
                {t("engagements.detail.comments.title", "Comments")}
              </span>
              {comments.length > 0 ? (
                <Badge variant="outline" className="text-[11px]">
                  {comments.length}
                </Badge>
              ) : null}
            </button>
          ) : (
          <>
          <div className="flex items-center gap-2 border-b px-4 py-3">
            <MessageSquare className="size-4 text-muted-foreground" />
            <span className="text-sm font-medium">
              {t("engagements.detail.comments.title", "Comments")}
            </span>
            {comments.length > 0 ? (
              <Badge variant="outline" className="text-[11px]">
                {comments.length}
              </Badge>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="ml-auto text-muted-foreground"
              onClick={() => setCommentsOpen(false)}
              title={t("engagements.detail.comments.hide", "Collapse comments")}
            >
              <ChevronRight className="size-4" />
              <span className="sr-only">
                {t("engagements.detail.comments.hide", "Collapse comments")}
              </span>
            </Button>
          </div>

          <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3 lg:min-h-0">
            {comments.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("engagements.detail.comments.empty", "No comments yet.")}
              </p>
            ) : (
              comments.map((c) => {
                const authorName = c.author_id
                  ? userNames[c.author_id] ??
                    consultants.find((x) => x.id === c.author_id)?.name ??
                    "—"
                  : "—"
                const canEdit = !!user?.id && c.author_id === user.id
                const canDelete = canEdit || isAdmin
                const edited = c.updated_at !== c.created_at
                const isEditing = editingCommentId === c.id
                return (
                  <div key={c.id} className="group flex gap-2.5">
                    <UserAvatar name={authorName} size="sm" className="mt-0.5 shrink-0" />
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="truncate text-sm font-medium">{authorName}</span>
                        <span className="text-xs text-muted-foreground">
                          {fmtDateTime(c.created_at)}
                          {edited ? ` · ${t("engagements.detail.comments.edited", "edited")}` : ""}
                        </span>
                      </div>
                      {isEditing ? (
                        <div className="space-y-2">
                          <MentionTextarea
                            id={`eng-comment-edit-${c.id}`}
                            rows={2}
                            people={consultants}
                            value={editingBody}
                            onChange={setEditingBody}
                          />
                          <div className="flex gap-2">
                            <Button
                              size="xs"
                              onClick={() => handleSaveEdit(c)}
                              disabled={savingEdit || !editingBody.trim()}
                            >
                              {savingEdit ? (
                                <Loader2 className="size-3.5 animate-spin" />
                              ) : (
                                <Check className="size-3.5" />
                              )}
                              {t("common.save", "Save")}
                            </Button>
                            <Button
                              size="xs"
                              variant="ghost"
                              onClick={handleCancelEdit}
                              disabled={savingEdit}
                            >
                              <X className="size-3.5" />
                              {t("common.cancel", "Cancel")}
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <p className="whitespace-pre-wrap break-words text-sm text-foreground">
                            {c.body}
                          </p>
                          {canDelete ? (
                            <div className="flex gap-3 pt-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                              {canEdit ? (
                                <button
                                  type="button"
                                  onClick={() => handleStartEdit(c)}
                                  className="inline-flex cursor-pointer items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                                >
                                  <Pencil className="size-3" />
                                  {t("common.edit", "Edit")}
                                </button>
                              ) : null}
                              <button
                                type="button"
                                onClick={() => handleDeleteComment(c)}
                                disabled={deletingCommentId === c.id}
                                className="inline-flex cursor-pointer items-center gap-1 text-xs text-muted-foreground hover:text-semantic-error"
                              >
                                {deletingCommentId === c.id ? (
                                  <Loader2 className="size-3 animate-spin" />
                                ) : (
                                  <Trash2 className="size-3" />
                                )}
                                {t("common.delete", "Delete")}
                              </button>
                            </div>
                          ) : null}
                        </>
                      )}
                    </div>
                  </div>
                )
              })
            )}
          </div>

          <div className="space-y-2 border-t p-3">
            <MentionTextarea
              id="eng-new-comment"
              rows={2}
              people={consultants}
              value={newComment}
              onChange={setNewComment}
            />
            <Button
              size="sm"
              className="w-full"
              onClick={handlePostComment}
              disabled={postingComment || !newComment.trim()}
            >
              {postingComment ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Send className="size-4" />
              )}
              {t("engagements.detail.comments.post", "Post comment")}
            </Button>
          </div>
          </>
          )}
        </div>
        </div>
      </SheetContent>

      <ConfirmDialog
        open={confirmClose}
        onOpenChange={setConfirmClose}
        title={t("common.unsavedChanges.title", "Leave without saving?")}
        description={t(
          "common.unsavedChanges.description",
          "You have unsaved changes. If you leave now, they will be lost.",
        )}
        confirmLabel={t("common.unsavedChanges.leave", "Leave without saving")}
        cancelLabel={t("common.unsavedChanges.stay", "Stay")}
        variant="destructive"
        onConfirm={() => {
          setConfirmClose(false)
          onOpenChange(false)
        }}
      />

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
