import { NextResponse } from "next/server"

import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"

export const runtime = "nodejs"

/**
 * Kick off the full Bolagsverket sweep on demand — the SAME server job that runs
 * monthly, just triggered manually. Enriches every active customer in the
 * background (chunked, unattended); the caller doesn't wait or keep a tab open.
 *
 * Admin-only. Calls enqueue_bolagsverket_sync(), which is idempotent — if a
 * sweep is already pending/processing it does nothing, so double-clicks are safe.
 */
export async function POST() {
  // Admin gate (cookie session).
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

  // Enqueue via the SECURITY DEFINER function (service-role client).
  const admin = createAdminClient()
  const { error } = await admin.rpc("enqueue_bolagsverket_sync")
  if (error) {
    return NextResponse.json(
      { error: "enqueue_failed", message: error.message },
      { status: 500 },
    )
  }
  return NextResponse.json({ ok: true })
}
