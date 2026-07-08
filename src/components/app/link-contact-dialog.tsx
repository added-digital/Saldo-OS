"use client"

import * as React from "react"
import { Building2, Loader2 } from "lucide-react"

import { useTranslation } from "@/hooks/use-translation"
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

/** A contact already in the system that can be attached to the current customer. */
export interface LinkableContact {
  id: string
  name: string
  role: string | null
  email: string | null
  /** Other companies this contact is already linked to (used as suggestions). */
  linked_customers: Array<{ id: string; name: string }>
}

interface LinkExistingContactDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  contacts: LinkableContact[]
  loading?: boolean
  onLink: (contactId: string) => Promise<void>
}

export function LinkExistingContactDialog({
  open,
  onOpenChange,
  contacts,
  loading,
  onLink,
}: LinkExistingContactDialogProps) {
  const { t } = useTranslation()
  const [linkingId, setLinkingId] = React.useState<string | null>(null)

  // Contacts already linked to other companies bubble to the top — those are the
  // useful suggestions. The rest follow alphabetically.
  const sorted = React.useMemo(() => {
    return [...contacts].sort((a, b) => {
      const aHas = a.linked_customers.length > 0
      const bHas = b.linked_customers.length > 0
      if (aHas !== bHas) return aHas ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  }, [contacts])

  async function handleLink(contactId: string) {
    setLinkingId(contactId)
    try {
      await onLink(contactId)
      onOpenChange(false)
    } catch {
      // Parent handles error toasts.
    } finally {
      setLinkingId(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0">
        <DialogHeader className="px-4 pt-4">
          <DialogTitle>{t("customers.linkContact.title", "Link existing contact")}</DialogTitle>
          <DialogDescription>
            {t(
              "customers.linkContact.description",
              "Search contacts already in the system and attach one to this customer.",
            )}
          </DialogDescription>
        </DialogHeader>
        <Command className="rounded-t-none border-t">
          <CommandInput
            placeholder={t("customers.linkContact.searchPlaceholder", "Search name, role or email...")}
          />
          <CommandList className="max-h-72">
            <CommandEmpty>
              {loading
                ? t("customers.linkContact.loading", "Loading contacts...")
                : t("customers.linkContact.empty", "No contacts found.")}
            </CommandEmpty>
            {sorted.map((contact) => {
              // Append the id so cmdk keeps every entry unique; the uuid never
              // matches normal typed searches.
              const value = [
                contact.name,
                contact.role ?? "",
                contact.email ?? "",
                contact.id,
              ].join(" ")
              const isLinking = linkingId === contact.id
              const subline = [contact.role, contact.email].filter(Boolean).join(" · ")

              return (
                <CommandItem
                  key={contact.id}
                  value={value}
                  disabled={isLinking}
                  onSelect={() => handleLink(contact.id)}
                  className="flex items-start gap-3"
                >
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium">{contact.name}</span>
                    {subline ? (
                      <span className="truncate text-xs text-muted-foreground">{subline}</span>
                    ) : null}
                    {contact.linked_customers.length > 0 ? (
                      <span className="mt-0.5 flex items-center gap-1 truncate text-xs text-brand-primary">
                        <Building2 className="size-3 shrink-0" />
                        <span className="truncate">
                          {contact.linked_customers.map((c) => c.name).join(", ")}
                        </span>
                      </span>
                    ) : null}
                  </div>
                  {isLinking ? (
                    <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
                  ) : null}
                </CommandItem>
              )
            })}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  )
}
