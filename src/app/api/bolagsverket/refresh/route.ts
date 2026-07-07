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
 * Two callers:
 *   • The admin UI (signed-in admin, cookie auth) — the per-customer refresh
 *     button and the browser sweep card.
 *   • The monthly server sweep (sync-bolagsverket edge function) — authenticates
 *     with `Authorization: Bearer <CRON_SECRET>` instead of a cookie, so the
 *     same tested enrichment path drives both. The writer never overwrites the
 *     name and only flags name mismatches.
 */
export async function POST(request: NextRequest) {
  // 1. AuthN + AuthZ. Accept either a signed-in admin OR the cron secret.
  const cronSecret = process.env.CRON_SECRET?.trim()
  const isCron =
    !!cronSecret && request.headers.get("authorization") === `Bearer ${cronSecret}`

  if (!isCron) {
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
  }

  // 2. Validate input.
  const body = (await request.json().catch(() => ({}))) as { customerId?: string }
  if (!body.customerId) {
    return NextResponse.json({ error: "missing_customer" }, { status: 400 })
  }

  // Read + write with the service-role client (works for both callers; the
  // cron path has no cookie session to read through).
  const admin = createAdminClient()
  const { data: customer } = await admin
    .from("customers")
    .select("id, name, org_number")
    .eq("id", body.customerId)
    .maybeSingle()
  if (!customer) {
    return NextResponse.json({ error: "unknown_customer" }, { status: 404 })
  }

  // 3. Enrich (service-role write; authz already checked above).
  try {
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
