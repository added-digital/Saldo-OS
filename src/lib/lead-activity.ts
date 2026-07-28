import {
  Archive,
  ArrowRightLeft,
  Bell,
  CalendarClock,
  FileText,
  Mail,
  Phone,
  ShieldAlert,
  StickyNote,
  Trophy,
  XCircle,
  type LucideIcon,
} from "lucide-react"

import type { LeadActivityType, WebsiteLeadStatus } from "@/types/database"

// Preset actions a consultant can log. The activity log is the single source
// of truth for lead status — logging an action moves the pipeline (see
// deriveStatus below). 'status_change' is legacy (from the removed status
// dropdown) and only kept so old rows still render.
// Shared by the lead detail activity log and the quick-log menu on the board
// cards, so both offer exactly the same actions.
export const LOGGABLE_ACTIONS: LeadActivityType[] = [
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

/** English fallbacks — the sv/en strings live under `leads.activity.type.*`. */
export const ACTION_LABEL: Record<LeadActivityType, string> = {
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

export const ACTION_ICON: Record<LeadActivityType, LucideIcon> = {
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
export const STATUS_TOAST_LABEL: Record<WebsiteLeadStatus, string> = {
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
export function deriveStatus(
  action: LeadActivityType,
  current: WebsiteLeadStatus,
): WebsiteLeadStatus | null {
  switch (action) {
    case "called":
    case "emailed":
    case "meeting_booked":
      return current === "new" ? "contacted" : null
    case "offer_sent":
      return current === "new" || current === "contacted" ? "offer_sent" : null
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
