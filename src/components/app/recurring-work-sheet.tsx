"use client"

import * as React from "react"
import { Check, Lock, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { createClient } from "@/lib/supabase/client"
import { cn } from "@/lib/utils"
import { useTranslation } from "@/hooks/use-translation"
import { useUser } from "@/hooks/use-user"
import type {
  CustomerRecurringWork,
  ResourceCadence,
} from "@/types/resource"
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

/**
 * The capture step.
 *
 * The structural drivers of löpande work — momsperiod, antal anställda,
 * bokföringsfrekvens — are not stored anywhere, which is why estimating from
 * history alone tops out at ±38% per customer. Rather than backfill them as a
 * project, this sheet proposes what the customer's own time entries say they
 * recur on and asks a human to confirm it. The first month of using the board
 * is the data collection.
 *
 * `Löner enligt uppdragsbrev` — one of the most-logged activities in the firm —
 * says outright that the uppdragsavtal is the ground truth for scope. The
 * proposal is a starting point for that conversation, not a substitute.
 */
export function RecurringWorkSheet({
  customerId,
  customerName,
  open,
  onOpenChange,
  onConfirmed,
}: {
  customerId: string | null
  customerName: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirmed: (confirmedCount: number) => void
}) {
  const { t } = useTranslation()
  const { user } = useUser()
  const supabase = React.useMemo(() => createClient(), [])

  const [loading, setLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [items, setItems] = React.useState<CustomerRecurringWork[]>([])

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
    if (!open || !customerId) return
    let cancelled = false

    const id = customerId

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
  }, [open, customerId, supabase, t])

  function patch(id: string, changes: Partial<CustomerRecurringWork>) {
    setItems((current) =>
      current.map((item) => (item.id === id ? { ...item, ...changes } : item)),
    )
  }

  async function remove(id: string) {
    const previous = items
    setItems((current) => current.filter((item) => item.id !== id))

    const { error } = await supabase
      .from("customer_recurring_work")
      .update({ is_active: false } as never)
      .eq("id", id)

    if (error) {
      setItems(previous)
      toast.error(t("belaggning.recurring.removeFailed", "Could not remove"))
    }
  }

  async function confirmAll() {
    if (!customerId || items.length === 0) return
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
      confirmed_at: stamp,
      confirmed_by: user?.id ?? null,
    }))

    const { error } = await supabase
      .from("customer_recurring_work")
      .upsert(payload as never, { onConflict: "id" })

    setSaving(false)

    if (error) {
      toast.error(t("belaggning.recurring.saveFailed", "Could not save"))
      return
    }

    setItems((current) =>
      current.map((item) => ({ ...item, confirmed_at: stamp })),
    )
    onConfirmed(items.length)
    toast.success(t("belaggning.recurring.saved", "Recurring work confirmed"))
    onOpenChange(false)
  }

  async function addBlank() {
    if (!customerId) return

    const { data, error } = await supabase
      .from("customer_recurring_work")
      .insert({
        customer_id: customerId,
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

    setItems((current) => [...current, data as CustomerRecurringWork])
  }

  const unconfirmed = items.filter((item) => item.confirmed_at === null).length

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{customerName}</SheetTitle>
          <SheetDescription>
            {t(
              "belaggning.recurring.description",
              "Derived from the last 12 months of reported time. Adjust and confirm — this is what the plan will be built from.",
            )}
          </SheetDescription>
        </SheetHeader>

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
            {t("belaggning.recurring.add", "Add")}
          </Button>
          <Button size="sm" onClick={() => void confirmAll()} disabled={saving || loading}>
            {unconfirmed > 0
              ? t("belaggning.recurring.confirmAll", "Confirm all")
              : t("belaggning.recurring.save", "Save")}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}
