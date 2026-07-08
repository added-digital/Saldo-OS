"use client"

import * as React from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"

import { createClient } from "@/lib/supabase/client"
import { cn } from "@/lib/utils"
import { useTranslation } from "@/hooks/use-translation"
import { useSidebar } from "@/components/layout/sidebar"
import { useUnsavedChangesGuard } from "@/components/app/unsaved-changes"
import type { ChecklistValue, EngagementChecklistField } from "@/types/engagement"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { DateInput } from "@/components/ui/date-input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { OnboardingDot } from "@/components/app/onboarding-dot"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

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
  financialYearManual: string,
  bokslutRelevant: boolean,
): string {
  const sorted = Object.keys(setup)
    .sort()
    .map((k) => `${k}:${setup[k]}`)
    .join("|")
  return `${sorted}~~${date}~~${price}~~${financialYearManual}~~${bokslutRelevant}`
}

const SV_MONTHS = ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"]
const SV_MONTHS_FULL = [
  "Januari", "Februari", "Mars", "April", "Maj", "Juni",
  "Juli", "Augusti", "September", "Oktober", "November", "December",
]
// Year-ends are recurring (month-day only). We store the manual value with a
// fixed sentinel leap year (handles 29 Feb); only the month-day is ever read.
const FY_SENTINEL_YEAR = "2000"

/** Format an ISO date's MM-DD as a Swedish month-day, e.g. "31 dec". */
function formatYearEnd(iso: string | null): string {
  if (!iso) return "—"
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return "—"
  const month = SV_MONTHS[Number(m[1]) - 1] ?? m[1]
  return `${Number(m[2])} ${month}`
}

/**
 * The durable Bokslut "tags" for a customer (permissions, systems, agreements).
 * This is the source of truth — the Bokslut board reads these read-only.
 * Saving also clears the customer's needs_segmentation flag.
 */
export function CustomerBokslutSetup({
  customerId,
  highlight = false,
}: {
  customerId: string
  highlight?: boolean
}) {
  const { t } = useTranslation()
  const { collapsed } = useSidebar()
  const [fields, setFields] = React.useState<EngagementChecklistField[]>([])
  const [setup, setSetup] = React.useState<Record<string, ChecklistValue>>({})
  const [needsSegmentation, setNeedsSegmentation] = React.useState(false)
  // Whether Bokslut applies to this customer at all. When false, the
  // bokslutsuppgifter below are hidden and the customer drops off the
  // "Without bokslut" gap list.
  const [bokslutRelevant, setBokslutRelevant] = React.useState(true)
  const [saldoavtalDate, setSaldoavtalDate] = React.useState<string>("")
  const [fixedMonthlyPrice, setFixedMonthlyPrice] = React.useState<string>("")
  // Räkenskapsår end sources, in priority order: _bv (Bolagsverket) and _sie
  // are both read-only; _manual is editable only when neither is present.
  const [financialYearToBv, setFinancialYearToBv] = React.useState<string | null>(null)
  const [financialYearToSie, setFinancialYearToSie] = React.useState<string | null>(null)
  const [financialYearToManual, setFinancialYearToManual] = React.useState<string>("")
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  // Signature of the last-saved values, to detect unsaved changes.
  const [snapshot, setSnapshot] = React.useState<string>("")
  // Last-saved structured values, so "Discard" can restore them.
  const savedRef = React.useRef<{
    setup: Record<string, ChecklistValue>
    date: string
    price: string
    financialYearManual: string
    bokslutRelevant: boolean
  }>({ setup: {}, date: "", price: "", financialYearManual: "", bokslutRelevant: true })

  const currentSignature = React.useMemo(
    () => serializeSetup(setup, saldoavtalDate, fixedMonthlyPrice, financialYearToManual, bokslutRelevant),
    [setup, saldoavtalDate, fixedMonthlyPrice, financialYearToManual, bokslutRelevant],
  )
  const dirty = currentSignature !== snapshot

  // Report unsaved changes to the app-wide navigation guard.
  useUnsavedChangesGuard(dirty, `bokslut-setup:${customerId}`)

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      const supabase = createClient()
      const [cfgRes, custRes] = await Promise.all([
        supabase.from("engagement_config").select("checklist_fields").eq("id", 1).maybeSingle(),
        supabase.from("customers").select("bokslut_setup, needs_segmentation, bokslut_relevant, saldoavtal_date, fixed_monthly_price, financial_year_to_bv, financial_year_to_sie, financial_year_to_manual").eq("id", customerId).maybeSingle(),
      ])
      if (cancelled) return
      const cfg = cfgRes.data as { checklist_fields: EngagementChecklistField[] | null } | null
      setFields((cfg?.checklist_fields ?? []).filter((f) => f.scope === "customer"))
      const cust = custRes.data as {
        bokslut_setup: Record<string, ChecklistValue> | null
        needs_segmentation: boolean
        bokslut_relevant: boolean | null
        saldoavtal_date: string | null
        fixed_monthly_price: number | null
        financial_year_to_bv: string | null
        financial_year_to_sie: string | null
        financial_year_to_manual: string | null
      } | null
      const loadedSetup = cust?.bokslut_setup ?? {}
      const loadedDate = cust?.saldoavtal_date ?? ""
      const loadedPrice = cust?.fixed_monthly_price != null ? String(cust.fixed_monthly_price) : ""
      const loadedFyManual = cust?.financial_year_to_manual ?? ""
      // Default to relevant when the column is null/missing.
      const loadedRelevant = cust?.bokslut_relevant !== false
      setSetup(loadedSetup)
      setNeedsSegmentation(Boolean(cust?.needs_segmentation))
      setBokslutRelevant(loadedRelevant)
      setSaldoavtalDate(loadedDate)
      setFixedMonthlyPrice(loadedPrice)
      setFinancialYearToBv(cust?.financial_year_to_bv ?? null)
      setFinancialYearToSie(cust?.financial_year_to_sie ?? null)
      setFinancialYearToManual(loadedFyManual)
      setSnapshot(serializeSetup(loadedSetup, loadedDate, loadedPrice, loadedFyManual, loadedRelevant))
      savedRef.current = {
        setup: { ...loadedSetup },
        date: loadedDate,
        price: loadedPrice,
        financialYearManual: loadedFyManual,
        bokslutRelevant: loadedRelevant,
      }
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
        bokslut_relevant: bokslutRelevant,
        saldoavtal_date: saldoavtalDate || null,
        fixed_monthly_price: priceNum != null && Number.isFinite(priceNum) ? priceNum : null,
        // Only the MANUAL column is written here; the _sie column is sync-owned.
        financial_year_to_manual: financialYearToManual || null,
      } as never)
      .eq("id", customerId)
    if (error) {
      setSaving(false)
      toast.error(error.message)
      return
    }
    // Push the saved räkenskapsår month-day onto this customer's existing
    // engagements (keeps each engagement's cycle year). Explicit, user-driven —
    // unlike the nightly sync, which never moves engagement year-ends.
    const { error: propErr } = await supabase.rpc(
      "propagate_customer_financial_year" as never,
      { p_customer_id: customerId } as never,
    )
    setSaving(false)
    if (propErr) {
      toast.error(propErr.message)
      // Customer save already succeeded; surface the propagation issue only.
    }
    setNeedsSegmentation(false)
    // Tell the top-bar segmentation alert to refetch — this customer just had
    // its needs_segmentation flag cleared, so it should drop off that list
    // without a full page reload.
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("saldo:segmentation-updated"))
    }
    // Mark the just-saved values as the new clean baseline.
    const savedPrice = priceNum != null && Number.isFinite(priceNum) ? fixedMonthlyPrice : ""
    savedRef.current = { setup: { ...setup }, date: saldoavtalDate, price: savedPrice, financialYearManual: financialYearToManual, bokslutRelevant }
    setSnapshot(serializeSetup(setup, saldoavtalDate, savedPrice, financialYearToManual, bokslutRelevant))
    if (savedPrice !== fixedMonthlyPrice) setFixedMonthlyPrice(savedPrice)
    toast.success(t("customers.bokslut.saved", "Customer setup saved"))
  }

  function handleDiscard() {
    setSetup({ ...savedRef.current.setup })
    setSaldoavtalDate(savedRef.current.date)
    setFixedMonthlyPrice(savedRef.current.price)
    setFinancialYearToManual(savedRef.current.financialYearManual)
    setBokslutRelevant(savedRef.current.bokslutRelevant)
  }

  if (loading) {
    return <Skeleton className="h-40 w-full rounded-lg" />
  }
  if (fields.length === 0) return null

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2 text-base">
          {t("customers.bokslut.title", "Bokslut setup")}
          {highlight ? <OnboardingDot /> : null}
        </CardTitle>
        {needsSegmentation ? (
          <Badge variant="outline" className="border-semantic-warning/40 text-semantic-warning">
            {t("customers.bokslut.needsSegmentation", "Needs segmentation")}
          </Badge>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Relevance toggle, directly under the title. When off, everything below
            is hidden and the customer drops off the "Without bokslut" gap list. */}
        <div className="flex items-center gap-3">
          <Switch
            id="bokslut-relevant"
            checked={bokslutRelevant}
            onCheckedChange={setBokslutRelevant}
            className="cursor-pointer"
          />
          <div className="space-y-0.5">
            <Label htmlFor="bokslut-relevant" className="cursor-pointer">
              {t("customers.bokslut.relevantLabel", "Bokslut relevant")}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t(
                "customers.bokslut.relevantHint",
                "Turn off if a year-end close isn't relevant for this customer.",
              )}
            </p>
          </div>
        </div>

        {!bokslutRelevant ? (
          <p className="text-sm text-muted-foreground">
            {t(
              "customers.bokslut.notRelevant",
              "Bokslut is not relevant for this customer. The year-end details are hidden.",
            )}
          </p>
        ) : (
          <>
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

        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="financial-year-end">{t("customers.bokslut.financialYear", "Financial year-end")}</Label>
            <Badge variant="outline" className="text-[11px]">
              {financialYearToBv
                ? t("customers.bokslut.financialYearFromBolagsverket", "From Bolagsverket")
                : financialYearToSie
                  ? t("customers.bokslut.financialYearFromSie", "From SIE")
                  : t("customers.bokslut.financialYearManual", "Manual")}
            </Badge>
          </div>
          {financialYearToBv || financialYearToSie ? (
            // Bolagsverket (preferred) or SIE → read-only, shown as the
            // recurring month-day pattern. Precedence matches the DB:
            // Bolagsverket → SIE → manual.
            <div className="flex h-9 w-full items-center rounded-md border bg-muted/30 px-3 text-sm text-muted-foreground">
              {formatYearEnd(financialYearToBv ?? financialYearToSie!)}
            </div>
          ) : (
            (() => {
              // Recurring year-end as month + day (no year). Stored as
              // <sentinel>-MM-DD; only month-day is ever used downstream.
              const fyMonth = /^\d{4}-(\d{2})-\d{2}$/.exec(financialYearToManual)?.[1] ?? ""
              const fyDay = /^\d{4}-\d{2}-(\d{2})$/.exec(financialYearToManual)?.[1] ?? ""
              const daysInMonth = fyMonth ? new Date(2000, Number(fyMonth), 0).getDate() : 31
              return (
                <div className="grid grid-cols-2 gap-2">
                  <Select
                    value={fyMonth || undefined}
                    onValueChange={(m) => {
                      if (m === "none") {
                        setFinancialYearToManual("")
                        return
                      }
                      const last = new Date(2000, Number(m), 0).getDate()
                      const day = fyDay && Number(fyDay) <= last ? fyDay : String(last).padStart(2, "0")
                      setFinancialYearToManual(`${FY_SENTINEL_YEAR}-${m}-${day}`)
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder={t("customers.bokslut.month", "Month")} />
                    </SelectTrigger>
                    <SelectContent className="max-h-60">
                      <SelectItem value="none">—</SelectItem>
                      {SV_MONTHS_FULL.map((name, i) => (
                        <SelectItem key={i} value={String(i + 1).padStart(2, "0")}>
                          {name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={fyDay || undefined}
                    onValueChange={(d) => {
                      if (fyMonth) setFinancialYearToManual(`${FY_SENTINEL_YEAR}-${fyMonth}-${d}`)
                    }}
                    disabled={!fyMonth}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder={t("customers.bokslut.day", "Day")} />
                    </SelectTrigger>
                    <SelectContent className="max-h-60">
                      {Array.from({ length: daysInMonth }, (_, i) => String(i + 1).padStart(2, "0")).map((d) => (
                        <SelectItem key={d} value={d}>
                          {Number(d)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )
            })()
          )}
          <p className="text-xs text-muted-foreground">
            {t("customers.bokslut.financialYearHint", "The recurring year-end. From Bolagsverket when available, else SIE when connected; otherwise enter it manually.")}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="saldoavtal-date">{t("customers.bokslut.saldoavtalDate", "Saldoavtal date")}</Label>
            <DateInput
              id="saldoavtal-date"
              value={saldoavtalDate}
              onChange={setSaldoavtalDate}
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
          </>
        )}

      </CardContent>

      {/* Floating save bar — appears only when there are unsaved changes. */}
      {dirty ? (
        <div
          className="pointer-events-none fixed bottom-6 right-0 z-40 flex justify-center px-4 transition-[left] duration-200"
          style={{
            left: collapsed
              ? "var(--sidebar-width-collapsed)"
              : "var(--sidebar-width)",
          }}
        >
          <div className="pointer-events-auto flex items-center gap-3 rounded-lg border bg-background/95 py-2 pl-4 pr-2 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-background/80">
            <span className="flex items-center gap-2 text-sm font-medium">
              <span className="relative flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-semantic-warning opacity-60" />
                <span className="relative inline-flex size-2 rounded-full bg-semantic-warning" />
              </span>
              {t("customers.bokslut.unsaved", "Unsaved changes")}
            </span>
            <div className="flex items-center gap-1.5">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleDiscard}
                disabled={saving}
              >
                {t("customers.bokslut.discard", "Discard")}
              </Button>
              <Button onClick={handleSave} disabled={saving} size="sm">
                {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                {saving
                  ? t("customers.bokslut.saving", "Saving…")
                  : t("customers.bokslut.save", "Save setup")}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </Card>
  )
}
