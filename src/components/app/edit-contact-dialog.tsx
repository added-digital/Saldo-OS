"use client"

import * as React from "react"

import type { Customer } from "@/types/database"
import { useTranslation } from "@/hooks/use-translation"
import { CustomerMultiSelect } from "@/components/app/customer-multi-select"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

type CustomerOption = Pick<Customer, "id" | "name" | "fortnox_customer_number">

interface ContactInput {
  id: string
  name: string
  first_name: string | null
  last_name: string | null
  role: string | null
  email: string | null
  phone: string | null
  linkedin: string | null
  notes: string | null
}

interface ContactFields {
  name: string
  firstName: string | null
  lastName: string | null
  role: string | null
  email: string | null
  phone: string | null
  linkedin: string | null
  notes: string | null
}

type CustomerDetailSavePayload = ContactFields & {
  relationshipLabel: string | null
  relatedCustomerIds: string[]
}

type SettingsSavePayload = ContactFields & {
  primaryCustomerIds: string[]
  customerIds: string[]
}

interface EditContactDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  contact: ContactInput | null
  customers: CustomerOption[]
  initialPrimaryCustomerIds: string[]
  initialCustomerIds: string[]
  existingPrimaryByCustomerId?: Record<
    string,
    { customerName: string; contactId: string; contactName: string }
  >
  onSave: (data: SettingsSavePayload) => Promise<void>
}

const EMPTY_FORM = {
  firstName: "",
  lastName: "",
  role: "",
  email: "",
  phone: "",
  linkedin: "",
  notes: "",
}

function EditContactDialog(props: EditContactDialogProps) {
  const { open, onOpenChange, customers } = props
  const { t } = useTranslation()

  const [form, setForm] = React.useState(EMPTY_FORM)
  const [saving, setSaving] = React.useState(false)
  const [primaryCustomerIds, setPrimaryCustomerIds] = React.useState<string[]>(
    [],
  )
  const [customerIds, setCustomerIds] = React.useState<string[]>([])
  const primaryCustomerIdsKey = React.useMemo(
    () => props.initialPrimaryCustomerIds.join("|"),
    [props.initialPrimaryCustomerIds],
  )
  const customerIdsKey = React.useMemo(
    () => props.initialCustomerIds.join("|"),
    [props.initialCustomerIds],
  )

  React.useEffect(() => {
    if (!open) return
    setSaving(false)

    const c = props.contact
    const fallbackNameParts = (c?.name ?? "").trim().split(/\s+/).filter(Boolean)
    const fallbackFirstName = fallbackNameParts[0] ?? ""
    const fallbackLastName = fallbackNameParts.slice(1).join(" ")
    setForm(
      c
        ? {
            firstName: c.first_name ?? fallbackFirstName,
            lastName: c.last_name ?? fallbackLastName,
            role: c.role ?? "",
            email: c.email ?? "",
            phone: c.phone ?? "",
            linkedin: c.linkedin ?? "",
            notes: c.notes ?? "",
          }
        : EMPTY_FORM,
    )

    setPrimaryCustomerIds(props.initialPrimaryCustomerIds)
    setCustomerIds(props.initialCustomerIds)
  }, [
    open,
    props.contact,
    primaryCustomerIdsKey,
    customerIdsKey,
    props.initialPrimaryCustomerIds,
    props.initialCustomerIds,
  ])

  const isAdding = !props.contact
  const primaryReplacementWarnings = React.useMemo(() => {
    const map = props.existingPrimaryByCustomerId ?? {}
    return primaryCustomerIds
      .map((customerId) => map[customerId])
      .filter(
        (entry): entry is { customerName: string; contactId: string; contactName: string } =>
          Boolean(entry && entry.contactId !== props.contact?.id)
      )
  }, [primaryCustomerIds, props.existingPrimaryByCustomerId, props.contact?.id])

  async function handleSave() {
    const derivedName = [form.firstName.trim(), form.lastName.trim()]
      .filter(Boolean)
      .join(" ")

    if (!derivedName) return
    setSaving(true)

    const fields: ContactFields = {
      name: derivedName,
      firstName: form.firstName.trim() || null,
      lastName: form.lastName.trim() || null,
      role: form.role.trim() || null,
      email: form.email.trim() || null,
      phone: form.phone.trim() || null,
      linkedin: form.linkedin.trim() || null,
      notes: form.notes.trim() || null,
    }

    try {
      await props.onSave({
        ...fields,
        primaryCustomerIds,
        customerIds,
      })
      onOpenChange(false)
    } catch {
      // Parent handles error toasts
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isAdding
              ? t("customers.contactDialog.addTitle", "Add Contact")
              : t("customers.contactDialog.editTitle", "Edit Contact")}
          </DialogTitle>
          <DialogDescription>
            {isAdding
              ? t("customers.contactDialog.addDescription", "Add a new contact person.")
              : t("customers.contactDialog.editDescription", "Update the contact details.")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="contact-first-name">
                {t("customers.contactDialog.firstName", "First Name")}
              </Label>
              <Input
                id="contact-first-name"
                placeholder={t("customers.contactDialog.firstNamePlaceholder", "First name")}
                value={form.firstName}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, firstName: e.target.value }))
                }
              />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="contact-last-name">
                {t("customers.contactDialog.lastName", "Last Name")}
              </Label>
              <Input
                id="contact-last-name"
                placeholder={t("customers.contactDialog.lastNamePlaceholder", "Last name")}
                value={form.lastName}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, lastName: e.target.value }))
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="contact-role">
                {t("customers.contactDialog.role", "Role")}
              </Label>
              <Input
                id="contact-role"
                placeholder={t("customers.contactDialog.rolePlaceholder", "e.g. CEO, CFO")}
                value={form.role}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, role: e.target.value }))
                }
              />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="contact-email">
                {t("customers.contactDialog.email", "Email")}
              </Label>
              <Input
                id="contact-email"
                type="email"
                placeholder={t("customers.contactDialog.emailPlaceholder", "email@example.com")}
                value={form.email}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, email: e.target.value }))
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="contact-phone">
                {t("customers.contactDialog.phone", "Phone")}
              </Label>
              <Input
                id="contact-phone"
                type="tel"
                placeholder={t("customers.contactDialog.phonePlaceholder", "+46 70 123 45 67")}
                value={form.phone}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, phone: e.target.value }))
                }
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="contact-linkedin">
              {t("customers.contactDialog.linkedin", "LinkedIn")}
            </Label>
            <Input
              id="contact-linkedin"
              placeholder={t("customers.contactDialog.linkedinPlaceholder", "https://linkedin.com/in/...")}
              value={form.linkedin}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, linkedin: e.target.value }))
              }
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="contact-notes">
              {t("customers.contactDialog.notes", "Notes")}
            </Label>
            <Input
              id="contact-notes"
              placeholder={t("customers.contactDialog.notesPlaceholder", "Additional notes...")}
              value={form.notes}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, notes: e.target.value }))
              }
            />
          </div>
          <div className="space-y-2">
            <Label>{t("customers.contactDialog.primaryFor", "Primary contact for")}</Label>
            <CustomerMultiSelect
              customers={customers}
              selectedIds={primaryCustomerIds}
              onChange={setPrimaryCustomerIds}
            />
          </div>
          <div className="space-y-2">
            <Label>{t("customers.contactDialog.contactFor", "Contact for")}</Label>
            <CustomerMultiSelect
              customers={customers}
              selectedIds={customerIds}
              onChange={setCustomerIds}
            />
          </div>
          {primaryReplacementWarnings.length > 0 ? (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              {primaryReplacementWarnings.map((warning) => (
                <p key={`${warning.customerName}-${warning.contactId}`}>
                  {warning.customerName}:{" "}
                  {t("customers.contactDialog.warningPrefix", "primary contact relation with")}{" "}
                  {warning.contactName}{" "}
                  {t(
                    "customers.contactDialog.warningSuffix",
                    "will be removed. If that contact has no relationships left, it will be deleted.",
                  )}
                </p>
              ))}
            </div>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t("customers.contactDialog.cancel", "Cancel")}
            </Button>
            <Button
              onClick={handleSave}
              disabled={
                (!form.firstName.trim() && !form.lastName.trim()) ||
                saving
              }
            >
              {saving
                ? t("customers.contactDialog.saving", "Saving...")
                : isAdding
                  ? t("customers.contactDialog.add", "Add Contact")
                  : t("customers.contactDialog.update", "Update Contact")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export {
  EditContactDialog,
  type EditContactDialogProps,
  type ContactFields,
  type ContactInput,
  type SettingsSavePayload,
}
