import { NextRequest, NextResponse } from "next/server"

import { getBolagsverketClient, normalizeOrgNumber } from "@/lib/bolagsverket"
import { createClient } from "@/lib/supabase/server"

// Staff-facing org.nr lookup for the "Add lead" form. Takes an org number,
// returns the Bolagsverket company snapshot (name, legal form, address) so the
// form can autofill. The HVD API cannot search by name — org.nr only.

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const raw = request.nextUrl.searchParams.get("orgNumber") ?? ""
    const org = normalizeOrgNumber(raw)
    if (org.length !== 10 && org.length !== 12) {
      return NextResponse.json(
        { error: "orgNumber must be 10 (or 12) digits" },
        { status: 400 },
      )
    }

    const client = getBolagsverketClient()
    const result = await client.lookupByOrgNumber(org)

    if (!result.ok) {
      return NextResponse.json({ ok: false, reason: "not_found" })
    }

    const { company } = result
    return NextResponse.json({
      ok: true,
      company: {
        orgNumber: company.orgNumber,
        name: company.name,
        legalForm: company.legalForm,
        status: company.status,
        address: company.address,
        raw: company.raw,
      },
    })
  } catch (error) {
    return NextResponse.json(
      {
        error: "Lookup failed",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}
