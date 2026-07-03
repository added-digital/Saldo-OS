"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { use } from "react"
import {
  ArrowLeft,
  Building2,
  Plug,
  CircleCheck,
  Mail,
  Phone,
  MapPin,
  ChevronDown,
  User,
  UserPlus,
  Pencil,
  Trash2,
  Linkedin,
  X,
} from "lucide-react"
import { toast } from "sonner"

import { createClient } from "@/lib/supabase/client"
import { useUser } from "@/hooks/use-user"
import {
  EditContactDialog,
  type ContactFields,
} from "@/components/app/edit-contact-dialog"
import type {
  Customer,
  CustomerContact,
  CustomerContactLink,
  Profile,
  Segment,
} from "@/types/database"
import { PageHeader } from "@/components/app/page-header"
import { CustomerBokslutSetup } from "@/components/app/customer-bokslut-setup"
import { useUnsavedChanges } from "@/components/app/unsaved-changes"
import { StatusBadge } from "@/components/app/status-badge"
import { UserAvatar } from "@/components/app/user-avatar"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Separator } from "@/components/ui/separator"
import { formatDate } from "@/lib/utils"

type ContactWithLink = CustomerContact & {
  link_id: string
  linked_customers: Array<
    Pick<Customer, "id" | "name" | "fortnox_customer_number"> & {
      is_primary: boolean
    }
  >
}

export default function CustomerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = use(params)
  const router = useRouter()
  const { confirmNavigation } = useUnsavedChanges()
  const [customer, setCustomer] = React.useState<Customer | null>(null)
  const [accountManager, setAccountManager] = React.useState<Profile | null>(
    null,
  )
  const [contacts, setContacts] = React.useState<ContactWithLink[]>([])
  const [allCustomers, setAllCustomers] = React.useState<
    Pick<Customer, "id" | "name" | "fortnox_customer_number">[]
  >([])
  const [existingPrimaryByCustomerId, setExistingPrimaryByCustomerId] = React.useState<
    Record<string, { customerName: string; contactId: string; contactName: string }>
  >({})
  const [segments, setSegments] = React.useState<Segment[]>([])
  const [loading, setLoading] = React.useState(true)
  const [connectingSie, setConnectingSie] = React.useState(false)
  const { isAdmin } = useUser()
  // Whether this customer has an active Fortnox SIE connection. null while
  // loading. Drives the admin-only header button: "Connect" (starts the SIE
  // OAuth flow) when not connected, "Connected" (disabled) when it is.
  const [sieConnected, setSieConnected] = React.useState<boolean | null>(null)

  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [editingContact, setEditingContact] =
    React.useState<ContactWithLink | null>(null)

  const [deleteDialogOpen, setDeleteDialogOpen] = React.useState(false)
  const [deletingContact, setDeletingContact] =
    React.useState<ContactWithLink | null>(null)
  const [deleting, setDeleting] = React.useState(false)

  async function fetchData() {
    const supabase = createClient()

    const { data: customerData } = await supabase
      .from("customers")
      .select("*")
      .eq("id", id)
      .single()

    const c = customerData as unknown as Customer | null
    setCustomer(c)

    // Active SIE connection? Drives the "Sync Customer" vs "Connected" button.
    const { count: sieCount } = await supabase
      .from("sie_connections")
      .select("id", { count: "exact", head: true })
      .eq("customer_id", id)
      .eq("connection_status", "active")
    setSieConnected((sieCount ?? 0) > 0)

    if (c?.fortnox_cost_center) {
      const { data: managerData } = await supabase
        .from("profiles")
        .select("*")
        .eq("fortnox_cost_center", c.fortnox_cost_center)
        .eq("is_active", true)
        .single()

      setAccountManager(managerData as unknown as Profile | null)
    }

    const { data: linkRows } = await supabase
      .from("customer_contact_links")
      .select("id, contact_id, contact:customer_contacts(*)")
      .eq("customer_id", id)

    const rawLinks = (linkRows ?? []) as unknown as {
      id: string
      contact_id: string
      contact: CustomerContact
    }[]

    const contactIds = rawLinks.map((link) => link.contact_id)
    const linkedCustomersByContactId = new Map<
      string,
      Array<
        Pick<Customer, "id" | "name" | "fortnox_customer_number"> & {
          is_primary: boolean
        }
      >
    >()

    if (contactIds.length > 0) {
      const { data: allLinkRows } = await supabase
        .from("customer_contact_links")
        .select("contact_id, is_primary, customer:customers(id, name, fortnox_customer_number)")
        .in("contact_id", contactIds)

      for (const row of (allLinkRows ?? []) as unknown as Array<{
        contact_id: string
        is_primary: boolean
        customer: Pick<Customer, "id" | "name" | "fortnox_customer_number"> | null
      }>) {
        if (!row.customer) continue
        const existing = linkedCustomersByContactId.get(row.contact_id) ?? []
        existing.push({
          ...row.customer,
          is_primary: row.is_primary,
        })
        linkedCustomersByContactId.set(row.contact_id, existing)
      }
    }

    setContacts(
      rawLinks.map((link) => ({
        ...link.contact,
        link_id: link.id,
        linked_customers: linkedCustomersByContactId.get(link.contact_id) ?? [],
      })),
    )

    const { data: customerOptions } = await supabase
      .from("customers")
      .select("id, name, fortnox_customer_number")
      .eq("status", "active")
      .order("name")

    const customerOptionRows = (customerOptions ?? []) as unknown as Pick<
      Customer,
      "id" | "name" | "fortnox_customer_number"
    >[]
    setAllCustomers(customerOptionRows)

    const selectableCustomerIds = customerOptionRows.map((row) => row.id)
    const customerNameById = new Map(
      customerOptionRows.map((row) => [row.id, row.name]),
    )
    const primaryMap: Record<
      string,
      { customerName: string; contactId: string; contactName: string }
    > = {}

    if (selectableCustomerIds.length > 0) {
      const { data: primaryRows } = await supabase
        .from("customer_contact_links")
        .select("customer_id, contact_id, contact:customer_contacts(name)")
        .in("customer_id", selectableCustomerIds)
        .eq("is_primary", true)
        .order("created_at", { ascending: false })

      for (const row of (primaryRows ?? []) as unknown as Array<{
        customer_id: string
        contact_id: string
        contact: Pick<CustomerContact, "name"> | null
      }>) {
        if (primaryMap[row.customer_id]) continue
        primaryMap[row.customer_id] = {
          customerName: customerNameById.get(row.customer_id) ?? "Customer",
          contactId: row.contact_id,
          contactName: row.contact?.name ?? "Unknown contact",
        }
      }
    }

    setExistingPrimaryByCustomerId(primaryMap)

    const { data: csRows } = await supabase
      .from("customer_segments")
      .select("segment:segments(*)")
      .eq("customer_id", id)

    const rawSegments = (csRows ?? []) as unknown as { segment: Segment }[]
    setSegments(rawSegments.map((r) => r.segment))

    setLoading(false)
  }

  React.useEffect(() => {
    fetchData()
  }, [id])

  const sortedContacts = React.useMemo(() => {
    return [...contacts].sort((a, b) => {
      const aIsPrimary = a.linked_customers.some(
        (linkedCustomer) => linkedCustomer.id === id && linkedCustomer.is_primary,
      )
      const bIsPrimary = b.linked_customers.some(
        (linkedCustomer) => linkedCustomer.id === id && linkedCustomer.is_primary,
      )

      if (aIsPrimary !== bIsPrimary) {
        return aIsPrimary ? -1 : 1
      }

      return a.name.localeCompare(b.name)
    })
  }, [contacts, id])

  function openAddDialog() {
    setEditingContact(null)
    setDialogOpen(true)
  }

  function openEditDialog(contact: ContactWithLink) {
    setEditingContact(contact)
    setDialogOpen(true)
  }

  function openDeleteDialog(contact: ContactWithLink) {
    setDeletingContact(contact)
    setDeleteDialogOpen(true)
  }

  async function syncPrimaryFields(customerIds: string[]) {
    const uniqueCustomerIds = Array.from(new Set(customerIds))
    if (uniqueCustomerIds.length === 0) return

    const response = await fetch("/api/contacts/primary-sync", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ customerIds: uniqueCustomerIds }),
    })

    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as {
        error?: string
      } | null
      toast.error(payload?.error ?? "Failed to sync primary contact fields to Fortnox")
    }
  }

  async function handleSaveContact(
    payload: ContactFields & {
      primaryCustomerIds: string[]
      customerIds: string[]
    },
  ) {
    const supabase = createClient()
    const uniquePrimaryIds = Array.from(new Set(payload.primaryCustomerIds))
    const uniqueRegularIds = Array.from(
      new Set(payload.customerIds.filter((customerId) => !uniquePrimaryIds.includes(customerId))),
    )

    async function removeConflictingPrimaryContacts(contactId: string) {
      if (uniquePrimaryIds.length === 0) return

      const { data: conflictingRows, error: conflictingError } = await supabase
        .from("customer_contact_links")
        .select("id, contact_id")
        .in("customer_id", uniquePrimaryIds)
        .eq("is_primary", true)
        .neq("contact_id", contactId)

      if (conflictingError) {
        toast.error("Failed to validate primary contacts")
        throw conflictingError
      }

      const conflicts = (conflictingRows ?? []) as Array<{ id: string; contact_id: string }>
      const conflictingLinkIds = conflicts.map((row) => row.id)
      const conflictingContactIds = Array.from(
        new Set(conflicts.map((row) => row.contact_id)),
      )

      if (conflictingLinkIds.length > 0) {
        const { error: removeConflictingError } = await supabase
          .from("customer_contact_links")
          .delete()
          .in("id", conflictingLinkIds)

        if (removeConflictingError) {
          toast.error("Failed to replace existing primary contacts")
          throw removeConflictingError
        }
      }

      for (const conflictingContactId of conflictingContactIds) {
        const { count, error: countError } = await supabase
          .from("customer_contact_links")
          .select("id", { count: "exact", head: true })
          .eq("contact_id", conflictingContactId)

        if (countError) {
          toast.error("Failed to validate replaced contacts")
          throw countError
        }

        if ((count ?? 0) === 0) {
          const { error: deleteContactError } = await supabase
            .from("customer_contacts")
            .delete()
            .eq("id", conflictingContactId)

          if (deleteContactError) {
            toast.error("Failed to clean up replaced primary contact")
            throw deleteContactError
          }
        }
      }
    }

    const contactPayload = {
      name: payload.name,
      first_name: payload.firstName,
      last_name: payload.lastName,
      role: payload.role,
      email: payload.email,
      phone: payload.phone,
      linkedin: payload.linkedin,
      notes: payload.notes,
    }

    if (editingContact) {
      const { error: updateError } = await supabase
        .from("customer_contacts")
        .update(contactPayload as never)
        .eq("id", editingContact.id)

      if (updateError) {
        toast.error("Failed to update contact")
        throw updateError
      }

      const existingPrimaryIds = new Set(
        editingContact.linked_customers
          .filter((customer) => customer.is_primary)
          .map((customer) => customer.id),
      )
      const existingRegularIds = new Set(
        editingContact.linked_customers
          .filter((customer) => !customer.is_primary)
          .map((customer) => customer.id),
      )
      const allExistingIds = new Set([...existingPrimaryIds, ...existingRegularIds])

      const newPrimarySet = new Set(uniquePrimaryIds)
      const newRegularSet = new Set(uniqueRegularIds)
      const removedPrimaryIds = [...existingPrimaryIds].filter(
        (customerId) => !newPrimarySet.has(customerId),
      )
      const allNewIds = new Set([...newPrimarySet, ...newRegularSet])

      const idsToRemove = [...allExistingIds].filter(
        (existingId) => !allNewIds.has(existingId),
      )

      if (idsToRemove.length > 0) {
        const { error: removeError } = await supabase
          .from("customer_contact_links")
          .delete()
          .eq("contact_id", editingContact.id)
          .in("customer_id", idsToRemove)

        if (removeError) {
          toast.error("Failed to remove customer relations")
          throw removeError
        }
      }

      const primaryToInsert = uniquePrimaryIds.filter(
        (cid) => !allExistingIds.has(cid),
      )
      const regularToInsert = uniqueRegularIds.filter(
        (cid) => !allExistingIds.has(cid),
      )

      const insertRows = [
        ...primaryToInsert.map((customerId) => ({
          customer_id: customerId,
          contact_id: editingContact.id,
          is_primary: true,
          relationship_label: null,
        })),
        ...regularToInsert.map((customerId) => ({
          customer_id: customerId,
          contact_id: editingContact.id,
          is_primary: false,
          relationship_label: null,
        })),
      ]

      if (insertRows.length > 0) {
        const { error: insertError } = await supabase
          .from("customer_contact_links")
          .insert(insertRows as never)

        if (insertError) {
          toast.error("Failed to add customer relations")
          throw insertError
        }
      }

      const upgradeToPrimary = uniquePrimaryIds.filter(
        (cid) => existingRegularIds.has(cid),
      )
      const downgradeToRegular = uniqueRegularIds.filter(
        (cid) => existingPrimaryIds.has(cid),
      )

      for (const customerId of upgradeToPrimary) {
        const { error } = await supabase
          .from("customer_contact_links")
          .update({ is_primary: true } as never)
          .eq("contact_id", editingContact.id)
          .eq("customer_id", customerId)

        if (error) {
          toast.error("Failed to update primary status")
          throw error
        }
      }

      for (const customerId of downgradeToRegular) {
        const { error } = await supabase
          .from("customer_contact_links")
          .update({ is_primary: false } as never)
          .eq("contact_id", editingContact.id)
          .eq("customer_id", customerId)

        if (error) {
          toast.error("Failed to update primary status")
          throw error
        }
      }

      await removeConflictingPrimaryContacts(editingContact.id)

      await syncPrimaryFields([...uniquePrimaryIds, ...removedPrimaryIds])

      toast.success("Contact updated")
    } else {
      const { data: newContact, error: insertError } = await supabase
        .from("customer_contacts")
        .insert(contactPayload as never)
        .select("id")
        .single()

      if (insertError || !newContact) {
        toast.error("Failed to create contact")
        throw insertError ?? new Error("No contact returned")
      }

      const inserted = newContact as unknown as { id: string }

      const primaryRows = uniquePrimaryIds.map(
        (customerId) => ({
          customer_id: customerId,
          contact_id: inserted.id,
          is_primary: true,
          relationship_label: null,
        }),
      )
      const regularRows = uniqueRegularIds
        .map((customerId) => ({
          customer_id: customerId,
          contact_id: inserted.id,
          is_primary: false,
          relationship_label: null,
        }))

      const relationRows = [...primaryRows, ...regularRows]

      if (relationRows.length > 0) {
        const { error: linkError } = await supabase
          .from("customer_contact_links")
          .insert(relationRows as never)

        if (linkError) {
          toast.error("Failed to link contact")
          throw linkError
        }
      }

      await removeConflictingPrimaryContacts(inserted.id)

      await syncPrimaryFields(uniquePrimaryIds)

      toast.success("Contact added")
    }

    await fetchData()
  }

  async function handleDelete() {
    if (!deletingContact) return
    setDeleting(true)
    const supabase = createClient()

    const { error: unlinkError } = await supabase
      .from("customer_contact_links")
      .delete()
      .eq("id", deletingContact.link_id)

    if (unlinkError) {
      toast.error("Failed to remove contact")
      setDeleting(false)
      return
    }

    const { count } = await supabase
      .from("customer_contact_links")
      .select("id", { count: "exact", head: true })
      .eq("contact_id", deletingContact.id)

    if (count === 0) {
      await supabase
        .from("customer_contacts")
        .delete()
        .eq("id", deletingContact.id)
    }

    toast.success("Contact removed")
    setDeleting(false)
    setDeleteDialogOpen(false)
    fetchData()
  }

  async function handleRemoveSegment(segmentId: string) {
    const supabase = createClient()

    const { error } = await supabase
      .from("customer_segments")
      .delete()
      .eq("customer_id", id)
      .eq("segment_id", segmentId)

    if (error) {
      toast.error("Failed to remove segment")
      return
    }

    setSegments((prev) => prev.filter((s) => s.id !== segmentId))
    toast.success("Segment removed")
  }

  function handleConnectSie() {
    // Shortcut into the SIE settings page with this customer pre-searched, so
    // the admin lands with the row already filtered in and can hit Connect.
    // Prefer the Fortnox customer number (unique); fall back to the name.
    setConnectingSie(true)
    const term = customer?.fortnox_customer_number ?? customer?.name ?? ""
    window.location.assign(
      `/settings/sie?search=${encodeURIComponent(term)}`,
    )
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-48 animate-pulse rounded bg-muted" />
        <div className="h-64 animate-pulse rounded-lg border bg-muted" />
      </div>
    )
  }

  if (!customer) {
    return (
      <div className="space-y-6">
        <PageHeader title="Customer not found" />
        <Button variant="outline" onClick={() => router.push("/customers")}>
          <ArrowLeft className="size-4" />
          Back to customers
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => confirmNavigation(() => router.push("/customers"))}
        >
          <ArrowLeft className="size-4" />
          <span className="sr-only">Back</span>
        </Button>
        <PageHeader title={customer.name}>
          <StatusBadge status={customer.status} />
        </PageHeader>
        {/* Admin-only Fortnox SIE connection control. Non-admins see nothing. */}
        {isAdmin && (
          <div className="ml-auto">
            {sieConnected ? (
              // Already connected to Fortnox SIE → syncs automatically.
              <Button
                variant="outline"
                disabled
                title="This customer is connected to Fortnox SIE and syncs automatically."
              >
                <CircleCheck className="size-4 text-semantic-success" />
                Connected
              </Button>
            ) : (
              // Not connected → shortcut into the per-customer SIE OAuth flow.
              <Button
                variant="outline"
                onClick={handleConnectSie}
                disabled={connectingSie || sieConnected === null}
              >
                <Plug className="size-4" />
                {connectingSie ? "Connecting..." : "Connect SIE"}
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Contact Information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {customer.contact_name && (
              <div className="flex items-center gap-3">
                <User className="size-4 text-muted-foreground" />
                <div>
                  <p className="text-xs text-muted-foreground">
                    Primary Contact
                  </p>
                  <p className="text-sm">{customer.contact_name}</p>
                </div>
              </div>
            )}
            {customer.org_number && (
              <div className="flex items-center gap-3">
                <Building2 className="size-4 text-muted-foreground" />
                <div>
                  <p className="text-xs text-muted-foreground">Org Number</p>
                  <p className="text-sm">{customer.org_number}</p>
                </div>
              </div>
            )}
            {customer.email && (
              <div className="flex items-center gap-3">
                <Mail className="size-4 text-muted-foreground" />
                <div>
                  <p className="text-xs text-muted-foreground">Email</p>
                  <p className="text-sm">{customer.email}</p>
                </div>
              </div>
            )}
            {customer.phone && (
              <div className="flex items-center gap-3">
                <Phone className="size-4 text-muted-foreground" />
                <div>
                  <p className="text-xs text-muted-foreground">Phone</p>
                  <p className="text-sm">{customer.phone}</p>
                </div>
              </div>
            )}
            {(customer.address_line1 || customer.city) && (
              <div className="flex items-center gap-3">
                <MapPin className="size-4 text-muted-foreground" />
                <div>
                  <p className="text-xs text-muted-foreground">Address</p>
                  <p className="text-sm">
                    {[
                      customer.address_line1,
                      customer.address_line2,
                      [customer.zip_code, customer.city]
                        .filter(Boolean)
                        .join(" "),
                      customer.country !== "SE" ? customer.country : null,
                    ]
                      .filter(Boolean)
                      .join(", ")}
                  </p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {accountManager ? (
              <div className="space-y-1.5">
                <p className="text-xs text-muted-foreground">Account Manager</p>
                <div className="flex items-center gap-3 rounded-md border p-3">
                  <UserAvatar
                    name={accountManager.full_name}
                    avatarUrl={accountManager.avatar_url}
                    size="sm"
                  />
                  <div>
                    <p className="text-sm font-medium">
                      {accountManager.full_name}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {accountManager.email}
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-1.5">
                <p className="text-xs text-muted-foreground">Account Manager</p>
                <p className="text-sm text-muted-foreground">Unassigned</p>
              </div>
            )}

            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground">Segments</p>
              {segments.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {segments.map((segment) => (
                    <Badge
                      key={segment.id}
                      variant="outline"
                      className="gap-1 pr-1 text-xs font-normal"
                      style={{
                        borderColor: segment.color,
                        color: segment.color,
                      }}
                    >
                      {segment.name}
                      <button
                        type="button"
                        className="ml-0.5 rounded-sm p-0.5 opacity-60 transition-opacity hover:opacity-100"
                        onClick={() => handleRemoveSegment(segment.id)}
                      >
                        <X className="size-3" />
                        <span className="sr-only">Remove {segment.name}</span>
                      </button>
                    </Badge>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No segments</p>
              )}
            </div>

            <Separator />

            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Fortnox #</span>
                <span>{customer.fortnox_customer_number ?? "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Last Synced</span>
                <span>
                  {customer.last_synced_at
                    ? formatDate(customer.last_synced_at)
                    : "Never"}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Created</span>
                <span>{formatDate(customer.created_at)}</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Contacts</CardTitle>
            <Button variant="outline" size="sm" onClick={openAddDialog}>
              <UserPlus className="size-4" />
              Add Contact
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {contacts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No contacts added yet.
            </p>
          ) : (
            <div className="space-y-3">
              {sortedContacts.map((contact) => {
                const isPrimaryForCurrentCustomer = contact.linked_customers.some(
                  (linkedCustomer) => linkedCustomer.id === id && linkedCustomer.is_primary,
                )

                return (
                <div
                  key={contact.link_id}
                  className="flex items-start justify-between rounded-md border p-3"
                >
                  <div className="flex items-start gap-3">
                    <div className="flex size-8 items-center justify-center rounded-full bg-muted">
                      <User className="size-4 text-muted-foreground" />
                    </div>
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium">{contact.name}</p>
                        {isPrimaryForCurrentCustomer ? (
                          <Badge variant="secondary" className="text-[11px] font-medium">
                            Primary
                          </Badge>
                        ) : null}
                      </div>
                      {contact.role && (
                        <p className="text-xs text-muted-foreground">
                          {contact.role}
                        </p>
                      )}
                      <div className="flex flex-wrap items-center gap-3 pt-1">
                        {contact.email && (
                          <a
                            href={`mailto:${contact.email}`}
                            className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                          >
                            <Mail className="size-3" />
                            {contact.email}
                          </a>
                        )}
                        {contact.phone && (
                          <a
                            href={`tel:${contact.phone}`}
                            className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                          >
                            <Phone className="size-3" />
                            {contact.phone}
                          </a>
                        )}
                        {contact.linkedin && (
                          <a
                            href={contact.linkedin}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                          >
                            <Linkedin className="size-3" />
                            LinkedIn
                          </a>
                        )}
                      </div>
                      {contact.notes && (
                        <p className="pt-1 text-xs text-muted-foreground">
                          {contact.notes}
                        </p>
                      )}
                      {contact.linked_customers.length > 1 && (
                        <div className="flex flex-wrap gap-1.5 pt-2">
                          {contact.linked_customers.map((linkedCustomer) => (
                            <Badge key={linkedCustomer.id} variant="outline" className="font-normal">
                              {linkedCustomer.name}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      onClick={() => openEditDialog(contact)}
                    >
                      <Pencil className="size-3.5" />
                      <span className="sr-only">Edit</span>
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 text-destructive hover:text-destructive"
                      onClick={() => openDeleteDialog(contact)}
                    >
                      <Trash2 className="size-3.5" />
                      <span className="sr-only">Delete</span>
                    </Button>
                  </div>
                </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <CustomerBokslutSetup customerId={customer.id} />

      {customer.fortnox_raw && (
        <Collapsible>
          <Card>
            <CollapsibleTrigger asChild>
              <CardHeader className="cursor-pointer">
                <CardTitle className="flex items-center justify-between text-base">
                  Fortnox Raw Data
                  <ChevronDown className="size-4 text-muted-foreground transition-transform [[data-state=open]_&]:rotate-180" />
                </CardTitle>
              </CardHeader>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <CardContent>
                <pre className="max-h-96 overflow-auto rounded-md bg-muted p-4 text-xs">
                  {JSON.stringify(customer.fortnox_raw, null, 2)}
                </pre>
              </CardContent>
            </CollapsibleContent>
          </Card>
        </Collapsible>
      )}

      <EditContactDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        contact={editingContact}
        existingPrimaryByCustomerId={existingPrimaryByCustomerId}
        initialPrimaryCustomerIds={
          editingContact
            ? editingContact.linked_customers
                .filter((c) => c.is_primary)
                .map((c) => c.id)
            : []
        }
        initialCustomerIds={
          editingContact
            ? editingContact.linked_customers
                .filter((c) => !c.is_primary)
                .map((c) => c.id)
            : [id]
        }
        customers={allCustomers}
        onSave={handleSaveContact}
      />

      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove Contact</DialogTitle>
            <DialogDescription>
              Are you sure you want to remove{" "}
              <span className="font-medium text-foreground">
                {deletingContact?.name}
              </span>{" "}
              from this customer? If this contact is not linked to any other
              customers, they will be permanently deleted.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => setDeleteDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting ? "Removing..." : "Remove Contact"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
