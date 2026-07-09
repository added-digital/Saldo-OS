/**
 * Shared admin guard for the pricing API routes. Returns the service-role
 * client on success, or a NextResponse (401/403) the route should return.
 */

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"
import type { Profile } from "@/types/database"

export async function requireAdmin(): Promise<
  | { ok: true; admin: ReturnType<typeof createAdminClient>; userId: string }
  | { ok: false; response: NextResponse }
> {
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError || !user) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) }
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single<Pick<Profile, "role">>()

  if (profile?.role !== "admin") {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Forbidden: Admin access required" },
        { status: 403 },
      ),
    }
  }

  return { ok: true, admin: createAdminClient(), userId: user.id }
}

/**
 * Guard for any authenticated user (admin or not). Returns the service-role
 * client plus whether the caller is an admin, or a 401 response.
 */
export async function requireUser(): Promise<
  | { ok: true; admin: ReturnType<typeof createAdminClient>; userId: string; isAdmin: boolean }
  | { ok: false; response: NextResponse }
> {
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError || !user) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) }
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single<Pick<Profile, "role">>()

  return {
    ok: true,
    admin: createAdminClient(),
    userId: user.id,
    isAdmin: profile?.role === "admin",
  }
}
