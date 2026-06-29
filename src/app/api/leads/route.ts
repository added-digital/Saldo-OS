import { NextRequest, NextResponse } from "next/server"

import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"
import type { WebsiteLead, WebsiteLeadStatus } from "@/types/database"

// Staff-facing list + triage API for website leads. Reads/updates are gated on
// an authenticated session (the intake endpoint at /api/leads/intake is the
// only writer that creates leads, and it uses the service-role client).

const VALID_STATUSES: WebsiteLeadStatus[] = [
  "new",
  "contacted",
  "archived",
  "spam",
]

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
