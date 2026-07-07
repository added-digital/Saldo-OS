"use client"

import * as React from "react"
import { usePathname } from "next/navigation"
import { ImagePlus, Loader2, MessageCircle, Send, X } from "lucide-react"
import { toast } from "sonner"

import { createClient } from "@/lib/supabase/client"
import { useUser } from "@/hooks/use-user"
import { useTranslation } from "@/hooks/use-translation"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import type { FeedbackCategory } from "@/types/database"

const STORAGE_BUCKET =
  process.env.NEXT_PUBLIC_SUPABASE_FILES_BUCKET ?? "crm-files"

// Screenshot constraints. Kept small and image-only — this is for screen clips,
// not document uploads.
const MAX_SHOT_BYTES = 10 * 1024 * 1024 // 10 MB
const MAX_SHOTS = 4
const ALLOWED_SHOT_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"]

type PendingShot = {
  id: string
  file: File
  url: string
}

/**
 * Floating "Feedback" button anchored to the bottom-right of every dashboard
 * page. Click opens a small dialog that submits one row to the
 * `feedback_submissions` table. The current page URL and the browser's user
 * agent are captured automatically so triage has the context — the user
 * doesn't have to think about where they were when they hit a problem.
 *
 * Users can attach screenshots (screen clips): pick them with the button or
 * paste directly into the dialog. Files upload to the crm-files bucket and
 * their storage paths are saved on the feedback row.
 *
 * Available to every authenticated role (user / team_lead / admin); RLS on
 * the insert policy enforces user_id = auth.uid().
 */
function FeedbackWidget() {
  const { user } = useUser()
  const { t } = useTranslation()
  const pathname = usePathname()
  const [open, setOpen] = React.useState(false)
  const [category, setCategory] = React.useState<FeedbackCategory>("bug")
  const [message, setMessage] = React.useState("")
  const [submitting, setSubmitting] = React.useState(false)
  const [shots, setShots] = React.useState<PendingShot[]>([])
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  const clearShots = React.useCallback((list: PendingShot[]) => {
    for (const shot of list) URL.revokeObjectURL(shot.url)
  }, [])

  function resetForm() {
    setCategory("bug")
    setMessage("")
    setShots((prev) => {
      clearShots(prev)
      return []
    })
  }

  // Revoke any outstanding object URLs when the widget unmounts.
  React.useEffect(() => {
    return () => {
      setShots((prev) => {
        clearShots(prev)
        return prev
      })
    }
  }, [clearShots])

  function addFiles(files: FileList | File[]) {
    const incoming = Array.from(files)
    if (incoming.length === 0) return

    setShots((prev) => {
      const next = [...prev]
      for (const file of incoming) {
        if (!ALLOWED_SHOT_TYPES.includes(file.type)) {
          toast.error(
            t("feedback.shots.badType", "Only image files can be attached"),
          )
          continue
        }
        if (file.size > MAX_SHOT_BYTES) {
          toast.error(
            t("feedback.shots.tooBig", "Screenshots must be under 10 MB"),
          )
          continue
        }
        if (next.length >= MAX_SHOTS) {
          toast.error(
            t("feedback.shots.tooMany", "You can attach up to 4 screenshots"),
          )
          break
        }
        next.push({
          id: crypto.randomUUID(),
          file,
          url: URL.createObjectURL(file),
        })
      }
      return next
    })
  }

  function removeShot(id: string) {
    setShots((prev) => {
      const target = prev.find((s) => s.id === id)
      if (target) URL.revokeObjectURL(target.url)
      return prev.filter((s) => s.id !== id)
    })
  }

  function handlePaste(e: React.ClipboardEvent) {
    const images = Array.from(e.clipboardData.files).filter((f) =>
      f.type.startsWith("image/"),
    )
    if (images.length > 0) {
      e.preventDefault()
      addFiles(images)
    }
  }

  async function handleSubmit() {
    const trimmed = message.trim()
    if (!trimmed) {
      toast.error(
        t("feedback.toast.empty", "Please add a short description first"),
      )
      return
    }

    setSubmitting(true)
    try {
      const supabase = createClient()

      // Upload screenshots first so we can store their paths on the row. If any
      // upload fails we roll back the ones that already landed.
      const uploadedPaths: string[] = []
      for (const shot of shots) {
        const ext = shot.file.name.split(".").pop()?.toLowerCase() || "png"
        const path = `feedback/${user.id}/${crypto.randomUUID()}.${ext}`
        const { error: uploadError } = await supabase.storage
          .from(STORAGE_BUCKET)
          .upload(path, shot.file, {
            contentType: shot.file.type || undefined,
            upsert: false,
          })
        if (uploadError) {
          if (uploadedPaths.length > 0) {
            await supabase.storage.from(STORAGE_BUCKET).remove(uploadedPaths)
          }
          toast.error(
            `${t("feedback.shots.uploadFailed", "Couldn't upload screenshot")}: ${uploadError.message}`,
          )
          return
        }
        uploadedPaths.push(path)
      }

      // Capture the full URL including search params — query strings often
      // carry the filter state that reproduces the bug.
      const pageUrl =
        typeof window !== "undefined"
          ? window.location.pathname + window.location.search
          : (pathname ?? null)
      const userAgent =
        typeof navigator !== "undefined" ? navigator.userAgent : null

      const { error } = await supabase.from("feedback_submissions").insert({
        user_id: user.id,
        category,
        message: trimmed,
        page_url: pageUrl,
        user_agent: userAgent,
        attachment_paths: uploadedPaths,
      } as never)

      if (error) {
        // Don't leave orphaned objects behind if the row insert failed.
        if (uploadedPaths.length > 0) {
          await supabase.storage.from(STORAGE_BUCKET).remove(uploadedPaths)
        }
        toast.error(
          `${t("feedback.toast.failed", "Couldn't send feedback")}: ${error.message}`,
        )
        return
      }

      toast.success(t("feedback.toast.sent", "Thanks — feedback sent."))
      setOpen(false)
      resetForm()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        onClick={() => setOpen(true)}
        className={cn(
          "fixed bottom-4 right-4 z-40 gap-1.5 shadow-md",
          // Subtle hover lift so it feels affordant without dominating.
          "transition-transform hover:-translate-y-0.5",
        )}
      >
        <MessageCircle className="size-4" />
        {t("feedback.button", "Feedback")}
      </Button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!submitting) setOpen(next)
          if (!next) resetForm()
        }}
      >
        <DialogContent className="max-w-md" onPaste={handlePaste}>
          <DialogHeader>
            <DialogTitle>
              {t("feedback.dialog.title", "Send feedback")}
            </DialogTitle>
            <DialogDescription>
              {t(
                "feedback.dialog.description",
                "Spot a bug or have a suggestion? Tell us what you saw and where. We capture the current page automatically.",
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="feedback-category">
                {t("feedback.fields.category", "Category")}
              </Label>
              <Select
                value={category}
                onValueChange={(value) =>
                  setCategory(value as FeedbackCategory)
                }
              >
                <SelectTrigger id="feedback-category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="bug">
                    {t("feedback.categories.bug", "Bug")}
                  </SelectItem>
                  <SelectItem value="feature">
                    {t("feedback.categories.feature", "Feature request")}
                  </SelectItem>
                  <SelectItem value="question">
                    {t("feedback.categories.question", "Question")}
                  </SelectItem>
                  <SelectItem value="other">
                    {t("feedback.categories.other", "Other")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label htmlFor="feedback-message">
                {t("feedback.fields.message", "Message")}
              </Label>
              <Textarea
                id="feedback-message"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder={t(
                  "feedback.fields.placeholder",
                  "Describe what you saw or what you'd like to see…",
                )}
                rows={5}
              />
            </div>

            {/* Screenshots */}
            <div className="space-y-1.5">
              <Label>{t("feedback.shots.label", "Screenshots")}</Label>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) addFiles(e.target.files)
                  e.target.value = ""
                }}
              />
              {shots.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {shots.map((shot) => (
                    <div
                      key={shot.id}
                      className="group relative size-16 overflow-hidden rounded-md border"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={shot.url}
                        alt={shot.file.name}
                        className="size-full object-cover"
                      />
                      <button
                        type="button"
                        onClick={() => removeShot(shot.id)}
                        disabled={submitting}
                        className="absolute right-0.5 top-0.5 rounded-full bg-background/80 p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                        aria-label={t("feedback.shots.remove", "Remove")}
                      >
                        <X className="size-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5"
                disabled={submitting || shots.length >= MAX_SHOTS}
                onClick={() => fileInputRef.current?.click()}
              >
                <ImagePlus className="size-4" />
                {t("feedback.shots.add", "Attach screenshot")}
              </Button>
              <p className="text-xs text-muted-foreground">
                {t(
                  "feedback.shots.hint",
                  "Or paste a screen clip directly here (Cmd/Ctrl+V).",
                )}
              </p>
            </div>

            <p className="text-xs text-muted-foreground">
              {t(
                "feedback.dialog.captureNotice",
                "We also send your current page URL and browser info to help reproduce issues.",
              )}
            </p>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={submitting}
            >
              {t("feedback.cancel", "Cancel")}
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={submitting || message.trim().length === 0}
              className="gap-1.5"
            >
              {submitting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Send className="size-4" />
              )}
              {submitting
                ? t("feedback.submitting", "Sending…")
                : t("feedback.submit", "Send")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

export { FeedbackWidget }
