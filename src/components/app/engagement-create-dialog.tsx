"use client"

import * as React from "react"
import { Check, Loader2 } from "lucide-react"
import { toast } from "sonner"

import { createClient } from "@/lib/supabase/client"
import { cn } from "@/lib/utils"
import { useTranslation } from "@/hooks/use-translation"
import type { EngagementBoardRow } from "@/types/engagement"
import { deadlineForFiscalYearEnd, proposeFiscalYearEnd } from "@/lib/engagements/fiscal-year"
import { Button } from "@/components/ui/button"
import { DateInput } from "@/components/ui/date-input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

type CustomerOption = {
  id: string
  name: string
  office: string | null
  costCenter: string | null
  /** Latest annual report registered by Bolagsverket — that year is done. */
  bvYearEnd: string | null
  /** Newest book year imported from Fortnox via SIE — the open period. */
  sieYearEnd: string | null
  /** Hand-entered räkenskapsår; a shape only, no filing history. */
  manualYearEnd: string | null
}
type ConsultantOption = { id: string; name: string; costCenter: string | null }

export function EngagementCreateDialog({
  open,
  onOpenChange,
  defaultFiscalYearEnd,
  deadlineOffsetMonths,
  presetCustomerId,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  defaultFiscalYearEnd: string
  deadlineOffsetMonths: number
  presetCustomerId?: string
  onCreated: (row: EngagementBoardRow) => void
}) {
  const { t } = useTranslation()
  const [customers, setCustomers] = React.useState<CustomerOption[]>([])
  const [consultants, setConsultants] = React.useState<ConsultantOption[]>([])
  const [customerId, setCustomerId] = React.useState<string>("")
  const [consultantId, setConsultantId] = React.useState<string>("")
  const [coConsultantId, setCoConsultantId] = React.useState<string>("")
  const [fiscalYearEnd, setFiscalYearEnd] = React.useState<string>(defaultFiscalYearEnd)
  const [deadline, setDeadline] = React.useState<string>("")
  // Tracks whether the user hand-edited the deadline. Until they do, it stays
  // auto-synced to fiscal_year_end + offset; once touched we stop overwriting.
  const [deadlineTouched, setDeadlineTouched] = React.useState(false)
  // Same idea for the fiscal year: the proposal below stops once it's hand-set.
  const [fiscalYearTouched, setFiscalYearTouched] = React.useState(false)
  // Fiscal-year ends this customer already has engagements for, so the proposal
  // can skip them (and stay off the unique constraint).
  const [takenYearEnds, setTakenYearEnds] = React.useState<string[]>([])
  const [creating, setCreating] = React.useState(false)

  // Lazy-load the option lists the first time the dialog opens.
  React.useEffect(() => {
    if (!open || customers.length > 0) return
    let cancelled = false
    void (async () => {
      const supabase = createClient()
      const [custRes, profRes] = await Promise.all([
        supabase
          .from("customers")
          // The three räkenskapsår sources separately, not the coalesced
          // financial_year_to: which one a date came from changes what it means
          // for the year (see proposeFiscalYearEnd).
          .select(
            "id, name, office, fortnox_cost_center, financial_year_to_bv, financial_year_to_sie, financial_year_to_manual",
          )
          .eq("status", "active")
          .order("name")
          .limit(1000),
        supabase.from("profiles").select("id, full_name, email, fortnox_cost_center").eq("is_active", true).order("full_name").limit(500),
      ])
      if (cancelled) return
      setCustomers(
        ((custRes.data ?? []) as Array<{
          id: string
          name: string
          office: string | null
          fortnox_cost_center: string | null
          financial_year_to_bv: string | null
          financial_year_to_sie: string | null
          financial_year_to_manual: string | null
        }>).map((c) => ({
          id: c.id,
          name: c.name,
          office: c.office,
          costCenter: c.fortnox_cost_center,
          bvYearEnd: c.financial_year_to_bv,
          sieYearEnd: c.financial_year_to_sie,
          manualYearEnd: c.financial_year_to_manual,
        })),
      )
      setConsultants(
        ((profRes.data ?? []) as Array<{ id: string; full_name: string | null; email: string; fortnox_cost_center: string | null }>).map((p) => ({
          id: p.id,
          name: p.full_name ?? p.email,
          costCenter: p.fortnox_cost_center,
        })),
      )
    })()
    return () => {
      cancelled = true
    }
  }, [open, customers.length])

  React.useEffect(() => {
    if (open) {
      setFiscalYearEnd(defaultFiscalYearEnd)
      setCustomerId(presetCustomerId ?? "")
      setDeadlineTouched(false)
      setFiscalYearTouched(false)
      setTakenYearEnds([])
    }
  }, [open, defaultFiscalYearEnd, presetCustomerId])

  // Which years this customer is already booked for. Read from `engagements`
  // rather than the board rows so a card hidden by a board filter (or by RLS)
  // still counts — landing on a taken year fails the insert.
  React.useEffect(() => {
    if (!open || !customerId) {
      setTakenYearEnds([])
      return
    }
    let cancelled = false
    void (async () => {
      const supabase = createClient()
      const { data } = await supabase
        .from("engagements")
        .select("fiscal_year_end")
        .eq("customer_id", customerId)
      if (cancelled) return
      setTakenYearEnds(
        ((data ?? []) as Array<{ fiscal_year_end: string }>).map((e) => e.fiscal_year_end),
      )
    })()
    return () => {
      cancelled = true
    }
  }, [open, customerId])

  // Auto-suggest the deadline as räkenskapsårsslut + offset months, kept in sync
  // with the fiscal year until the user overrides it by hand.
  React.useEffect(() => {
    if (deadlineTouched) return
    setDeadline(deadlineForFiscalYearEnd(fiscalYearEnd, deadlineOffsetMonths))
  }, [fiscalYearEnd, deadlineOffsetMonths, deadlineTouched])

  const selectedCustomer = customers.find((c) => c.id === customerId) ?? null

  // Map each consultant's cost center → their id, so a customer's cost center
  // resolves to its customer manager (the customer↔manager link runs through
  // fortnox_cost_center; each consultant has their own).
  const ccToConsultant = React.useMemo(() => {
    const m = new Map<string, string>()
    for (const c of consultants) {
      if (c.costCenter && c.costCenter.trim() && !m.has(c.costCenter)) m.set(c.costCenter, c.id)
    }
    return m
  }, [consultants])

  // Default the main consultant to the selected customer's manager (via cost
  // center). Resets when the customer changes; overridable in the dropdown.
  React.useEffect(() => {
    const cc = customers.find((c) => c.id === customerId)?.costCenter
    const managerId = cc && cc.trim() ? ccToConsultant.get(cc) : undefined
    setConsultantId(managerId ?? "")
  }, [customerId, customers, ccToConsultant])

  // Default the fiscal year to the oldest ended räkenskapsår that still needs a
  // bokslut: Bolagsverket's latest filed year first (start after it), then SIE's
  // open book year, then the year that most recently ended — rolled past any
  // year this customer already has a card for. See proposeFiscalYearEnd.
  React.useEffect(() => {
    if (fiscalYearTouched) return
    const customer = customers.find((c) => c.id === customerId)
    setFiscalYearEnd(
      proposeFiscalYearEnd({
        bvYearEnd: customer?.bvYearEnd,
        sieYearEnd: customer?.sieYearEnd,
        manualYearEnd: customer?.manualYearEnd,
        todayISO: new Date().toISOString().slice(0, 10),
        takenYearEnds,
        fallback: defaultFiscalYearEnd,
      }),
    )
  }, [customerId, customers, defaultFiscalYearEnd, takenYearEnds, fiscalYearTouched])

  async function handleCreate() {
    if (!customerId || !fiscalYearEnd) return
    setCreating(true)
    const supabase = createClient()

    const { data, error } = await supabase
      .from("engagements")
      .insert({
        customer_id: customerId,
        fiscal_year_end: fiscalYearEnd,
        consultant_id: consultantId || null,
        co_consultant_id: coConsultantId || null,
        deadline: deadline || null,
      } as never)
      .select("id")
      .single()

    if (error) {
      setCreating(false)
      // 23505 = unique_violation on (customer_id, fiscal_year_end)
      const code = (error as { code?: string }).code
      toast.error(
        code === "23505"
          ? t("engagements.toast.exists", "That customer already has an engagement for this fiscal year.")
          : `${t("engagements.toast.error", "Couldn't update engagement")}: ${error.message}`,
      )
      return
    }

    const newId = (data as { id: string }).id
    const { data: boardRow } = await supabase
      .from("engagement_board")
      .select("*")
      .eq("id", newId)
      .single()

    setCreating(false)
    if (boardRow) {
      onCreated(boardRow as EngagementBoardRow)
      toast.success(t("engagements.toast.created", "Engagement created"))
    }
    setCustomerId("")
    setConsultantId("")
    setCoConsultantId("")
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("engagements.create.title", "New engagement")}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>{t("engagements.create.customer", "Customer")}</Label>
            {/* Once a customer is chosen, show just a chip (with a Change
                action) and hide the search entirely — no scrolling needed. */}
            {selectedCustomer ? (
              <div className="flex items-center gap-2 rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                  {selectedCustomer.name}
                </span>
                {selectedCustomer.office ? (
                  <span className="shrink-0 text-xs text-muted-foreground">{selectedCustomer.office}</span>
                ) : null}
                {/* No "Change" when routed via the gap-list shortcut — the
                    customer is fixed in that flow. */}
                {!presetCustomerId ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="shrink-0"
                    onClick={() => setCustomerId("")}
                  >
                    {t("engagements.create.changeCustomer", "Change")}
                  </Button>
                ) : null}
              </div>
            ) : (
              /* Inline (not in a Popover) so the list scrolls — a portaled
                 dropdown sits outside the Dialog's scroll-lock and can't wheel. */
              <Command className="rounded-md border">
                <CommandInput placeholder={t("engagements.create.search", "Search customers…")} />
                <CommandList className="max-h-[220px]">
                  <CommandEmpty>—</CommandEmpty>
                  {customers.map((c) => (
                    <CommandItem
                      key={c.id}
                      value={c.name}
                      onSelect={() => setCustomerId(c.id)}
                    >
                      <Check className={cn("size-4", customerId === c.id ? "opacity-100" : "opacity-0")} />
                      <span className="truncate">{c.name}</span>
                      {c.office ? <span className="ml-auto text-xs text-muted-foreground">{c.office}</span> : null}
                    </CommandItem>
                  ))}
                </CommandList>
              </Command>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="fiscal-year-end">{t("engagements.create.fiscalYear", "Fiscal year end")}</Label>
              <DateInput
                id="fiscal-year-end"
                value={fiscalYearEnd}
                onChange={(next) => {
                  setFiscalYearTouched(true)
                  setFiscalYearEnd(next)
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t("engagements.create.consultant", "Consultant")}</Label>
              <Select value={consultantId} onValueChange={setConsultantId}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="—" />
                </SelectTrigger>
                <SelectContent>
                  {consultants.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="eng-create-deadline">{t("engagements.create.deadline", "Deadline")}</Label>
            <DateInput
              id="eng-create-deadline"
              value={deadline}
              onChange={(next) => {
                setDeadlineTouched(true)
                setDeadline(next)
              }}
            />
            <p className="text-xs text-muted-foreground">
              {t(
                "engagements.create.deadlineHint",
                "Auto-set to fiscal year-end + {months} months. Edit to override.",
              ).replace("{months}", String(deadlineOffsetMonths))}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label>{t("engagements.create.coConsultant", "Co-helper")}</Label>
            <Select value={coConsultantId} onValueChange={setCoConsultantId}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent>
                {consultants
                  .filter((p) => p.id !== consultantId)
                  .map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          {/* No group selector: the engagement_board view derives a project's
              group live from the consultant's current team (fallback: the
              customer's office), so nothing is stored on create. */}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={creating}>
            {t("common.cancel", "Cancel")}
          </Button>
          <Button onClick={handleCreate} disabled={creating || !customerId || !fiscalYearEnd}>
            {creating ? <Loader2 className="size-4 animate-spin" /> : null}
            {creating ? t("engagements.create.creating", "Creating…") : t("engagements.create.create", "Create engagement")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
