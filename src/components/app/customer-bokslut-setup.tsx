"use client"

import * as React from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"

import { createClient } from "@/lib/supabase/client"
import { cn } from "@/lib/utils"
import { useTranslation } from "@/hooks/use-translation"
import type { ChecklistValue, EngagementChecklistField } from "@/types/engagement"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

const CYCLE: Array<ChecklistValue | undefined> = [undefined, "yes", "no", "na"]
function nextValue(v: ChecklistValue | undefined): ChecklistValue | undefined {
  return CYCLE[(CYCLE.indexOf(v) + 1) % CYCLE.length]
}

// Stable signature of the editable values (setup keys sorted) so we can detect
// unsaved changes regardless of key insertion order.
function serializeSetup(
  setup: Record<string, ChecklistValue>,
  date: string,
  price: string,
): string {
  const sorted = Object.keys(setup)
    .sort()
    .map((k) => `${k}:${setup[k]}`)
    .join("|")
  return `${sorted}~~${date}~~${price}`
}

/**
 * The durable Bokslut "tags" for a customer (permissions, systems, agreements).
 * This is the source of truth — the Bokslut board reads these read-only.
 * Saving also clears the customer's needs_segmentation flag.
 */
export function CustomerBokslutSetup({ customerId }: { customerId: string }) {
  const { t } = useTranslation()
  const [fields, setFields] = React.useState<EngagementChecklistField[]>([])
  const [setup, setSetup] = React.useState<Record<string, ChecklistValue>>({})
  const [needsSegmentation, setNeedsSegmentation] = React.useState(false)
  const [saldoavtalDate, setSaldoavtalDate] = React.useState<string>("")
  const [fixedMonthlyPrice, setFixedMonthlyPrice] = React.useState<string>("")
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  // Signature of the last-saved values, to detect unsaved changes.
  const [snapshot, setSnapshot] = React.useState<string>("")

  const currentSignature = React.useMemo(
    () => serializeSetup(setup, saldoavtalDate, fixedMonthlyPrice),
    [setup, saldoavtalDate, fixedMonthlyPrice],
  )
  const dirty = currentSignature !== snapshot

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      const supabase = createClient()
      const [cfgRes, custRes] = await Promise.all([
        supabase.from("engagement_config").select("checklist_fields").eq("id", 1).maybeSingle(),
        supabase.from("customers").select("bokslut_setup, needs_segmentation, saldoavtal_date, fixed_monthly_price").eq("id", customerId).maybeSingle(),
      ])
      if (cancelled) return
      const cfg = cfgRes.data as { checklist_fields: EngagementChecklistField[] | null } | null
      setFields((cfg?.checklist_fields ?? []).filter((f) => f.scope === "customer"))
      const cust = custRes.data as {
        bokslut_setup: Record<string, ChecklistValue> | null
        needs_segmentation: boolean
        saldoavtal_date: string | null
        fixed_monthly_price: number | null
      } | null
      const loadedSetup = cust?.bokslut_setup ?? {}
      const loadedDate = cust?.saldoavtal_date ?? ""
      const loadedPrice = cust?.fixed_monthly_price != null ? String(cust.fixed_monthly_price) : ""
      setSetup(loadedSetup)
      setNeedsSegmentation(Boolean(cust?.needs_segmentation))
      setSaldoavtalDate(loadedDate)
      setFixedMonthlyPrice(loadedPrice)
      setSnapshot(serializeSetup(loadedSetup, loadedDate, loadedPrice))
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [customerId])

  // Group fields by their "group" label, preserving first-seen order.
  const grouped = React.useMemo(() => {
    const groups: Array<{ name: string; fields: EngagementChecklistField[] }> = []
    for (const f of fields) {
      const name = f.group ?? ""
      let g = groups.find((x) => x.name === name)
      if (!g) {
        g = { name, fields: [] }
        groups.push(g)
      }
      g.fields.push(f)
    }
    return groups
  }, [fields])

  function cycle(key: string) {
    setSetup((cur) => {
      const next = nextValue(cur[key])
      const updated = { ...cur }
      if (next === undefined) delete updated[key]
      else updated[key] = next
      return updated
    })
  }

  async function handleSave() {
    setSaving(true)
    const supabase = createClient()
    const priceNum = fixedMonthlyPrice.trim() === "" ? null : Number(fixedMonthlyPrice)
    const { error } = await supabase
      .from("customers")
      .update({
        bokslut_setup: setup,
        needs_segmentation: false,
        saldoavtal_date: saldoavtalDate || null,
        fixed_monthly_price: priceNum != null && Number.isFinite(priceNum) ? priceNum : null,
      } as never)
      .eq("id", customerId)
    setSaving(false)
    if (error) {
      toast.error(error.message)
      return
    }
    setNeedsSegmentation(false)
    toast.success(t("customers.bokslut.saved", "Customer setup saved"))
  }

  if (loading) {
    return <Skeleton className="h-40 w-full rounded-lg" />
  }
  if (fields.length === 0) return null

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-base">{t("customers.bokslut.title", "Bokslut setup")}</CardTitle>
        {needsSegmentation ? (
          <Badge variant="outline" className="border-semantic-warning/40 text-semantic-warning">
            {t("customers.bokslut.needsSegmentation", "Needs segmentation")}
          </Badge>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {grouped.map((g) => (
          <div key={g.name} className="space-y-1.5">
            {g.name ? (
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{g.name}</p>
            ) : null}
            <div className="flex flex-wrap gap-1.5">
              {g.fields.map((f) => {
                const value = setup[f.key]
                return (
                  <button
                    key={f.key}
                    type="button"
                    onClick={() => cycle(f.key)}
                    className={cn(
                      "inline-flex cursor-pointer items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                      value === "yes" && "border-semantic-success/40 bg-semantic-success/10 text-semantic-success",
                      value === "no" && "border-semantic-error/40 bg-semantic-error/10 text-semantic-error",
                      value === "na" && "border-border bg-muted text-muted-foreground",
                      value === undefined && "border-dashed border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                    )}
                  >
                    {f.label}
                    <span className="opacity-70">
                      {value === "yes" ? "Ja" : value === "no" ? "Nej" : value === "na" ? "–" : "?"}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        ))}

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="saldoavtal-date">{t("customers.bokslut.saldoavtalDate", "Saldoavtal date")}</Label>
            <Input
              id="saldoavtal-date"
              type="date"
              value={saldoavtalDate}
              onChange={(e) => setSaldoavtalDate(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="fixed-monthly-price">{t("customers.bokslut.fixedPrice", "Fixed price / month (SEK)")}</Label>
            <Input
              id="fixed-monthly-price"
              type="number"
              inputMode="decimal"
              value={fixedMonthlyPrice}
              onChange={(e) => setFixedMonthlyPrice(e.target.value)}
            />
          </div>
        </div>

        <Button onClick={handleSave} disabled={saving} size="sm">
          {saving ? <Loader2 className="size-4 animate-spin" /> : null}
          {saving ? t("customers.bokslut.saving", "Saving…") : t("customers.bokslut.save", "Save setup")}
        </Button>
      </CardContent>
    </Card>
  )
}
