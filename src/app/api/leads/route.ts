import { NextRequest, NextResponse } from "next/server"

import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"
import { manualLeadSchema } from "@/lib/validations/lead"
import type { WebsiteLead, WebsiteLeadStatus } from "@/types/database"

// Staff-facing list + triage API for website leads. Website rows are created
// only by the intake endpoint at /api/leads/intake (service-role client);
// staff create manual leads via POST here (user-scoped client, so the
// source='manual' RLS INSERT policy applies).

const VALID_STATUSES: WebsiteLeadStatus[] = [
  "new",
  "contacted",
  "offer_sent",
  "won",
  "lost",
  "archived",
  "spam",
]

/** Empty string -> null, otherwise trimmed value. */
function orNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

async function requireUser() {
  const supabase = await createClient()
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser()
  if (error || !user) return null
  return user
}

export async function GET() {
  try {
    const user = await requireUser()
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const admin = createAdminClient()
    const { data, error } = await admin
      .from("website_leads")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(1000)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ leads: (data ?? []) as unknown as WebsiteLead[] })
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to load leads",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser()
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const body = await request.json().catch(() => null)
    const parsed = manualLeadSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid lead", issues: parsed.error.issues },
        { status: 400 },
      )
    }
    const input = parsed.data

    // User-scoped client so the source='manual' RLS INSERT policy applies.
    const supabase = await createClient()
    const { data, error } = await supabase
      .from("website_leads")
      .insert({
        form_name: "manual",
        source: "manual",
        name: input.contactName.trim(),
        company: input.company.trim(),
        message: orNull(input.note) ?? "",
        email: orNull(input.email),
        phone: orNull(input.phone),
        org_number: orNull(input.orgNumber),
        company_legal_form: orNull(input.companyLegalForm),
        address_street: orNull(input.addressStreet),
        address_postal_code: orNull(input.addressPostalCode),
        address_city: orNull(input.addressCity),
        contact_role: orNull(input.contactRole),
        bolagsverket_data: input.bolagsverketData ?? null,
        created_by: user.id,
        // Manual leads need no notification email — the creator already knows.
        notification_status: "skipped",
        page_path: null,
        submitted_at: new Date().toISOString(),
        recaptcha_score: null,
        notification_recipient: null,
        notification_error: null,
        idempotency_key: null,
        source_ip: null,
      } as never)
      .select("*")
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ lead: data as unknown as WebsiteLead })
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to create lead",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const user = await requireUser()
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const body = (await request.json().catch(() => null)) as {
      id?: string
      status?: string
    } | null

    if (!body?.id || !body?.status) {
      return NextResponse.json(
        { error: "id and status are required" },
        { status: 400 },
      )
    }
    if (!VALID_STATUSES.includes(body.status as WebsiteLeadStatus)) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 })
    }

    // Goes through the user-scoped client so the RLS UPDATE policy applies.
    const supabase = await createClient()
    const { error } = await supabase
      .from("website_leads")
      .update({ status: body.status as WebsiteLeadStatus } as never)
      .eq("id", body.id)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to update lead",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}
