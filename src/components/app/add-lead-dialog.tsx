"use client"

import * as React from "react"
import { BadgeCheck, Loader2, SearchX } from "lucide-react"
import { toast } from "sonner"

import { createClient } from "@/lib/supabase/client"
import type { WebsiteLead } from "@/types/database"
import { useTranslation } from "@/hooks/use-translation"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"

interface AddLeadDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** When set, the dialog edits this lead instead of creating a new one. */
  lead?: WebsiteLead | null
  /** Called with the created lead so the list can refresh/optimistically add. */
  onCreated?: (lead: WebsiteLead) => void
  /** Called with the updated lead when editing. */
  onUpdated?: (lead: WebsiteLead) => void
}

type LookupState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "found"; name: string | null }
  | { kind: "not_found" }
  | { kind: "error" }

interface LookupCompany {
  orgNumber: string
  name: string | null
  legalForm: string | null
  status: string | null
  address: {
    street: string | null
    postalCode: string | null
    city: string | null
  } | null
  raw: Record<string, unknown>
}

const EMPTY_FORM = {
  orgNumber: "",
  company: "",
  companyLegalForm: "",
  addressStreet: "",
  addressPostalCode: "",
  addressCity: "",
  contactName: "",
  contactRole: "",
  email: "",
  phone: "",
  note: "",
}

/** Map an existing lead's columns onto the form fields. */
function formFromLead(lead: WebsiteLead): typeof EMPTY_FORM {
  return {
    orgNumber: lead.org_number ?? "",
    company: lead.company,
    companyLegalForm: lead.company_legal_form ?? "",
    addressStreet: lead.address_street ?? "",
    addressPostalCode: lead.address_postal_code ?? "",
    addressCity: lead.address_city ?? "",
    contactName: lead.name,
    contactRole: lead.contact_role ?? "",
    email: lead.email ?? "",
    phone: lead.phone ?? "",
    // For manual leads `message` is the free-text note. Website leads carry
    // the visitor's original message, which must not be edited here.
    note: lead.source === "manual" ? lead.message : "",
  }
}

function AddLeadDialog({
  open,
  onOpenChange,
  lead,
  onCreated,
  onUpdated,
}: AddLeadDialogProps) {
  const { t } = useTranslation()
  const isEdit = !!lead
  const [form, setForm] = React.useState(EMPTY_FORM)
  const [lookup, setLookup] = React.useState<LookupState>({ kind: "idle" })
  const [bolagsverketData, setBolagsverketData] = React.useState<Record<
    string,
    unknown
  > | null>(null)
  const [saving, setSaving] = React.useState(false)
  // Guards against out-of-order lookup responses while typing.
  const lookupSeq = React.useRef(0)
  // What the last Bolagsverket lookup wrote into each field. Lets us tell
  // "still the autofilled value" apart from "user edited it", so a new lookup
  // can reseed untouched fields and clearing the org.nr can empty them.
  const autofillRef = React.useRef<Partial<typeof EMPTY_FORM>>({})

  React.useEffect(() => {
    if (open) {
      // Seed from the lead when editing; fresh form when creating.
      setForm(lead ? formFromLead(lead) : EMPTY_FORM)
    } else {
      setForm(EMPTY_FORM)
      setLookup({ kind: "idle" })
      setBolagsverketData(null)
      setSaving(false)
      autofillRef.current = {}
    }
  }, [open, lead])

  const set = (key: keyof typeof EMPTY_FORM) => (value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }))

  /**
   * Apply lookup values to the form. A field is overwritten when it is empty
   * or still holds the previous lookup's value; anything the user typed
   * themselves is left alone.
   */
  const applyAutofill = React.useCallback(
    (values: Partial<typeof EMPTY_FORM>) => {
      setForm((prev) => {
        const next = { ...prev }
        for (const key of Object.keys(values) as Array<keyof typeof EMPTY_FORM>) {
          const untouched =
            !prev[key] || prev[key] === (autofillRef.current[key] ?? "")
          if (untouched) next[key] = values[key] ?? ""
        }
        autofillRef.current = values
        return next
      })
    },
    [],
  )

  // Debounced Bolagsverket lookup once the org number reaches 10 digits.
  const orgDigits = form.orgNumber.replace(/\D/g, "")
  React.useEffect(() => {
    if (orgDigits.length !== 10 && orgDigits.length !== 12) {
      setLookup({ kind: "idle" })
      setBolagsverketData(null)
      // Org.nr removed/changed: clear fields the lookup seeded (but keep
      // anything the user edited afterwards).
      if (Object.keys(autofillRef.current).length > 0) {
        applyAutofill({
          company: "",
          companyLegalForm: "",
          addressStreet: "",
          addressPostalCode: "",
          addressCity: "",
        })
        autofillRef.current = {}
      }
      return
    }
    const seq = ++lookupSeq.current
    setLookup({ kind: "loading" })
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(
          `/api/bolagsverket/lookup?orgNumber=${encodeURIComponent(orgDigits)}`,
          { cache: "no-store" },
        )
        const payload = (await response.json().catch(() => null)) as {
          ok?: boolean
          company?: LookupCompany
          error?: string
        } | null
        if (seq !== lookupSeq.current) return

        if (!response.ok) {
          setLookup({ kind: "error" })
          return
        }
        if (!payload?.ok || !payload.company) {
          setLookup({ kind: "not_found" })
          setBolagsverketData(null)
          return
        }

        const company = payload.company
        setLookup({ kind: "found", name: company.name })
        setBolagsverketData(company.raw ?? { company })
        // Reseed autofilled fields for the new company; keep user edits.
        applyAutofill({
          company: company.name ?? "",
          companyLegalForm: company.legalForm ?? "",
          addressStreet: company.address?.street ?? "",
          addressPostalCode: company.address?.postalCode ?? "",
          addressCity: company.address?.city ?? "",
        })
      } catch {
        if (seq === lookupSeq.current) setLookup({ kind: "error" })
      }
    }, 450)
    return () => clearTimeout(timer)
  }, [orgDigits, applyAutofill])

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (!form.company.trim() || !form.contactName.trim()) {
      toast.error(
        t(
          "leads.add.required",
          "Company and contact name are required",
        ),
      )
      return
    }
    setSaving(true)
    try {
      if (isEdit && lead) {
        // Edit: update the row directly (RLS allows staff updates). The
        // visitor's original message on website leads is never touched.
        const supabase = createClient()
        const update: Record<string, unknown> = {
          company: form.company.trim(),
          name: form.contactName.trim(),
          org_number: orgDigits || null,
          company_legal_form: form.companyLegalForm.trim() || null,
          address_street: form.addressStreet.trim() || null,
          address_postal_code: form.addressPostalCode.trim() || null,
          address_city: form.addressCity.trim() || null,
          contact_role: form.contactRole.trim() || null,
          email: form.email.trim() || null,
          phone: form.phone.trim() || null,
        }
        if (lead.source === "manual") {
          update.message = form.note.trim()
        }
        if (lookup.kind === "found" && bolagsverketData) {
          update.bolagsverket_data = bolagsverketData
        }
        const { data, error } = await supabase
          .from("website_leads")
          .update(update as never)
          .eq("id", lead.id)
          .select("*")
          .single()
        if (error || !data) {
          toast.error(
            t("leads.toast.updateFailed", "Failed to update lead"),
          )
          return
        }
        toast.success(t("leads.toast.updated", "Lead updated"))
        onUpdated?.(data as unknown as WebsiteLead)
        onOpenChange(false)
        return
      }

      const response = await fetch("/api/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          company: form.company,
          orgNumber: orgDigits || null,
          companyLegalForm: form.companyLegalForm || null,
          addressStreet: form.addressStreet || null,
          addressPostalCode: form.addressPostalCode || null,
          addressCity: form.addressCity || null,
          contactName: form.contactName,
          contactRole: form.contactRole || null,
          email: form.email || null,
          phone: form.phone || null,
          note: form.note || null,
          bolagsverketData:
            lookup.kind === "found" ? bolagsverketData : null,
        }),
      })
      const payload = (await response.json().catch(() => null)) as {
        lead?: WebsiteLead
        error?: string
      } | null
      if (!response.ok || !payload?.lead) {
        toast.error(
          payload?.error ?? t("leads.add.failed", "Failed to create lead"),
        )
        return
      }
      toast.success(t("leads.add.created", "Lead created"))
      onCreated?.(payload.lead)
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isEdit
              ? t("leads.edit.title", "Edit lead")
              : t("leads.add.title", "Add lead")}
          </DialogTitle>
          <DialogDescription>
            {isEdit
              ? t(
                  "leads.edit.description",
                  "Update company and contact details. Changing the org number re-fetches from Bolagsverket.",
                )
              : t(
                  "leads.add.description",
                  "Enter an org number to fetch company details from Bolagsverket, or fill everything in manually.",
                )}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="lead-org-number">
              {t("leads.add.orgNumber", "Org number")}
            </Label>
            <div className="relative">
              <Input
                id="lead-org-number"
                value={form.orgNumber}
                onChange={(e) => set("orgNumber")(e.target.value)}
                placeholder="556012-5790"
                inputMode="numeric"
                autoComplete="off"
              />
              {lookup.kind === "loading" ? (
                <Loader2 className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
              ) : lookup.kind === "found" ? (
                <BadgeCheck className="absolute right-3 top-1/2 size-4 -translate-y-1/2 text-semantic-success" />
              ) : lookup.kind === "not_found" ? (
                <SearchX className="absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              ) : null}
            </div>
            {lookup.kind === "found" ? (
              <p className="text-xs text-muted-foreground">
                {t("leads.add.verified", "Verified via Bolagsverket")}
                {lookup.name ? `: ${lookup.name}` : ""}
              </p>
            ) : lookup.kind === "not_found" ? (
              <p className="text-xs text-muted-foreground">
                {t(
                  "leads.add.notFound",
                  "No match at Bolagsverket — fill in the details manually.",
                )}
              </p>
            ) : lookup.kind === "error" ? (
              <p className="text-xs text-destructive">
                {t("leads.add.lookupError", "Lookup failed — you can still add the lead manually.")}
              </p>
            ) : null}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="lead-company">
                {t("leads.add.company", "Company")} *
              </Label>
              <Input
                id="lead-company"
                value={form.company}
                onChange={(e) => set("company")(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="lead-legal-form">
                {t("leads.add.legalForm", "Legal form")}
              </Label>
              <Input
                id="lead-legal-form"
                value={form.companyLegalForm}
                onChange={(e) => set("companyLegalForm")(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="lead-street">
                {t("leads.add.street", "Street address")}
              </Label>
              <Input
                id="lead-street"
                value={form.addressStreet}
                onChange={(e) => set("addressStreet")(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="lead-postal">
                {t("leads.add.postalCode", "Postal code")}
              </Label>
              <Input
                id="lead-postal"
                value={form.addressPostalCode}
                onChange={(e) => set("addressPostalCode")(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="lead-city">{t("leads.add.city", "City")}</Label>
              <Input
                id="lead-city"
                value={form.addressCity}
                onChange={(e) => set("addressCity")(e.target.value)}
              />
            </div>
          </div>

          <div className="border-t pt-4">
            <p className="mb-3 text-sm font-medium">
              {t("leads.add.contact", "Primary contact")}
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="lead-contact-name">
                  {t("leads.add.contactName", "Name")} *
                </Label>
                <Input
                  id="lead-contact-name"
                  value={form.contactName}
                  onChange={(e) => set("contactName")(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="lead-contact-role">
                  {t("leads.add.contactRole", "Role")}
                </Label>
                <Input
                  id="lead-contact-role"
                  value={form.contactRole}
                  onChange={(e) => set("contactRole")(e.target.value)}
                  placeholder={t("leads.add.rolePlaceholder", "CEO, CFO...")}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="lead-email">
                  {t("leads.add.email", "Email")}
                </Label>
                <Input
                  id="lead-email"
                  type="email"
                  value={form.email}
                  onChange={(e) => set("email")(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="lead-phone">
                  {t("leads.add.phone", "Phone")}
                </Label>
                <Input
                  id="lead-phone"
                  value={form.phone}
                  onChange={(e) => set("phone")(e.target.value)}
                />
              </div>
            </div>
          </div>

          {!isEdit || lead?.source === "manual" ? (
            <div className="space-y-2">
              <Label htmlFor="lead-note">{t("leads.add.note", "Note")}</Label>
              <Textarea
                id="lead-note"
                value={form.note}
                onChange={(e) => set("note")(e.target.value)}
                rows={3}
                placeholder={t(
                  "leads.add.notePlaceholder",
                  "Context, how the lead came up, next step...",
                )}
              />
            </div>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={saving}
            >
              {t("common.cancel", "Cancel")}
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              {isEdit
                ? t("leads.edit.submit", "Save changes")
                : t("leads.add.submit", "Add lead")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export { AddLeadDialog }
