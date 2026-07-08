import { NextResponse } from "next/server"
import { requireAdmin } from "@/lib/pricing/require-admin"
import { loadCustomerConfigs, upsertCustomerConfig } from "@/lib/pricing/db"

export const runtime = "nodejs"

/** GET /api/pricing/customer-config — all saved per-client overrides. */
export async function GET() {
  const guard = await requireAdmin()
  if (!guard.ok) return guard.response
  try {
    const configs = await loadCustomerConfigs(guard.admin)
    return NextResponse.json({ ok: true, configs })
  } catch (err) {
    console.error("[pricing/customer-config GET]", err)
    return NextResponse.json({ error: "Kunde inte läsa inställningar." }, { status: 500 })
  }
}

/**
 * PUT /api/pricing/customer-config — upsert one or many overrides.
 * Body: { configs: CustomerConfig[] } or a single config object.
 */
export async function PUT(request: Request) {
  const guard = await requireAdmin()
  if (!guard.ok) return guard.response

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const raw = (body as { configs?: unknown }).configs ?? body
  const list = Array.isArray(raw) ? raw : [raw]

  const configs = list
    .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
    .map((c) => ({
      orgNumber: String(c.orgNumber ?? "").trim(),
      name: (c.name as string) ?? null,
      fortnoxCustomerNumber:
        c.fortnoxCustomerNumber == null ? null : String(c.fortnoxCustomerNumber),
      discountPercent: c.discountPercent == null ? 0 : Number(c.discountPercent),
      fixedPriceFortnox:
        c.fixedPriceFortnox == null || c.fixedPriceFortnox === ""
          ? null
          : Number(c.fixedPriceFortnox),
      fixedPriceReda:
        c.fixedPriceReda == null || c.fixedPriceReda === ""
          ? null
          : Number(c.fixedPriceReda),
      fixedPriceNvr:
        c.fixedPriceNvr == null || c.fixedPriceNvr === ""
          ? null
          : Number(c.fixedPriceNvr),
      nvrStartFeeChargedAt:
        c.nvrStartFeeChargedAt == null || c.nvrStartFeeChargedAt === ""
          ? null
          : String(c.nvrStartFeeChargedAt),
      comment: (c.comment as string) ?? null,
      status: (c.status as string) ?? null,
    }))
    .filter((c) => c.orgNumber.replace(/\D/g, "").length > 0)

  if (configs.length === 0) {
    return NextResponse.json({ error: "Inga giltiga rader att spara." }, { status: 422 })
  }

  try {
    for (const cfg of configs) await upsertCustomerConfig(guard.admin, cfg)
    return NextResponse.json({ ok: true, saved: configs.length })
  } catch (err) {
    console.error("[pricing/customer-config PUT]", err)
    return NextResponse.json({ error: "Kunde inte spara inställningar." }, { status: 500 })
  }
}
