"use client"

import * as React from "react"
import {
  Archive,
  ArrowRightLeft,
  Bell,
  CalendarClock,
  FileText,
  Loader2,
  Mail,
  Pencil,
  Phone,
  Plus,
  ShieldAlert,
  StickyNote,
  Trash2,
  Trophy,
  XCircle,
  type LucideIcon,
} from "lucide-react"
import { toast } from "sonner"

import { createClient } from "@/lib/supabase/client"
import type {
  LeadActivity,
  LeadActivityType,
  WebsiteLeadStatus,
} from "@/types/database"
import { useTranslation } from "@/hooks/use-translation"
import { useUser } from "@/hooks/use-user"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"

// Preset actions a consultant can log. The activity log is the single source
// of truth for lead status — logging an action moves the pipeline (see
// deriveStatus below). 'status_change' is legacy (from the removed status
// dropdown) and only kept so old rows still render.
const LOGGABLE_ACTIONS: LeadActivityType[] = [
  "called",
  "emailed",
  "meeting_booked",
  "offer_sent",
  "follow_up",
  "note",
  "won",
  "lost",
  "archived",
  "spam",
]

const ACTION_LABEL: Record<LeadActivityType, string> = {
  called: "Called",
  emailed: "Sent email",
  meeting_booked: "Meeting booked",
  offer_sent: "Offer sent",
  follow_up: "Follow-up planned",
  note: "Note",
  status_change: "Status changed",
  won: "Won — deal closed",
  lost: "Lost — declined",
  archived: "Archived",
  spam: "Marked as spam",
}

const ACTION_ICON: Record<LeadActivityType, LucideIcon> = {
  called: Phone,
  emailed: Mail,
  meeting_booked: CalendarClock,
  offer_sent: FileText,
  follow_up: Bell,
  note: StickyNote,
  status_change: ArrowRightLeft,
  won: Trophy,
  lost: XCircle,
  archived: Archive,
  spam: ShieldAlert,
}

/** English fallbacks for the status names used in the auto-update toast. */
const STATUS_TOAST_LABEL: Record<WebsiteLeadStatus, string> = {
  new: "New",
  contacted: "Contacted",
  offer_sent: "Offer sent",
  won: "Won",
  lost: "Lost",
  archived: "Archived",
  spam: "Spam",
}

/**
 * What logging an action does to the lead status. Returns the new status, or
 * null when the action shouldn't move the pipeline. Status only ever moves
 * forward automatically: outreach promotes 'new' to 'contacted', an offer
 * promotes to 'offer_sent', and outcome actions set the final state.
 */
function deriveStatus(
  action: LeadActivityType,
  current: WebsiteLeadStatus,
): WebsiteLeadStatus | null {
  switch (action) {
    case "called":
    case "emailed":
    case "meeting_booked":
      return current === "new" ? "contacted" : null
    case "offer_sent":
      return current === "new" || current === "contacted"
        ? "offer_sent"
        : null
    case "won":
      return "won"
    case "lost":
      return "lost"
    case "archived":
      return "archived"
    case "spam":
      return "spam"
    default:
      return null
  }
}

type ActivityRow = LeadActivity & {
  profiles: { full_name: string | null } | null
}

interface LeadActivityLogProps {
  leadId: string
  /** Current lead status — used to derive the next status when logging. */
  leadStatus: WebsiteLeadStatus
  /** Called when logging an activity moved the lead to a new status. */
  onStatusChange?: (status: WebsiteLeadStatus) => void
  /** Bump to force a refetch. */
  refreshToken?: number
}

function formatDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "–"
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function LeadActivityLog({
  leadId,
  leadStatus,
  onStatusChange,
  refreshToken = 0,
}: LeadActivityLogProps) {
  const { t } = useTranslation()
  const { user } = useUser()
  const [activities, setActivities] = React.useState<ActivityRow[]>([])
  const [loading, setLoading] = React.useState(true)
  const [formOpen, setFormOpen] = React.useState(false)
  const [actionType, setActionType] = React.useState<LeadActivityType>("called")
  const [note, setNote] = React.useState("")
  const [saving, setSaving] = React.useState(false)
  // Inline editing of one entry at a time (own entries only — RLS enforces).
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [editType, setEditType] = React.useState<LeadActivityType>("called")
  const [editNote, setEditNote] = React.useState("")
  const [deleteTarget, setDeleteTarget] = React.useState<ActivityRow | null>(
    null,
  )
  const [deleting, setDeleting] = React.useState(false)

  const fetchActivities = React.useCallback(async () => {
    const supabase = createClient()
    const { data, error } = await supabase
      .from("lead_activities")
      .select("*, profiles:created_by(full_name)")
      .eq("lead_id", leadId)
      .order("created_at", { ascending: false })

    if (error) {
      toast.error(
        t("leads.activity.loadFailed", "Failed to load activity history"),
      )
      setLoading(false)
      return
    }
    setActivities((data ?? []) as unknown as ActivityRow[])
    setLoading(false)
  }, [leadId, t])

  React.useEffect(() => {
    void fetchActivities()
  }, [fetchActivities, refreshToken])

  async function handleLog() {
    setSaving(true)
    const supabase = createClient()
    const { error } = await supabase.from("lead_activities").insert({
      lead_id: leadId,
      activity_type: actionType,
      note: note.trim() || null,
      created_by: user.id,
    } as never)
    if (error) {
      setSaving(false)
      toast.error(t("leads.activity.logFailed", "Failed to log activity"))
      return
    }

    // The activity log drives the pipeline: move the lead status if this
    // action implies a new one.
    const nextStatus = deriveStatus(actionType, leadStatus)
    let statusMessage: string | null = null
    if (nextStatus && nextStatus !== leadStatus) {
      const { data: updated, error: statusError } = await supabase
        .from("website_leads")
        .update({ status: nextStatus } as never)
        .eq("id", leadId)
        .select("id")
      if (statusError || !updated?.length) {
        // Surface the failure loudly — a silently stuck status is confusing.
        toast.error(
          `${t("leads.activity.statusUpdateFailed", "Failed to update lead status")}${statusError ? `: ${statusError.message}` : ""}`,
        )
      } else {
        onStatusChange?.(nextStatus)
        statusMessage = `${t("leads.activity.statusUpdated", "Status updated to")} ${t(`leads.status.${nextStatus}`, STATUS_TOAST_LABEL[nextStatus])}`
      }
    }

    setSaving(false)
    setNote("")
    setFormOpen(false)
    toast.success(
      statusMessage
        ? `${t("leads.activity.logged", "Activity logged")} · ${statusMessage}`
        : t("leads.activity.logged", "Activity logged"),
    )
    void fetchActivities()
  }

  function startEdit(activity: ActivityRow) {
    setEditingId(activity.id)
    setEditType(activity.activity_type)
    setEditNote(activity.note ?? "")
  }

  async function handleEditSave() {
    if (!editingId) return
    setSaving(true)
    const supabase = createClient()
    // .select() returns the affected rows; RLS-blocked updates come back as
    // an empty array with no error, so check for that instead of trusting
    // the absence of an error.
    const { data, error } = await supabase
      .from("lead_activities")
      .update({
        activity_type: editType,
        note: editNote.trim() || null,
      } as never)
      .eq("id", editingId)
      .select("id")
    setSaving(false)
    if (error || !data?.length) {
      toast.error(
        t("leads.activity.updateFailed", "Failed to update activity"),
      )
      return
    }
    setEditingId(null)
    toast.success(t("leads.activity.updated", "Activity updated"))
    void fetchActivities()
  }

  async function handleDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    const supabase = createClient()
    // Empty result + no error = RLS blocked the delete (e.g. not the author).
    const { data, error } = await supabase
      .from("lead_activities")
      .delete()
      .eq("id", deleteTarget.id)
      .select("id")
    setDeleting(false)
    if (error || !data?.length) {
      toast.error(
        t("leads.activity.deleteFailed", "Failed to delete activity"),
      )
      return
    }
    setDeleteTarget(null)
    toast.success(t("leads.activity.deleted", "Activity deleted"))
    void fetchActivities()
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">
            {t("leads.activity.title", "Activity")}
          </CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setFormOpen((open) => !open)}
          >
            <Plus className="size-4" />
            {t("leads.activity.log", "Log activity")}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {formOpen ? (
          <div className="space-y-3 rounded-lg border p-3">
            <Select
              value={actionType}
              onValueChange={(value) =>
                setActionType(value as LeadActivityType)
              }
            >
              <SelectTrigger className="h-9 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LOGGABLE_ACTIONS.map((action) => {
                  const Icon = ACTION_ICON[action]
                  return (
                    <SelectItem key={action} value={action}>
                      <span className="flex items-center gap-2">
                        <Icon className="size-4" />
                        {t(
                          `leads.activity.type.${action}`,
                          ACTION_LABEL[action],
                        )}
                      </span>
                    </SelectItem>
                  )
                })}
              </SelectContent>
            </Select>
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder={t(
                "leads.activity.notePlaceholder",
                "Optional note — what was said, next step...",
              )}
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setFormOpen(false)}
                disabled={saving}
              >
                {t("common.cancel", "Cancel")}
              </Button>
              <Button size="sm" onClick={handleLog} disabled={saving}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                {t("leads.activity.save", "Save")}
              </Button>
            </div>
          </div>
        ) : null}

        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, index) => (
              <div
                key={index}
                className="h-12 animate-pulse rounded-md bg-muted"
              />
            ))}
          </div>
        ) : activities.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t(
              "leads.activity.empty",
              "No activity yet. Log your first outreach so colleagues can see it.",
            )}
          </p>
        ) : (
          <ol className="space-y-0">
            {activities.map((activity, index) => {
              const Icon = ACTION_ICON[activity.activity_type] ?? StickyNote
              const isLast = index === activities.length - 1
              const isOwn = activity.created_by === user.id
              const isEditing = editingId === activity.id
              return (
                <li key={activity.id} className="group relative flex gap-3 pb-4">
                  {!isLast ? (
                    <span
                      aria-hidden
                      className="absolute left-[15px] top-8 h-[calc(100%-2rem)] w-px bg-border"
                    />
                  ) : null}
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-full border bg-muted">
                    <Icon className="size-4 text-muted-foreground" />
                  </span>
                  {isEditing ? (
                    <div className="min-w-0 flex-1 space-y-2 pt-1">
                      <Select
                        value={editType}
                        onValueChange={(value) =>
                          setEditType(value as LeadActivityType)
                        }
                      >
                        <SelectTrigger className="h-9 w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {LOGGABLE_ACTIONS.map((action) => {
                            const ActionIcon = ACTION_ICON[action]
                            return (
                              <SelectItem key={action} value={action}>
                                <span className="flex items-center gap-2">
                                  <ActionIcon className="size-4" />
                                  {t(
                                    `leads.activity.type.${action}`,
                                    ACTION_LABEL[action],
                                  )}
                                </span>
                              </SelectItem>
                            )
                          })}
                        </SelectContent>
                      </Select>
                      <Textarea
                        value={editNote}
                        onChange={(e) => setEditNote(e.target.value)}
                        rows={2}
                      />
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setEditingId(null)}
                          disabled={saving}
                        >
                          {t("common.cancel", "Cancel")}
                        </Button>
                        <Button
                          size="sm"
                          onClick={handleEditSave}
                          disabled={saving}
                        >
                          {saving ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : null}
                          {t("leads.activity.save", "Save")}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="min-w-0 flex-1 pt-1">
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm">
                          <span className="font-medium">
                            {t(
                              `leads.activity.type.${activity.activity_type}`,
                              ACTION_LABEL[activity.activity_type] ??
                                activity.activity_type,
                            )}
                          </span>
                          <span className="text-muted-foreground">
                            {" · "}
                            {activity.profiles?.full_name ??
                              t("leads.activity.unknown", "Unknown")}
                          </span>
                        </p>
                        {isOwn ? (
                          <span className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                            {activity.activity_type !== "status_change" ? (
                              <Button
                                variant="ghost"
                                size="icon-xs"
                                aria-label={t("leads.activity.edit", "Edit")}
                                onClick={() => startEdit(activity)}
                              >
                                <Pencil className="size-3.5" />
                              </Button>
                            ) : null}
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              aria-label={t("leads.activity.delete", "Delete")}
                              onClick={() => setDeleteTarget(activity)}
                            >
                              <Trash2 className="size-3.5" />
                            </Button>
                          </span>
                        ) : null}
                      </div>
                      {activity.note ? (
                        <p className="mt-0.5 whitespace-pre-wrap text-sm text-muted-foreground">
                          {activity.note}
                        </p>
                      ) : null}
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {formatDateTime(activity.created_at)}
                      </p>
                    </div>
                  )}
                </li>
              )
            })}
          </ol>
        )}
      </CardContent>

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
        title={t("leads.activity.deleteTitle", "Delete activity?")}
        description={t(
          "leads.activity.deleteDescription",
          "This removes the entry from the history for everyone.",
        )}
        confirmLabel={t("leads.activity.delete", "Delete")}
        cancelLabel={t("common.cancel", "Cancel")}
        variant="destructive"
        onConfirm={handleDelete}
        loading={deleting}
      />
    </Card>
  )
}

export { LeadActivityLog }
