"use client"

import * as React from "react"
import { Check, CornerDownLeft, Lock, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { createClient } from "@/lib/supabase/client"
import { cn } from "@/lib/utils"
import { useTranslation } from "@/hooks/use-translation"
import { useUser } from "@/hooks/use-user"
import type { CustomerRecurringWork, ResourceCadence } from "@/types/resource"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"

const CADENCE_ORDER: ResourceCadence[] = ["manad", "kvartal", "ar", "vid_behov"]

export type ConfirmQueueItem = { customer_id: string; customer_name: string }

/**
 * The capture step — and the one gate every later improvement sits behind.
 *
 * The structural drivers of löpande work were not stored anywhere, which is why
 * estimating from history alone tops out at ±38% per customer. Rather than
 * backfill them as a project, this sheet proposes what the customer's own time
 * entries say recurs — label, typisk tid per månad, and how many of the last 12
 * months it appeared in — and asks a human to say yes.
 *
 * It runs as a queue, not as a dialog you open twenty times: Enter confirms and
 * moves to the next customer, so a twenty-customer portfolio is a few minutes
 * rather than an afternoon. The evidence is on the row precisely so nobody has
 * to go and look it up in Fortnox to answer.
 *
 * `Löner enligt uppdragsbrev` — one of the most-logged activities in the firm —
 * says outright that the uppdragsavtal is the ground truth for scope. The
 * proposal is a starting point for that conversation, not a substitute.
 */
export function RecurringWorkSheet({
  queue,
  startIndex = 0,
  open,
  onOpenChange,
  onConfirmed,
}: {
  queue: ConfirmQueueItem[]
  startIndex?: number
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirmed: (customerId: string, confirmedCount: number) => void
}) {
  const { t } = useTranslation()
  const { user } = useUser()
  const supabase = React.useMemo(() => createClient(), [])

  const [index, setIndex] = React.useState(startIndex)
  const [done, setDone] = React.useState(0)
  const [loading, setLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [items, setItems] = React.useState<CustomerRecurringWork[]>([])

  const current = queue[index] ?? null

  React.useEffect(() => {
    if (open) {
      setIndex(startIndex)
      setDone(0)
    }
  }, [open, startIndex])

  const cadenceLabels: Record<ResourceCadence, string> = React.useMemo(
    () => ({
      manad: t("belaggning.cadence.manad", "Monthly"),
      kvartal: t("belaggning.cadence.kvartal", "Quarterly"),
      ar: t("belaggning.cadence.ar", "Yearly"),
      vid_behov: t("belaggning.cadence.vid_behov", "As needed"),
    }),
    [t],
  )

  React.useEffect(() => {
    if (!open || !current) return
    let cancelled = false

    const id = current.customer_id

    async function load() {
      setLoading(true)

      // Propose first, then read: propose_recurring_work is ON CONFLICT DO
      // NOTHING, so re-opening the sheet never disturbs a confirmed row.
      const { error: proposeError } = await supabase.rpc(
        "propose_recurring_work" as never,
        { p_customer_id: id } as never,
      )

      if (proposeError) {
        // A failed proposal is not fatal — whatever was captured before still
        // renders, and the manager can add rows by hand.
        console.warn("propose_recurring_work failed", proposeError.message)
      }

      const { data, error } = await supabase
        .from("customer_recurring_work")
        .select("*")
        .eq("customer_id", id)
        .eq("is_active", true)
        .order("cadence")
        .order("label")

      if (cancelled) return

      if (error) {
        toast.error(t("belaggning.recurring.loadFailed", "Could not load recurring work"))
        setItems([])
      } else {
        setItems((data ?? []) as CustomerRecurringWork[])
      }
      setLoading(false)
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [open, current, supabase, t])

  function patch(id: string, changes: Partial<CustomerRecurringWork>) {
    setItems((list) =>
      list.map((item) => (item.id === id ? { ...item, ...changes } : item)),
    )
  }

  async function remove(id: string) {
    const previous = items
    setItems((list) => list.filter((item) => item.id !== id))

    const { error } = await supabase
      .from("customer_recurring_work")
      .update({ is_active: false } as never)
      .eq("id", id)

    if (error) {
      setItems(previous)
      toast.error(t("belaggning.recurring.removeFailed", "Could not remove"))
    }
  }

  function advance() {
    if (index + 1 < queue.length) {
      setIndex(index + 1)
    } else {
      onOpenChange(false)
    }
  }

  async function confirmCurrent() {
    if (!current || saving) return

    // Confirming an empty list is a real answer — "this customer needs nothing
    // recurring" — but there is no row to stamp, so it just moves on.
    if (items.length === 0) {
      setDone((count) => count + 1)
      advance()
      return
    }

    setSaving(true)

    const stamp = new Date().toISOString()
    const payload = items.map((item) => ({
      id: item.id,
      customer_id: item.customer_id,
      label: item.label,
      source_activity: item.source_activity,
      cadence: item.cadence,
      typical_hours: item.typical_hours,
      hardness: item.hardness,
      source: item.source,
      is_active: true,
      months_seen: item.months_seen,
      months_total: item.months_total,
      confirmed_at: stamp,
      confirmed_by: user.id,
    }))

    const { error } = await supabase
      .from("customer_recurring_work")
      .upsert(payload as never, { onConflict: "id" })

    setSaving(false)

    if (error) {
      toast.error(t("belaggning.recurring.saveFailed", "Could not save"))
      return
    }

    onConfirmed(current.customer_id, items.length)
    setDone((count) => count + 1)
    advance()
  }

  async function addBlank() {
    if (!current) return

    const { data, error } = await supabase
      .from("customer_recurring_work")
      .insert({
        customer_id: current.customer_id,
        label: t("belaggning.recurring.newLabel", "New task"),
        cadence: "manad",
        hardness: "intern",
        source: "manual",
      } as never)
      .select("*")
      .single()

    if (error || !data) {
      toast.error(t("belaggning.recurring.addFailed", "Could not add"))
      return
    }

    setItems((list) => [...list, data as CustomerRecurringWork])
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="flex w-full flex-col gap-0 sm:max-w-lg"
        onKeyDown={(event) => {
          // Enter anywhere in the sheet confirms and moves on — the whole point
          // is that a customer takes seconds, not a round trip to the mouse.
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault()
            void confirmCurrent()
          }
        }}
      >
        <SheetHeader>
          <SheetTitle>{current?.customer_name ?? ""}</SheetTitle>
          <SheetDescription>
            {t(
              "belaggning.recurring.description",
              "Derived from the last 12 months of reported time. Adjust and confirm — this is what the plan will be built from.",
            )}
          </SheetDescription>
        </SheetHeader>

        {queue.length > 1 ? (
          <div className="space-y-1 px-4 pb-3">
            <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-brand-primary transition-all"
                style={{ width: `${(done / queue.length) * 100}%` }}
              />
            </div>
            <p className="text-xs text-muted-foreground tabular-nums">
              {t("belaggning.recurring.progress", "{done} of {total} confirmed")
                .replace("{done}", String(done))
                .replace("{total}", String(queue.length))}
            </p>
          </div>
        ) : null}

        <div className="flex-1 space-y-2 overflow-y-auto px-4">
          {loading ? (
            Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))
          ) : items.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {t(
                "belaggning.recurring.empty",
                "Nothing recurred often enough to propose. Add what this customer needs.",
              )}
            </p>
          ) : (
            items.map((item) => (
              <div
                key={item.id}
                className={cn(
                  "rounded-md border p-3",
                  item.confirmed_at ? "border-border" : "border-dashed border-border",
                )}
              >
                <div className="flex items-start gap-2">
                  <Input
                    value={item.label}
                    onChange={(event) => patch(item.id, { label: event.target.value })}
                    className="h-8 flex-1"
                  />
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => void remove(item.id)}
                    aria-label={t("belaggning.recurring.remove", "Remove")}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <div className="flex gap-1">
                    {CADENCE_ORDER.map((cadence) => (
                      <Button
                        key={cadence}
                        variant={item.cadence === cadence ? "secondary" : "ghost"}
                        size="xs"
                        className="h-6 px-2 text-xs"
                        onClick={() => patch(item.id, { cadence })}
                      >
                        {cadenceLabels[cadence]}
                      </Button>
                    ))}
                  </div>

                  <div className="ml-auto flex items-center gap-1">
                    <Input
                      type="number"
                      step="0.5"
                      min="0"
                      value={item.typical_hours ?? ""}
                      onChange={(event) =>
                        patch(item.id, {
                          typical_hours:
                            event.target.value === "" ? null : Number(event.target.value),
                        })
                      }
                      className="h-6 w-16 text-xs"
                      aria-label={t("belaggning.recurring.hours", "Hours")}
                    />
                    <span className="text-xs text-muted-foreground">h</span>
                  </div>
                </div>

                <div className="mt-2 flex items-center gap-2">
                  <Button
                    variant={item.hardness === "lagstadgad" ? "secondary" : "ghost"}
                    size="xs"
                    className="h-6 gap-1 px-2 text-xs"
                    onClick={() =>
                      patch(item.id, {
                        hardness: item.hardness === "lagstadgad" ? "intern" : "lagstadgad",
                      })
                    }
                    title={t(
                      "belaggning.recurring.hardnessHint",
                      "Statutory work cannot be moved when a month is overloaded — internal work can.",
                    )}
                  >
                    <Lock className="size-3" />
                    {item.hardness === "lagstadgad"
                      ? t("belaggning.hardness.lagstadgad", "Statutory")
                      : t("belaggning.hardness.intern", "Internal")}
                  </Button>

                  {/* The evidence for the proposal, so the answer is one look
                      rather than a trip to Fortnox. */}
                  {item.months_seen && item.months_total ? (
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {t("belaggning.recurring.frequency", "{seen} of {total} months")
                        .replace("{seen}", String(item.months_seen))
                        .replace("{total}", String(item.months_total))}
                    </span>
                  ) : null}

                  {item.source === "derived" && !item.confirmed_at ? (
                    <Badge variant="outline" className="text-xs font-normal">
                      {t("belaggning.recurring.proposed", "Proposed")}
                    </Badge>
                  ) : null}
                  {item.confirmed_at ? (
                    <Badge variant="outline" className="gap-1 text-xs font-normal">
                      <Check className="size-3 text-semantic-success" />
                      {t("belaggning.recurring.confirmed", "Confirmed")}
                    </Badge>
                  ) : null}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t p-4">
          <Button variant="outline" size="sm" onClick={() => void addBlank()}>
            <Plus className="size-4" />
            {t("belaggning.recurring.add", "Add task")}
          </Button>
          <Button
            size="sm"
            className="gap-2"
            onClick={() => void confirmCurrent()}
            disabled={saving || loading}
          >
            {index + 1 < queue.length
              ? t("belaggning.recurring.confirmNext", "Confirm and next")
              : t("belaggning.recurring.confirmAll", "Confirm")}
            <CornerDownLeft className="size-3.5 opacity-70" />
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}
