import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"
import type { Profile } from "@/types/database"

/**
 * Stats for the admin Settings > Usage tab, all derived from data we already
 * have — no event tracking of our own:
 *   • Activity recency comes from `auth.sessions` via admin_user_activity()
 *     (migration 00107). A session's updated_at moves as the session is used,
 *     which is what "active" means. `last_sign_in_at` is kept alongside it but
 *     only ever reported as what it is — the last full re-authentication. It
 *     does NOT move on a silent token refresh, so using it to count active
 *     users under-counted the real number several times over.
 *   • Record counts are cheap `head: true` COUNT queries on existing tables.
 *
 * Admin-gated the same way as /api/users/invite: verify the caller's profile
 * role === "admin" before doing anything with the service-role client.
 */

// Session recency is the live number on the page — never serve a cached copy.
export const dynamic = "force-dynamic"

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

  // ── Real activity recency (auth.sessions, via migration 00107) ─────────────
  type ActivityRow = {
    user_id: string
    last_active_at: string | null
    active_sessions: number
  }
  const { data: activityRows, error: activityError } = await admin.rpc(
    "admin_user_activity" as never
  )
  // A missing/failed function must not blank the page: fall back to sign-in
  // recency and say so, rather than silently reporting zeroes as if nobody
  // had used the app.
  const activityById = new Map<string, ActivityRow>(
    ((activityRows ?? []) as unknown as ActivityRow[]).map((r) => [r.user_id, r])
  )
  const activitySource: "sessions" | "sign_in" = activityError ? "sign_in" : "sessions"

  const now = Date.now()
  const within = (iso: string | null | undefined, days: number) =>
    !!iso && now - new Date(iso).getTime() <= days * DAY_MS

  /**
   * The most recent trace of a user, whichever source saw them last. Sessions
   * are the real signal, but they are pruned on sign-out and expiry — so for
   * someone who signed in and then logged out, the sign-in is the newer (and
   * only) evidence. Taking the max keeps both cases right.
   */
  const lastActiveOf = (u: AuthUser): string | null => {
    const session = activityById.get(u.id)?.last_active_at ?? null
    const signIn = u.last_sign_in_at ?? null
    if (!session) return signIn
    if (!signIn) return session
    return new Date(session) > new Date(signIn) ? session : signIn
  }

  // "Total" is the seats in use: profiles that are still enabled. Counting every
  // auth row inflated it with invitees who never signed in and with people whose
  // profile has since been deactivated.
  const enabledUsers = authUsers.filter(
    (u) => profileById.get(u.id)?.is_active !== false
  )

  const activeUsers = {
    total: enabledUsers.length,
    daily: enabledUsers.filter((u) => within(lastActiveOf(u), 1)).length,
    weekly: enabledUsers.filter((u) => within(lastActiveOf(u), 7)).length,
    monthly: enabledUsers.filter((u) => within(lastActiveOf(u), 30)).length,
    /** Invited but never authenticated once — nothing to do with activity. */
    neverSignedIn: enabledUsers.filter((u) => !u.last_sign_in_at).length,
  }

  // Per-user list, most recently active first (nulls last). Both timestamps are
  // reported so the table can label them honestly.
  const lastSeen = authUsers
    .map((u) => {
      const p = profileById.get(u.id)
      return {
        id: u.id,
        name: (p?.full_name as string | null) ?? null,
        email: (p?.email as string | null) ?? u.email ?? null,
        role: (p?.role as string | null) ?? null,
        is_active: (p?.is_active as boolean | null) ?? null,
        last_active_at: lastActiveOf(u),
        last_sign_in_at: u.last_sign_in_at ?? null,
      }
    })
    .sort((a, b) => {
      const ta = a.last_active_at ? new Date(a.last_active_at).getTime() : 0
      const tb = b.last_active_at ? new Date(b.last_active_at).getTime() : 0
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
    /** Which signal the activity numbers came from, so the UI can qualify them. */
    activitySource,
    activeUsers,
    lastSeen,
    newUsersByMonth,
    recordCounts,
  })
}
