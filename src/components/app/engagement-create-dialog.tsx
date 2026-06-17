"use client"

import * as React from "react"
import { Check, Loader2 } from "lucide-react"
import { toast } from "sonner"

import { createClient } from "@/lib/supabase/client"
import { cn } from "@/lib/utils"
import { useTranslation } from "@/hooks/use-translation"
import type { EngagementBoardRow } from "@/types/engagement"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
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

type CustomerOption = { id: string; name: string; office: string | null; costCenter: string | null }
type ConsultantOption = { id: string; name: string; group: string | null; costCenter: string | null }

const NONE = "none"

export function EngagementCreateDialog({
  open,
  onOpenChange,
  defaultFiscalYearEnd,
  groupOptions,
  presetCustomerId,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  defaultFiscalYearEnd: string
  groupOptions: string[]
  presetCustomerId?: string
  onCreated: (row: EngagementBoardRow) => void
}) {
  const { t } = useTranslation()
  const [customers, setCustomers] = React.useState<CustomerOption[]>([])
  const [consultants, setConsultants] = React.useState<ConsultantOption[]>([])
  const [customerId, setCustomerId] = React.useState<string>("")
  const [consultantId, setConsultantId] = React.useState<string>("")
  const [coConsultantId, setCoConsultantId] = React.useState<string>("")
  const [group, setGroup] = React.useState<string>(NONE)
  const [fiscalYearEnd, setFiscalYearEnd] = React.useState<string>(defaultFiscalYearEnd)
  const [creating, setCreating] = React.useState(false)

  // Lazy-load the option lists the first time the dialog opens.
  React.useEffect(() => {
    if (!open || customers.length > 0) return
    let cancelled = false
    void (async () => {
      const supabase = createClient()
      const [custRes, profRes, teamRes] = await Promise.all([
        supabase.from("customers").select("id, name, office, fortnox_cost_center").eq("status", "active").order("name").limit(1000),
        // Fetch team_id only — profiles↔teams has two FKs (team_id + teams.lead_id),
        // so an embedded teams(name) is ambiguous. Resolve names via a separate map.
        supabase.from("profiles").select("id, full_name, email, team_id, fortnox_cost_center").eq("is_active", true).order("full_name").limit(500),
        supabase.from("teams").select("id, name"),
      ])
      if (cancelled) return
      setCustomers(
        ((custRes.data ?? []) as Array<{ id: string; name: string; office: string | null; fortnox_cost_center: string | null }>).map((c) => ({
          id: c.id,
          name: c.name,
          office: c.office,
          costCenter: c.fortnox_cost_center,
        })),
      )
      const teamName = new Map(
        ((teamRes.data ?? []) as Array<{ id: string; name: string | null }>).map((t) => [t.id, t.name]),
      )
      setConsultants(
        ((profRes.data ?? []) as Array<{ id: string; full_name: string | null; email: string; team_id: string | null; fortnox_cost_center: string | null }>).map((p) => ({
          id: p.id,
          name: p.full_name ?? p.email,
          // The consultant's team is the office/group on this board.
          group: p.team_id ? teamName.get(p.team_id) ?? null : null,
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
    }
  }, [open, defaultFiscalYearEnd, presetCustomerId])

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

  // Default the group from the consultant's team, falling back to the
  // customer's office. The selector is hidden on create (auto-set); it's
  // editable later in the detail sheet.
  React.useEffect(() => {
    const consultantGroup = consultants.find((c) => c.id === consultantId)?.group
    const office = customers.find((c) => c.id === customerId)?.office
    const next =
      consultantGroup && consultantGroup.trim()
        ? consultantGroup
        : office && office.trim()
          ? office
          : null
    setGroup(next ?? NONE)
  }, [customerId, consultantId, customers, consultants])

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
        group_name: group === NONE ? null : group,
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
    setGroup(NONE)
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
              <Input
                id="fiscal-year-end"
                type="date"
                value={fiscalYearEnd}
                onChange={(e) => setFiscalYearEnd(e.target.value)}
                className="[&::-webkit-calendar-picker-indicator]:invert"
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
          {/* Group is auto-derived from the consultant's team (fallback: the
              customer's office) and set on create; it stays editable in the
              engagement detail sheet, so no selector is shown here. */}
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
