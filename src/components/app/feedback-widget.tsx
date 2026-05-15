"use client"

import * as React from "react"
import { usePathname } from "next/navigation"
import { Loader2, MessageCircle, Send } from "lucide-react"
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

/**
 * Floating "Feedback" button anchored to the bottom-right of every dashboard
 * page. Click opens a small dialog that submits one row to the
 * `feedback_submissions` table. The current page URL and the browser's user
 * agent are captured automatically so triage has the context — the user
 * doesn't have to think about where they were when they hit a problem.
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

  function resetForm() {
    setCategory("bug")
    setMessage("")
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
      } as never)

      if (error) {
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
        <DialogContent className="max-w-md">
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
