"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Bell } from "lucide-react"

import { createClient } from "@/lib/supabase/client"
import { cn, formatDateTime } from "@/lib/utils"
import { useUser } from "@/hooks/use-user"
import { useTranslation } from "@/hooks/use-translation"
import type { AppNotification } from "@/types/notification"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

const POLL_INTERVAL_MS = 60_000

export function NotificationBell() {
  const { user } = useUser()
  const { t } = useTranslation()
  const router = useRouter()

  const [items, setItems] = React.useState<AppNotification[]>([])
  const [open, setOpen] = React.useState(false)

  const unread = React.useMemo(
    () => items.filter((n) => !n.read_at).length,
    [items],
  )

  const fetchItems = React.useCallback(async () => {
    const supabase = createClient()
    const { data } = await supabase
      .from("notifications")
      .select("*")
      .eq("recipient_id", user.id)
      .order("created_at", { ascending: false })
      .limit(20)
    setItems((data ?? []) as AppNotification[])
  }, [user.id])

  // Initial load + light polling so the badge stays fresh.
  React.useEffect(() => {
    void fetchItems()
    const interval = window.setInterval(() => void fetchItems(), POLL_INTERVAL_MS)
    return () => window.clearInterval(interval)
  }, [fetchItems])

  React.useEffect(() => {
    if (open) void fetchItems()
  }, [open, fetchItems])

  async function markAllRead() {
    if (unread === 0) return
    const now = new Date().toISOString()
    setItems((cur) => cur.map((n) => (n.read_at ? n : { ...n, read_at: now })))
    const supabase = createClient()
    await supabase
      .from("notifications")
      .update({ read_at: now } as never)
      .eq("recipient_id", user.id)
      .is("read_at", null)
  }

  async function handleClick(n: AppNotification) {
    setOpen(false)
    if (!n.read_at) {
      const now = new Date().toISOString()
      setItems((cur) => cur.map((x) => (x.id === n.id ? { ...x, read_at: now } : x)))
      const supabase = createClient()
      await supabase
        .from("notifications")
        .update({ read_at: now } as never)
        .eq("id", n.id)
    }
    if (n.type === "lead_assignment" && n.lead_id) {
      router.push(`/leads/${n.lead_id}`)
    } else if (n.engagement_id) {
      router.push(`/bokslut?engagement=${n.engagement_id}`)
    }
  }

  const messageFor = React.useCallback(
    (n: AppNotification) =>
      n.type === "lead_assignment"
        ? t("notifications.assignedLead", "assigned a lead to you")
        : t("notifications.mentionedYou", "mentioned you in a comment"),
    [t],
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={t("notifications.open", "Notifications")}
        >
          <Bell className="size-5" />
          {unread > 0 ? (
            <span className="absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-semantic-error px-1 text-[10px] font-semibold leading-4 text-white">
              {unread > 9 ? "9+" : unread}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
          <p className="text-sm font-medium">
            {t("notifications.title", "Notifications")}
            {unread > 0 ? (
              <span className="ml-1 text-xs text-muted-foreground">
                · {unread} {t("notifications.unreadCount", "unread")}
              </span>
            ) : null}
          </p>
          {unread > 0 ? (
            <Button variant="ghost" size="xs" onClick={markAllRead}>
              {t("notifications.markAllRead", "Mark all as read")}
            </Button>
          ) : null}
        </div>

        {items.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm text-muted-foreground">
            {t("notifications.empty", "You're all caught up.")}
          </p>
        ) : (
          <ul className="max-h-96 overflow-auto py-1">
            {items.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => handleClick(n)}
                  className={cn(
                    "flex w-full gap-2 px-3 py-2 text-left transition-colors hover:bg-accent",
                    !n.read_at && "bg-accent/40",
                  )}
                >
                  <span
                    className={cn(
                      "mt-1.5 size-2 shrink-0 rounded-full",
                      n.read_at ? "bg-transparent" : "bg-semantic-error",
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm">
                      <span className="font-medium">{n.actor_name ?? "—"}</span>{" "}
                      {messageFor(n)}
                    </span>
                    {n.customer_name ? (
                      <span className="block truncate text-xs text-muted-foreground">
                        {n.customer_name}
                      </span>
                    ) : null}
                    <span className="block text-xs text-muted-foreground">
                      {formatDateTime(n.created_at)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  )
}
