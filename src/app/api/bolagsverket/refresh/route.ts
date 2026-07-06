import { NextRequest, NextResponse } from "next/server"

import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { enrichCustomerFromBolagsverket } from "@/lib/bolagsverket/enrich"

export const runtime = "nodejs"

/**
 * Refresh one customer's data from Bolagsverket.
 *
 * POST { customerId: string }
 *
 * Admin-only (matches the SIE flow's gating). Reads the customer, calls the
 * enrichment writer, and returns the outcome so the UI can toast + refetch.
 * The writer never overwrites the name and only flags name mismatches.
 */
export async function POST(request: NextRequest) {
  // 1. AuthN + AuthZ — signed-in admin only.
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  }

  const { data: profileData } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle()
  const profile = profileData as { role?: string | null } | null
  if (profile?.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 })
  }

  // 2. Validate input.
  const body = (await request.json().catch(() => ({}))) as { customerId?: string }
  if (!body.customerId) {
    return NextResponse.json({ error: "missing_customer" }, { status: 400 })
  }

  const { data: customer } = await supabase
    .from("customers")
    .select("id, name, org_number")
    .eq("id", body.customerId)
    .maybeSingle()
  if (!customer) {
    return NextResponse.json({ error: "unknown_customer" }, { status: 404 })
  }

  // 3. Enrich (service-role write; authz already checked above).
  try {
    const admin = createAdminClient()
    const result = await enrichCustomerFromBolagsverket(admin, customer)
    return NextResponse.json({ ok: true, result })
  } catch (error) {
    console.error("[Bolagsverket refresh] failed:", error)
    return NextResponse.json(
      {
        error: "refresh_failed",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 502 },
    )
  }
}
