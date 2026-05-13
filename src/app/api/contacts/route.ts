import { NextResponse } from "next/server"

import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"
import type { Customer, CustomerContact } from "@/types/database"

type CustomerOption = Pick<
  Customer,
  "id" | "name" | "fortnox_customer_number" | "status"
>
type ContactLinkRow = { contact_id: string; customer_id: string; is_primary: boolean }

type ContactWithCustomers = CustomerContact & {
  primaryCustomers: CustomerOption[]
  customers: CustomerOption[]
}

const QUERY_BATCH_SIZE = 1000

async function fetchAllContacts() {
  const adminClient = createAdminClient()
  const contacts: CustomerContact[] = []

  for (let offset = 0; ; offset += QUERY_BATCH_SIZE) {
    const { data, error } = await adminClient
      .from("customer_contacts")
      .select("*")
      .order("name")
      .range(offset, offset + QUERY_BATCH_SIZE - 1)

    if (error) return { data: null, error }

    const batch = (data ?? []) as unknown as CustomerContact[]
    contacts.push(...batch)

    if (batch.length < QUERY_BATCH_SIZE) {
      return { data: contacts, error: null }
    }
  }
}

async function fetchAllCustomers() {
  const adminClient = createAdminClient()
  const customers: CustomerOption[] = []

  for (let offset = 0; ; offset += QUERY_BATCH_SIZE) {
    const { data, error } = await adminClient
      .from("customers")
      .select("id, name, fortnox_customer_number, status")
      .order("name")
      .range(offset, offset + QUERY_BATCH_SIZE - 1)

    if (error) return { data: null, error }

    const batch = (data ?? []) as unknown as CustomerOption[]
    customers.push(...batch)

    if (batch.length < QUERY_BATCH_SIZE) {
      return { data: customers, error: null }
    }
  }
}

async function fetchAllContactLinks() {
  const adminClient = createAdminClient()
  const links: ContactLinkRow[] = []

  for (let offset = 0; ; offset += QUERY_BATCH_SIZE) {
    const { data, error } = await adminClient
      .from("customer_contact_links")
      .select("contact_id, customer_id, is_primary")
      .order("contact_id")
      .order("customer_id")
      .range(offset, offset + QUERY_BATCH_SIZE - 1)

    if (error) return { data: null, error }

    const batch = (data ?? []) as ContactLinkRow[]
    links.push(...batch)

    if (batch.length < QUERY_BATCH_SIZE) {
      return { data: links, error: null }
    }
  }
}

async function authorize() {
  const supabase = await createClient()

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError || !user) return null

  // The contacts page is now open to all authenticated roles (user,
  // team_lead, admin). The previous admin-only check 403'd everyone else
  // before they could see the page. Anyone signed in passes here; the
  // page can choose to hide destructive controls based on isAdmin in
  // the UI layer.
  return user
}

export async function GET() {
  try {
    const user = await authorize()
    if (!user) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      )
    }

    const [{ data: contactRows, error: contactsError }, { data: customerRows, error: customersError }] =
      await Promise.all([fetchAllContacts(), fetchAllCustomers()])

    if (contactsError) {
      return NextResponse.json({ error: contactsError.message }, { status: 500 })
    }

    if (customersError) {
      return NextResponse.json({ error: customersError.message }, { status: 500 })
    }

    const contacts = (contactRows ?? []) as unknown as CustomerContact[]
    const customers = (customerRows ?? []) as unknown as CustomerOption[]
    const customerById = new Map(customers.map((customer) => [customer.id, customer]))
    const primaryCustomerMap = new Map<string, CustomerOption[]>()
    const customerMap = new Map<string, CustomerOption[]>()

    const { data: linkRows, error: linksError } = await fetchAllContactLinks()

    if (linksError) {
      return NextResponse.json({ error: linksError.message }, { status: 500 })
    }

    for (const row of linkRows ?? []) {
      const customer = customerById.get(row.customer_id)
      if (!customer) continue

      const targetMap = row.is_primary ? primaryCustomerMap : customerMap
      const existing = targetMap.get(row.contact_id) ?? []
      existing.push(customer)
      targetMap.set(row.contact_id, existing)
    }

    const contactsWithCustomers: ContactWithCustomers[] = contacts.map((contact) => ({
      ...contact,
      primaryCustomers: primaryCustomerMap.get(contact.id) ?? [],
      customers: customerMap.get(contact.id) ?? [],
    }))

    return NextResponse.json({ contacts: contactsWithCustomers, customers })
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to load contacts",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    )
  }
}
