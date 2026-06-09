import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"
import type { Profile } from "@/types/database"

/**
 * Phase 0 "free stats" for the admin Settings > Usage tab.
 *
 * Everything here is derived from data we ALREADY have — no event tracking yet:
 *   • Active users come from Supabase Auth `last_sign_in_at` (service-role only,
 *     so this must run server-side with the admin client).
 *   • Record counts are cheap `head: true` COUNT queries on existing tables.
 *
 * Admin-gated the same way as /api/users/invite: verify the caller's profile
 * role === "admin" before doing anything with the service-role client.
 */

// Tables surfaced as "record counts". Keep this list curated — these are the
// domain objects an admin cares about, not every internal table.
const COUNT_TABLES = [
  "customers",
  "customer_contacts",
  "invoices",
  "time_reports",
  "documents",
  "teams",
] as const

const DAY_MS = 24 * 60 * 60 * 1000

export async function GET() {
  const supabase = await createClient()

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single<Pick<Profile, "role">>()

  if (profile?.role !== "admin") {
    return NextResponse.json(
      { error: "Forbidden: Admin access required" },
      { status: 403 }
    )
  }

  const admin = createAdminClient()

  // ── Active users (from Auth last_sign_in_at) ───────────────────────────────
  // listUsers is paginated; loop until we've drained every page.
  type AuthUser = {
    id: string
    email?: string
    last_sign_in_at?: string | null
    created_at: string
  }
  const authUsers: AuthUser[] = []
  let page = 1
  const perPage = 1000
  // Safety cap so a bad response can never spin forever.
  for (let i = 0; i < 50; i++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage })
    if (error) {
      return NextResponse.json(
        { error: `Failed to list users: ${error.message}` },
        { status: 500 }
      )
    }
    authUsers.push(...(data.users as unknown as AuthUser[]))
    if (data.users.length < perPage) break
    page++
  }

  // Names + active flag live on `profiles`; join to auth users by id.
  type ProfileLite = Pick<
    Profile,
    "id" | "full_name" | "email" | "role" | "is_active"
  >
  const { data: profileRows } = await admin
    .from("profiles")
    .select("id, full_name, email, role, is_active")
    .returns<ProfileLite[]>()

  const profileById = new Map<string, ProfileLite>(
    (profileRows ?? []).map((p) => [p.id, p])
  )

  const now = Date.now()
  const within = (iso: string | null | undefined, days: number) =>
    !!iso && now - new Date(iso).getTime() <= days * DAY_MS

  const activeUsers = {
    total: authUsers.length,
    daily: authUsers.filter((u) => within(u.last_sign_in_at, 1)).length,
    weekly: authUsers.filter((u) => within(u.last_sign_in_at, 7)).length,
    monthly: authUsers.filter((u) => within(u.last_sign_in_at, 30)).length,
  }

  // Per-user last-seen list, most recent first (nulls last).
  const lastSeen = authUsers
    .map((u) => {
      const p = profileById.get(u.id)
      return {
        id: u.id,
        name: (p?.full_name as string | null) ?? null,
        email: (p?.email as string | null) ?? u.email ?? null,
        role: (p?.role as string | null) ?? null,
        is_active: (p?.is_active as boolean | null) ?? null,
        last_sign_in_at: u.last_sign_in_at ?? null,
      }
    })
    .sort((a, b) => {
      const ta = a.last_sign_in_at ? new Date(a.last_sign_in_at).getTime() : 0
      const tb = b.last_sign_in_at ? new Date(b.last_sign_in_at).getTime() : 0
      return tb - ta
    })

  // New users per month (we DO have created_at for everyone, so this is a real
  // historical trend, unlike active-users which only knows the LAST sign-in).
  const signupsByMonth = new Map<string, number>()
  for (const u of authUsers) {
    const key = u.created_at.slice(0, 7) // YYYY-MM
    signupsByMonth.set(key, (signupsByMonth.get(key) ?? 0) + 1)
  }
  const newUsersByMonth = [...signupsByMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-12)
    .map(([month, count]) => ({ month, count }))

  // ── Record counts (cheap COUNT(*) head queries) ────────────────────────────
  const countResults = await Promise.all(
    COUNT_TABLES.map(async (table) => {
      const { count, error } = await admin
        .from(table)
        .select("*", { count: "exact", head: true })
      return { table, count: error ? null : (count ?? 0) }
    })
  )
  const recordCounts = Object.fromEntries(
    countResults.map((r) => [r.table, r.count])
  ) as Record<(typeof COUNT_TABLES)[number], number | null>

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    activeUsers,
    lastSeen,
    newUsersByMonth,
    recordCounts,
  })
}
