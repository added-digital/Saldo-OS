import { NextResponse } from "next/server"
import { requireAdmin, requireUser } from "@/lib/pricing/require-admin"
import { loadCalculationResult, saveCalculationResult } from "@/lib/pricing/db"
import type { StoredCalculation } from "@/lib/pricing/compute"

export const runtime = "nodejs"

/**
 * GET /api/pricing/result — the latest shared licensing result.
 * Available to any authenticated user (read-only view).
 */
export async function GET() {
  const guard = await requireUser()
  if (!guard.ok) return guard.response
  try {
    const result = await loadCalculationResult(guard.admin)
    return NextResponse.json({ ok: true, result })
  } catch (err) {
    console.error("[pricing/result GET]", err)
    return NextResponse.json({ error: "Kunde inte läsa resultatet." }, { status: 500 })
  }
}

/**
 * PUT /api/pricing/result — replace the shared snapshot (admin only). Used to
 * keep the shared view current after per-client edits, without a full recompute.
 */
export async function PUT(request: Request) {
  const guard = await requireAdmin()
  if (!guard.ok) return guard.response

  let body: Partial<StoredCalculation>
  try {
    body = (await request.json()) as Partial<StoredCalculation>
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  if (!Array.isArray(body.rows)) {
    return NextResponse.json({ error: "Inget resultat att spara." }, { status: 422 })
  }

  try {
    await saveCalculationResult(
      guard.admin,
      {
        period: body.period ?? "",
        rows: body.rows,
        diagnostics: body.diagnostics ?? ({} as StoredCalculation["diagnostics"]),
      },
      guard.userId,
    )
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error("[pricing/result PUT]", err)
    return NextResponse.json({ error: "Kunde inte spara resultatet." }, { status: 500 })
  }
}
