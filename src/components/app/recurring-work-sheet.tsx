"use client"

import * as React from "react"
import { Check, CornerDownLeft, Lock, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { createClient } from "@/lib/supabase/client"
import { cn } from "@/lib/utils"
import { useTranslation } from "@/hooks/use-translation"
import { useUser } from "@/hooks/use-user"
import type {
  BookkeepingFrequency,
  CustomerRecurringWork,
  CustomerStructure,
  MomsPeriod,
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
const MOMS_ORDER: MomsPeriod[] = ["manad", "kvartal", "helar"]
const BOOKKEEPING_ORDER: BookkeepingFrequency[] = ["manad", "kvartal"]

const EMPTY_STRUCTURE: CustomerStructure = {
  moms_period: null,
  has_payroll: null,
  payroll_run_day: 25,
  bookkeeping_frequency: null,
}

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
  const [structure, setStructure] = React.useState<CustomerStructure>(EMPTY_STRUCTURE)

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

  const momsLabels: Record<MomsPeriod, string> = React.useMemo(
    () => ({
      manad: t("belaggning.moms.manad", "Monthly"),
      kvartal: t("belaggning.moms.kvartal", "Quarterly"),
      helar: t("belaggning.moms.helar", "Yearly"),
    }),
    [t],
  )

  const bookkeepingLabels: Record<BookkeepingFrequency, string> = React.useMemo(
    () => ({
      manad: t("belaggning.moms.manad", "Monthly"),
      kvartal: t("belaggning.moms.kvartal", "Quarterly"),
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

      const [{ data, error }, structureRes] = await Promise.all([
        supabase
          .from("customer_recurring_work")
          .select("*")
          .eq("customer_id", id)
          .eq("is_active", true)
          .order("cadence")
          .order("label"),
        supabase
          .from("customers")
          .select("moms_period, has_payroll, payroll_run_day, bookkeeping_frequency")
          .eq("id", id)
          .single(),
      ])

      if (cancelled) return

      if (error) {
        toast.error(t("belaggning.recurring.loadFailed", "Could not load recurring work"))
        setItems([])
      } else {
        setItems((data ?? []) as CustomerRecurringWork[])
      }

      const loaded = structureRes.data as CustomerStructure | null
      setStructure(
        loaded
          ? { ...loaded, payroll_run_day: loaded.payroll_run_day ?? 25 }
          : EMPTY_STRUCTURE,
      )
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

  /**
   * The structural facts are what turn the calendar from a spread into a
   * schedule — momsperiod puts a date on the 12th, payroll_run_day on the 25th.
   * They are saved with the confirmation rather than in a separate settings
   * screen because this is the one moment somebody is already looking at the
   * customer and can answer in two clicks.
   */
  async function saveStructure(customerId: string) {
    const { error } = await supabase
      .from("customers")
      .update({
        moms_period: structure.moms_period,
        has_payroll: structure.has_payroll,
        payroll_run_day: structure.payroll_run_day ?? 25,
        bookkeeping_frequency: structure.bookkeeping_frequency,
      } as never)
      .eq("id", customerId)

    if (error) {
      toast.error(t("belaggning.structure.saveFailed", "Could not save the customer facts"))
    }
  }

  async function confirmCurrent() {
    if (!current || saving) return

    // Confirming an empty list is a real answer — "this customer needs nothing
    // recurring" — but there is no row to stamp, so the structure is still
    // worth keeping before moving on.
    if (items.length === 0) {
      setSaving(true)
      await saveStructure(current.customer_id)
      setSaving(false)
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

    if (error) {
      setSaving(false)
      toast.error(t("belaggning.recurring.saveFailed", "Could not save"))
      return
    }

    await saveStructure(current.customer_id)
    setSaving(false)

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
          {/* Four facts, two clicks. Each one puts a real date on the calendar
              that no amount of averaging history could produce. */}
          <div className="space-y-2 rounded-md border border-border p-3">
            <p className="text-xs font-medium">
              {t("belaggning.structure.title", "Customer facts")}
            </p>

            <div className="flex items-center gap-2">
              <span className="w-24 shrink-0 text-xs text-muted-foreground">
                {t("belaggning.structure.moms", "VAT period")}
              </span>
              <div className="flex flex-wrap gap-1">
                {MOMS_ORDER.map((period) => (
                  <Button
                    key={period}
                    variant={structure.moms_period === period ? "secondary" : "ghost"}
                    size="xs"
                    className="h-6 px-2 text-xs"
                    onClick={() =>
                      setStructure((value) => ({
                        ...value,
                        moms_period: value.moms_period === period ? null : period,
                      }))
                    }
                  >
                    {momsLabels[period]}
                  </Button>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <span className="w-24 shrink-0 text-xs text-muted-foreground">
                {t("belaggning.structure.payroll", "Payroll")}
              </span>
              <Button
                variant={structure.has_payroll ? "secondary" : "ghost"}
                size="xs"
                className="h-6 px-2 text-xs"
                onClick={() =>
                  setStructure((value) => ({ ...value, has_payroll: !value.has_payroll }))
                }
              >
                {structure.has_payroll
                  ? t("belaggning.structure.payrollYes", "We run payroll")
                  : t("belaggning.structure.payrollNo", "No payroll")}
              </Button>
              {structure.has_payroll ? (
                <div className="flex items-center gap-1">
                  <Input
                    type="number"
                    min="1"
                    max="31"
                    value={structure.payroll_run_day ?? 25}
                    onChange={(event) =>
                      setStructure((value) => ({
                        ...value,
                        payroll_run_day:
                          event.target.value === "" ? 25 : Number(event.target.value),
                      }))
                    }
                    className="h-6 w-14 text-xs"
                    aria-label={t("belaggning.structure.payrollDay", "Payday")}
                  />
                  <span className="text-xs text-muted-foreground">
                    {t("belaggning.structure.payrollDay", "Payday")}
                  </span>
                </div>
              ) : null}
            </div>

            <div className="flex items-center gap-2">
              <span className="w-24 shrink-0 text-xs text-muted-foreground">
                {t("belaggning.structure.bookkeeping", "Bookkeeping")}
              </span>
              <div className="flex flex-wrap gap-1">
                {BOOKKEEPING_ORDER.map((frequency) => (
                  <Button
                    key={frequency}
                    variant={
                      structure.bookkeeping_frequency === frequency ? "secondary" : "ghost"
                    }
                    size="xs"
                    className="h-6 px-2 text-xs"
                    onClick={() =>
                      setStructure((value) => ({
                        ...value,
                        bookkeeping_frequency:
                          value.bookkeeping_frequency === frequency ? null : frequency,
                      }))
                    }
                  >
                    {bookkeepingLabels[frequency]}
                  </Button>
                ))}
              </div>
            </div>
          </div>

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
