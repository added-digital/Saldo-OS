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

type CustomerOption = { id: string; name: string; office: string | null }
type ConsultantOption = { id: string; name: string }

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
  const [group, setGroup] = React.useState<string>(NONE)
  const [fiscalYearEnd, setFiscalYearEnd] = React.useState<string>(defaultFiscalYearEnd)
  const [creating, setCreating] = React.useState(false)

  // Lazy-load the option lists the first time the dialog opens.
  React.useEffect(() => {
    if (!open || customers.length > 0) return
    let cancelled = false
    void (async () => {
      const supabase = createClient()
      const [custRes, profRes] = await Promise.all([
        supabase.from("customers").select("id, name, office").eq("status", "active").order("name").limit(1000),
        supabase.from("profiles").select("id, full_name, email").eq("is_active", true).order("full_name").limit(500),
      ])
      if (cancelled) return
      setCustomers(((custRes.data ?? []) as Array<{ id: string; name: string; office: string | null }>).map((c) => ({ id: c.id, name: c.name, office: c.office })))
      setConsultants(((profRes.data ?? []) as Array<{ id: string; full_name: string | null; email: string }>).map((p) => ({ id: p.id, name: p.full_name ?? p.email })))
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

  // Default the group to the selected customer's office (overridable below).
  React.useEffect(() => {
    const office = customers.find((c) => c.id === customerId)?.office
    setGroup(office && office.trim() ? office : NONE)
  }, [customerId, customers])

  // Dropdown options: the known groups, plus this customer's office if new.
  const groupSelectOptions = React.useMemo(() => {
    const set = new Set(groupOptions.filter((g) => g && g.trim()))
    if (selectedCustomer?.office && selectedCustomer.office.trim()) set.add(selectedCustomer.office)
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [groupOptions, selectedCustomer])

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
            <Label>{t("engagements.create.group", "Group")}</Label>
            <Select value={group} onValueChange={setGroup}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>—</SelectItem>
                {groupSelectOptions.map((g) => (
                  <SelectItem key={g} value={g}>
                    {g}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
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
