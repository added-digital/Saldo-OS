"use client"

import * as React from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { use } from "react"
import {
  ArrowLeft,
  Building2,
  Plug,
  CircleCheck,
  RotateCw,
  RefreshCw,
  AlertTriangle,
  Mail,
  Phone,
  MapPin,
  ChevronDown,
  User,
  UserPlus,
  Link2,
  Plus,
  Sparkles,
  ClipboardCheck,
  Loader2,
  Pencil,
  Trash2,
  Linkedin,
  X,
} from "lucide-react"
import { toast } from "sonner"

import { createClient } from "@/lib/supabase/client"
import { useUser } from "@/hooks/use-user"
import { useTranslation } from "@/hooks/use-translation"
import {
  EditContactDialog,
  type ContactFields,
} from "@/components/app/edit-contact-dialog"
import {
  LinkExistingContactDialog,
  type LinkableContact,
} from "@/components/app/link-contact-dialog"
import { OnboardingDot } from "@/components/app/onboarding-dot"
import type {
  Customer,
  CustomerContact,
  CustomerContactLink,
  Profile,
  Segment,
} from "@/types/database"
import { PageHeader } from "@/components/app/page-header"
import {
  CustomerBokslutSetup,
  type BokslutSetupHandle,
} from "@/components/app/customer-bokslut-setup"
import {
  useUnsavedChanges,
  useUnsavedChangesGuard,
} from "@/components/app/unsaved-changes"
import { useSidebar } from "@/components/layout/sidebar"
import { StatusBadge } from "@/components/app/status-badge"
import { UserAvatar } from "@/components/app/user-avatar"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
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
  const searchParams = useSearchParams()
  const { confirmNavigation } = useUnsavedChanges()

  // Onboarding mode: highlights the key setup steps (segments, contacts,
  // bokslut) and shows a bottom action bar. Auto-enabled when arriving from the
  // "needs onboarding" top-bar list (?onboarding=1); also toggleable manually.
  const [onboarding, setOnboarding] = React.useState(false)
  const [savingCard, setSavingCard] = React.useState(false)
  // Bokslut card reports its unsaved state here and exposes save/discard so the
  // shared card save bar can commit everything together.
  const [bokslutDirty, setBokslutDirty] = React.useState(false)
  const bokslutRef = React.useRef<BokslutSetupHandle>(null)
  // Staged (not-yet-saved) segment assignments/removals for this customer.
  const [pendingSegmentAdds, setPendingSegmentAdds] = React.useState<Segment[]>([])
  const [pendingSegmentRemoveIds, setPendingSegmentRemoveIds] = React.useState<string[]>([])
  const { collapsed } = useSidebar()

  React.useEffect(() => {
    if (searchParams.get("onboarding") === "1") setOnboarding(true)
  }, [searchParams])
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
  // "Add segment" picker on this customer card.
  const [segmentPopoverOpen, setSegmentPopoverOpen] = React.useState(false)
  const [allSegments, setAllSegments] = React.useState<Segment[]>([])
  const [segmentSearch, setSegmentSearch] = React.useState("")
  const [loading, setLoading] = React.useState(true)
  const [connectingSie, setConnectingSie] = React.useState(false)
  const [refreshingBv, setRefreshingBv] = React.useState(false)
  const [syncingCustomer, setSyncingCustomer] = React.useState(false)
  const { isAdmin } = useUser()
  const { t } = useTranslation()
  // Whether this customer has an active Fortnox SIE connection. null while
  // loading. Drives the admin-only header button: "Connect" (starts the SIE
  // OAuth flow) when not connected, "Connected" (disabled) when it is.
  const [sieConnected, setSieConnected] = React.useState<boolean | null>(null)

  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [editingContact, setEditingContact] =
    React.useState<ContactWithLink | null>(null)

  // "Link existing contact" dialog: attach a contact already in the system to
  // this customer, rather than creating a new one.
  const [linkDialogOpen, setLinkDialogOpen] = React.useState(false)
  const [linkCandidates, setLinkCandidates] = React.useState<LinkableContact[]>([])
  const [linkLoading, setLinkLoading] = React.useState(false)

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

  // Saved segments minus staged removals, plus staged additions.
  const visibleSegments = React.useMemo(() => {
    const kept = segments.filter((s) => !pendingSegmentRemoveIds.includes(s.id))
    return [...kept, ...pendingSegmentAdds]
  }, [segments, pendingSegmentAdds, pendingSegmentRemoveIds])

  const segmentsDirty =
    pendingSegmentAdds.length > 0 || pendingSegmentRemoveIds.length > 0
  const cardDirty = segmentsDirty || bokslutDirty

  // Warn on navigation while segment edits are staged (bokslut registers its own).
  useUnsavedChangesGuard(segmentsDirty, `segments:${id}`)

  function openAddDialog() {
    setEditingContact(null)
    setDialogOpen(true)
  }

  // Open the "link existing" picker and load candidate contacts — everyone in
  // the system who isn't already linked to this customer, annotated with the
  // other companies they belong to (shown as suggestions).
  async function openLinkDialog() {
    setLinkDialogOpen(true)
    setLinkLoading(true)
    setLinkCandidates([])

    const supabase = createClient()
    const { data: contactRows } = await supabase
      .from("customer_contacts")
      .select("id, name, role, email")
      .order("name")

    const rows = (contactRows ?? []) as Array<
      Pick<CustomerContact, "id" | "name" | "role" | "email">
    >
    const alreadyLinkedIds = new Set(contacts.map((c) => c.id))
    const candidateRows = rows.filter((r) => !alreadyLinkedIds.has(r.id))
    const candidateIds = candidateRows.map((r) => r.id)

    const companiesByContact = new Map<string, Array<{ id: string; name: string }>>()
    if (candidateIds.length > 0) {
      const { data: linkRows } = await supabase
        .from("customer_contact_links")
        .select("contact_id, customer:customers(id, name)")
        .in("contact_id", candidateIds)

      for (const row of (linkRows ?? []) as unknown as Array<{
        contact_id: string
        customer: { id: string; name: string } | null
      }>) {
        if (!row.customer) continue
        const existing = companiesByContact.get(row.contact_id) ?? []
        existing.push(row.customer)
        companiesByContact.set(row.contact_id, existing)
      }
    }

    setLinkCandidates(
      candidateRows.map((r) => ({
        id: r.id,
        name: r.name,
        role: r.role,
        email: r.email,
        linked_customers: companiesByContact.get(r.id) ?? [],
      })),
    )
    setLinkLoading(false)
  }

  async function handleLinkExisting(contactId: string) {
    const supabase = createClient()
    const { error } = await supabase.from("customer_contact_links").insert({
      customer_id: id,
      contact_id: contactId,
      is_primary: false,
      relationship_label: null,
    } as never)

    if (error) {
      toast.error(t("customers.detail.contactLinkFailed", "Failed to link contact"))
      throw error
    }

    toast.success(t("customers.detail.contactLinked", "Contact linked"))
    await fetchData()
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

  // Stage a segment removal (or cancel a staged add). Nothing hits the DB until
  // the shared save bar's Save.
  function stageRemoveSegment(segmentId: string) {
    if (pendingSegmentAdds.some((s) => s.id === segmentId)) {
      setPendingSegmentAdds((prev) => prev.filter((s) => s.id !== segmentId))
      return
    }
    setPendingSegmentRemoveIds((prev) =>
      prev.includes(segmentId) ? prev : [...prev, segmentId],
    )
  }

  // Stage a segment assignment (or cancel a staged removal).
  function stageAddSegment(segment: Segment) {
    setSegmentPopoverOpen(false)
    setSegmentSearch("")
    if (pendingSegmentRemoveIds.includes(segment.id)) {
      setPendingSegmentRemoveIds((prev) => prev.filter((sid) => sid !== segment.id))
      return
    }
    if (segments.some((s) => s.id === segment.id)) return
    if (pendingSegmentAdds.some((s) => s.id === segment.id)) return
    setPendingSegmentAdds((prev) => [...prev, segment])
  }

  // Create a brand-new segment (when the search matches none), then stage it.
  async function handleCreateSegment(name: string) {
    const trimmed = name.trim()
    if (!trimmed) return

    const supabase = createClient()
    const palette = [
      "#3b82f6",
      "#10b981",
      "#f59e0b",
      "#ef4444",
      "#8b5cf6",
      "#ec4899",
      "#14b8a6",
    ]
    const color = palette[Math.floor(Math.random() * palette.length)]

    const { data, error } = await supabase
      .from("segments")
      .insert({ name: trimmed, description: null, color } as never)
      .select()
      .single()

    if (error || !data) {
      toast.error(t("customers.detail.segmentCreateFailed", "Failed to create segment"))
      return
    }

    const created = data as unknown as Segment
    setAllSegments((prev) => [...prev, created])
    stageAddSegment(created)
  }

  // Commit staged segment adds/removals to the DB. Returns false on failure.
  async function commitSegments(): Promise<boolean> {
    const supabase = createClient()

    if (pendingSegmentAdds.length > 0) {
      const rows = pendingSegmentAdds.map((s) => ({
        customer_id: id,
        segment_id: s.id,
      }))
      const { error } = await supabase
        .from("customer_segments")
        .upsert(rows as never[], { onConflict: "customer_id,segment_id" })
      if (error) {
        toast.error(t("customers.detail.segmentAddFailed", "Failed to add segment"))
        return false
      }
    }

    if (pendingSegmentRemoveIds.length > 0) {
      const { error } = await supabase
        .from("customer_segments")
        .delete()
        .eq("customer_id", id)
        .in("segment_id", pendingSegmentRemoveIds)
      if (error) {
        toast.error(t("customers.detail.segmentRemoveFailed", "Failed to remove segment"))
        return false
      }
    }

    setSegments((prev) => {
      const kept = prev.filter((s) => !pendingSegmentRemoveIds.includes(s.id))
      const added = pendingSegmentAdds.filter((s) => !kept.some((k) => k.id === s.id))
      return [...kept, ...added]
    })
    setPendingSegmentAdds([])
    setPendingSegmentRemoveIds([])
    return true
  }

  // ---- Shared card save bar (bokslut + segments) --------------------------

  async function handleSaveAll() {
    setSavingCard(true)
    const ok = await commitSegments()
    if (ok && bokslutRef.current?.dirty) {
      await bokslutRef.current.save()
    }
    setSavingCard(false)
    if (ok) toast.success(t("customers.detail.changesSaved", "Changes saved"))
  }

  function handleDiscardAll() {
    setPendingSegmentAdds([])
    setPendingSegmentRemoveIds([])
    bokslutRef.current?.discard()
  }

  async function handleMarkOnboarded() {
    setSavingCard(true)
    const ok = await commitSegments()
    if (!ok) {
      setSavingCard(false)
      return
    }
    if (bokslutRef.current?.dirty) {
      await bokslutRef.current.save()
    }
    const supabase = createClient()
    const { error } = await supabase
      .from("customers")
      .update({ needs_segmentation: false } as never)
      .eq("id", id)
    setSavingCard(false)

    if (error) {
      toast.error(t("customers.onboarding.markFailed", "Failed to mark as onboarded"))
      return
    }

    window.dispatchEvent(new Event("saldo:segmentation-updated"))
    setOnboarding(false)
    toast.success(t("customers.onboarding.marked", "Marked as onboarded"))
  }

  // Load the full segment list when the picker opens, so we can offer the ones
  // not yet assigned to this customer.
  async function handleSegmentPopoverChange(open: boolean) {
    setSegmentPopoverOpen(open)
    if (!open) {
      setSegmentSearch("")
      return
    }
    const supabase = createClient()
    const { data } = await supabase.from("segments").select("*").order("name")
    setAllSegments((data ?? []) as unknown as Segment[])
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

  // Re-sync this one customer's data (details + invoices/time/contracts) from
  // Fortnox on demand. Backed by /api/fortnox/sync-customer (admin-only). If
  // Fortnox reports the customer no longer exists, the endpoint cleans it up
  // locally and we return the user to the list.
  async function handleSyncCustomer() {
    if (syncingCustomer) return
    setSyncingCustomer(true)
    try {
      const response = await fetch("/api/fortnox/sync-customer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId: id }),
      })
      const data = (await response.json().catch(() => ({}))) as {
        removed?: boolean
        error?: string
        message?: string
      }
      if (!response.ok) {
        toast.error(
          data.message ??
            data.error ??
            t("customers.detail.syncFailed", "Fortnox sync failed"),
        )
        return
      }
      if (data.removed) {
        toast.warning(
          t(
            "customers.detail.syncRemoved",
            "Customer no longer exists in Fortnox and was removed.",
          ),
        )
        router.push("/customers")
        return
      }
      toast.success(t("customers.detail.syncSuccess", "Synced from Fortnox"))
      await fetchData()
    } finally {
      setSyncingCustomer(false)
    }
  }

  async function handleRefreshBolagsverket() {
    if (refreshingBv) return
    setRefreshingBv(true)
    try {
      const response = await fetch("/api/bolagsverket/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId: id }),
      })
      const data = (await response.json().catch(() => ({}))) as {
        ok?: boolean
        result?: { status?: string; cardsMarkedRegistered?: number }
        error?: string
        message?: string
      }
      if (!response.ok || !data.ok) {
        toast.error(
          data.message ??
            data.error ??
            t("customers.detail.bvFailed", "Bolagsverket refresh failed"),
        )
        return
      }
      const status = data.result?.status
      if (status === "name_mismatch") {
        toast.warning(
          t("customers.detail.bvMismatch", "Bolagsverket found a different company — check the org number."),
        )
      } else if (status === "not_found") {
        toast.warning(
          t("customers.detail.bvNotFound", "Not found in Bolagsverket (individual, foreign, or wrong org number)."),
        )
      } else if (status === "no_orgnr") {
        toast.warning(
          t("customers.detail.bvNoOrgNr", "No org number on this customer to look up."),
        )
      } else if (status === "no_rakenskapsar") {
        toast.success(
          t("customers.detail.bvUpdatedNoReport", "Updated from Bolagsverket (no filed annual report yet)."),
        )
      } else {
        toast.success(t("customers.detail.bvUpdated", "Updated from Bolagsverket."))
      }
      // Surface any bokslut cards auto-moved to "Registrerad hos Bolagsverket".
      const marked = data.result?.cardsMarkedRegistered ?? 0
      if (marked > 0) {
        toast.success(
          t(
            "customers.detail.bvCardsRegistered",
            "{count} bokslut card(s) marked as registered with Bolagsverket.",
          ).replace("{count}", String(marked)),
        )
      }
      await fetchData()
    } finally {
      setRefreshingBv(false)
    }
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
          <span className="sr-only">{t("customers.detail.back", "Back")}</span>
        </Button>
        <PageHeader title={customer.name}>
          <StatusBadge status={customer.status} />
        </PageHeader>
        {/* Admin-only controls. Non-admins see nothing. */}
        {isAdmin && (
          <div className="ml-auto flex items-center gap-2">
            {customer.bolagsverket_name_mismatch && (
              <Badge
                variant="outline"
                className="border-semantic-warning/40 bg-semantic-warning/10 text-semantic-warning"
                title={t("customers.detail.orgMismatchTooltip", "Bolagsverket returned a different company for this org number. Verify the org number is correct.")}
              >
                <AlertTriangle className="size-3" />
                {t("customers.detail.orgMismatch", "Org number mismatch")}
              </Badge>
            )}

            {/* Re-sync this individual customer's data from Fortnox on demand. */}
            <Button
              variant="outline"
              onClick={handleSyncCustomer}
              disabled={syncingCustomer || !customer.fortnox_customer_number}
              title={t("customers.detail.syncCustomerTooltip", "Sync this customer's data from Fortnox")}
            >
              <RefreshCw className={syncingCustomer ? "size-4 animate-spin" : "size-4"} />
              {syncingCustomer
                ? t("customers.detail.syncing", "Syncing…")
                : t("customers.detail.syncCustomer", "Sync from Fortnox")}
            </Button>

            {/* Refresh this customer's org number + räkenskapsår from Bolagsverket. */}
            <Button
              variant="outline"
              onClick={handleRefreshBolagsverket}
              disabled={refreshingBv}
              title={t("customers.detail.refreshBolagsverketTooltip", "Refresh org number and räkenskapsår from Bolagsverket")}
            >
              <RotateCw className={refreshingBv ? "size-4 animate-spin" : "size-4"} />
              {refreshingBv
                ? t("customers.detail.refreshing", "Refreshing…")
                : t("customers.detail.refreshBolagsverket", "Refresh from Bolagsverket")}
            </Button>

            {sieConnected ? (
              // Already connected to Fortnox SIE → syncs automatically.
              <Button
                variant="outline"
                disabled
                title={t("customers.detail.sieConnectedTooltip", "This customer is connected to Fortnox SIE and syncs automatically.")}
              >
                <CircleCheck className="size-4 text-semantic-success" />
                {t("customers.detail.sieConnected", "SIE connected")}
              </Button>
            ) : (
              // Not connected → shortcut into the per-customer SIE OAuth flow.
              <Button
                variant="outline"
                onClick={handleConnectSie}
                disabled={connectingSie || sieConnected === null}
              >
                <Plug className="size-4" />
                {connectingSie
                  ? t("customers.detail.connecting", "Connecting…")
                  : t("customers.detail.connectSie", "Connect SIE")}
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t("customers.detail.contactInformation", "Contact Information")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {customer.contact_name && (
              <div className="flex items-center gap-3">
                <User className="size-4 text-muted-foreground" />
                <div>
                  <p className="text-xs text-muted-foreground">
                    {t("customers.detail.primaryContact", "Primary Contact")}
                  </p>
                  <p className="text-sm">{customer.contact_name}</p>
                </div>
              </div>
            )}
            {customer.org_number && (
              <div className="flex items-center gap-3">
                <Building2 className="size-4 text-muted-foreground" />
                <div>
                  <p className="text-xs text-muted-foreground">
                    {t("customers.detail.orgNumber", "Org Number")}
                  </p>
                  <p className="text-sm">{customer.org_number}</p>
                </div>
              </div>
            )}
            {customer.email && (
              <div className="flex items-center gap-3">
                <Mail className="size-4 text-muted-foreground" />
                <div>
                  <p className="text-xs text-muted-foreground">
                    {t("customers.detail.email", "Email")}
                  </p>
                  <p className="text-sm">{customer.email}</p>
                </div>
              </div>
            )}
            {customer.phone && (
              <div className="flex items-center gap-3">
                <Phone className="size-4 text-muted-foreground" />
                <div>
                  <p className="text-xs text-muted-foreground">
                    {t("customers.detail.phone", "Phone")}
                  </p>
                  <p className="text-sm">{customer.phone}</p>
                </div>
              </div>
            )}
            {(customer.address_line1 || customer.city) && (
              <div className="flex items-center gap-3">
                <MapPin className="size-4 text-muted-foreground" />
                <div>
                  <p className="text-xs text-muted-foreground">
                    {t("customers.detail.address", "Address")}
                  </p>
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
            <CardTitle className="flex items-center gap-2 text-base">
              {t("customers.detail.detailsTitle", "Details")}
              {onboarding && visibleSegments.length === 0 ? <OnboardingDot /> : null}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {accountManager ? (
              <div className="space-y-1.5">
                <p className="text-xs text-muted-foreground">
                  {t("customers.detail.accountManager", "Account Manager")}
                </p>
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
                <p className="text-xs text-muted-foreground">
                  {t("customers.detail.accountManager", "Account Manager")}
                </p>
                <p className="text-sm text-muted-foreground">
                  {t("customers.detail.unassigned", "Unassigned")}
                </p>
              </div>
            )}

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">
                  {t("customers.detail.segments", "Segments")}
                </p>
                <Popover
                  open={segmentPopoverOpen}
                  onOpenChange={handleSegmentPopoverChange}
                >
                  <PopoverTrigger asChild>
                    <Button
                      variant="ghost"
                      size="xs"
                      className="h-6 gap-1 px-1.5 text-xs text-muted-foreground"
                    >
                      <Plus className="size-3" />
                      {t("customers.detail.addSegment", "Add")}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-56 p-0">
                    <Command>
                      <CommandInput
                        value={segmentSearch}
                        onValueChange={setSegmentSearch}
                        placeholder={t("customers.detail.searchSegments", "Search segments...")}
                      />
                      <CommandList>
                        <CommandEmpty>
                          {t("customers.detail.noSegmentsFound", "No segments found.")}
                        </CommandEmpty>
                        {allSegments
                          .filter(
                            (s) => !visibleSegments.some((assigned) => assigned.id === s.id),
                          )
                          .map((segment) => (
                            <CommandItem
                              key={segment.id}
                              value={segment.name}
                              onSelect={() => stageAddSegment(segment)}
                              className="gap-2"
                            >
                              <span
                                className="size-2.5 shrink-0 rounded-full"
                                style={{ backgroundColor: segment.color }}
                              />
                              <span className="truncate">{segment.name}</span>
                            </CommandItem>
                          ))}
                        {segmentSearch.trim() &&
                        !allSegments.some(
                          (s) =>
                            s.name.trim().toLowerCase() ===
                            segmentSearch.trim().toLowerCase(),
                        ) ? (
                          <CommandItem
                            value={`__create__${segmentSearch}`}
                            onSelect={() => handleCreateSegment(segmentSearch)}
                            className="gap-2"
                          >
                            <Plus className="size-3.5 shrink-0 text-muted-foreground" />
                            <span className="truncate">
                              {t("customers.detail.createSegment", "Create")} &quot;
                              {segmentSearch.trim()}&quot;
                            </span>
                          </CommandItem>
                        ) : null}
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              </div>
              {visibleSegments.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {visibleSegments.map((segment) => (
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
                        onClick={() => stageRemoveSegment(segment.id)}
                      >
                        <X className="size-3" />
                        <span className="sr-only">
                          {t("customers.multiSelect.remove", "Remove")} {segment.name}
                        </span>
                      </button>
                    </Badge>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t("customers.detail.noSegments", "No segments")}
                </p>
              )}
            </div>

            <Separator />

            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">
                  {t("customers.detail.fortnoxNumber", "Fortnox #")}
                </span>
                <span>{customer.fortnox_customer_number ?? "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">
                  {t("customers.detail.lastSynced", "Last Synced")}
                </span>
                <span>
                  {customer.last_synced_at
                    ? formatDate(customer.last_synced_at)
                    : "Never"}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">
                  {t("customers.detail.created", "Created")}
                </span>
                <span>{formatDate(customer.created_at)}</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-base">
              {t("customers.detail.contactsTitle", "Contacts")}
              {onboarding && contacts.length === 0 ? <OnboardingDot /> : null}
            </CardTitle>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={openLinkDialog}>
                <Link2 className="size-4" />
                {t("customers.detail.linkExisting", "Link existing")}
              </Button>
              <Button variant="outline" size="sm" onClick={openAddDialog}>
                <UserPlus className="size-4" />
                {t("customers.detail.addContact", "Add Contact")}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {contacts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("customers.detail.noContacts", "No contacts added yet.")}
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
                            {t("customers.detail.primaryBadge", "Primary")}
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
                      <span className="sr-only">{t("customers.detail.editContact", "Edit")}</span>
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 text-destructive hover:text-destructive"
                      onClick={() => openDeleteDialog(contact)}
                    >
                      <Trash2 className="size-3.5" />
                      <span className="sr-only">{t("customers.detail.deleteContact", "Delete")}</span>
                    </Button>
                  </div>
                </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <CustomerBokslutSetup
        ref={bokslutRef}
        customerId={customer.id}
        highlight={onboarding}
        onDirtyChange={setBokslutDirty}
      />

      {customer.fortnox_raw && (
        <Collapsible>
          <Card>
            <CollapsibleTrigger asChild>
              <CardHeader className="cursor-pointer">
                <CardTitle className="flex items-center justify-between text-base">
                  {t("customers.detail.fortnoxRawData", "Fortnox Raw Data")}
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
            : [id]
        }
        initialCustomerIds={
          editingContact
            ? editingContact.linked_customers
                .filter((c) => !c.is_primary)
                .map((c) => c.id)
            : []
        }
        customers={allCustomers}
        onSave={handleSaveContact}
      />

      <LinkExistingContactDialog
        open={linkDialogOpen}
        onOpenChange={setLinkDialogOpen}
        contacts={linkCandidates}
        loading={linkLoading}
        onLink={handleLinkExisting}
      />

      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("customers.detail.removeContactTitle", "Remove Contact")}
            </DialogTitle>
            <DialogDescription>
              {t(
                "customers.detail.removeContactConfirmPrefix",
                "Are you sure you want to remove ",
              )}
              <span className="font-medium text-foreground">
                {deletingContact?.name}
              </span>
              {t(
                "customers.detail.removeContactConfirmSuffix",
                " from this customer? If this contact is not linked to any other customers, they will be permanently deleted.",
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => setDeleteDialogOpen(false)}
            >
              {t("customers.detail.cancel", "Cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting
                ? t("customers.detail.removing", "Removing...")
                : t("customers.detail.removeContactTitle", "Remove Contact")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Shared card save bar — collects unsaved segment + bokslut changes, and
          offers "Mark as onboarded" while in the onboarding flow. */}
      {cardDirty || onboarding ? (
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
              {cardDirty ? (
                <span className="relative flex size-2">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-semantic-warning opacity-60" />
                  <span className="relative inline-flex size-2 rounded-full bg-semantic-warning" />
                </span>
              ) : (
                <Sparkles className="size-4 text-semantic-success" />
              )}
              {cardDirty
                ? t("customers.bokslut.unsaved", "Unsaved changes")
                : t("customers.onboarding.barLabel", "Onboarding")}
            </span>
            <div className="flex items-center gap-1.5">
              {cardDirty ? (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleDiscardAll}
                    disabled={savingCard}
                  >
                    {t("customers.bokslut.discard", "Discard")}
                  </Button>
                  <Button size="sm" onClick={handleSaveAll} disabled={savingCard}>
                    {savingCard ? <Loader2 className="size-4 animate-spin" /> : null}
                    {savingCard
                      ? t("customers.bokslut.saving", "Saving…")
                      : t("customers.bokslut.save", "Save setup")}
                  </Button>
                </>
              ) : null}
              {onboarding ? (
                <Button
                  size="sm"
                  variant={cardDirty ? "outline" : "default"}
                  onClick={handleMarkOnboarded}
                  disabled={savingCard}
                >
                  <ClipboardCheck className="size-4" />
                  {t("customers.onboarding.markDone", "Mark as onboarded")}
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
