import { NextResponse } from "next/server"
import { requireAdmin } from "@/lib/pricing/require-admin"
import {
  loadCustomerConfigs,
  loadFortnoxCustomers,
  loadPriceList,
  saveCalculationResult,
} from "@/lib/pricing/db"
import { computePricing } from "@/lib/pricing/compute"
import { bufferToGrid } from "@/lib/pricing/xlsx"
import { parseKundlistaCsv, PricingParseError } from "@/lib/pricing/parsers"

export const runtime = "nodejs"
export const maxDuration = 60

/**
 * POST /api/pricing/calculate
 *
 * Admin-only. Accepts multipart form-data with three files:
 *   fortnox   — Fortnox license file (.xlsx, "Faktureringsunderlag")
 *   kundlista — Saldo client list (.csv, semicolon-separated)
 *   reda      — Reda scan file (.xlsx) [optional]
 *
 * Reads the saved price list + per-client config, runs the pricing engine and
 * returns the priced result set, reconciliation summary and diagnostics.
 */
export async function POST(request: Request) {
  const guard = await requireAdmin()
  if (!guard.ok) return guard.response
  const { admin } = guard

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 })
  }

  const fortnoxFile = form.get("fortnox")
  const kundlistaFile = form.get("kundlista")
  const redaFile = form.get("reda")
  const nvrFile = form.get("nvr")

  if (!(fortnoxFile instanceof File) || !(kundlistaFile instanceof File)) {
    return NextResponse.json(
      { error: "Fortnox-fil och kundlista krävs." },
      { status: 422 },
    )
  }

  try {
    const [fortnoxBuf, kundlistaText, redaBuf, nvrBuf] = await Promise.all([
      fortnoxFile.arrayBuffer(),
      kundlistaFile.text(),
      redaFile instanceof File ? redaFile.arrayBuffer() : Promise.resolve(null),
      nvrFile instanceof File ? nvrFile.arrayBuffer() : Promise.resolve(null),
    ])

    // Validate the CSV parses to at least one client before the heavier work.
    const kundlistaCheck = parseKundlistaCsv(kundlistaText)
    if (kundlistaCheck.length === 0) {
      return NextResponse.json(
        { error: "Kundlistan verkar tom eller har fel format (förväntar ; -separerad CSV)." },
        { status: 422 },
      )
    }

    const [priceList, customerConfigs, fortnoxCustomers] = await Promise.all([
      loadPriceList(admin),
      loadCustomerConfigs(admin),
      loadFortnoxCustomers(admin),
    ])

    const computation = computePricing({
      fortnoxGrid: bufferToGrid(fortnoxBuf),
      kundlistaCsv: kundlistaText,
      redaGrid: redaBuf ? bufferToGrid(redaBuf) : null,
      nvrGrid: nvrBuf ? bufferToGrid(nvrBuf) : null,
      priceList,
      customerConfigs,
      fortnoxCustomers,
    })

    // Persist the computed snapshot so every logged-in user can view the result
    // read-only. Best-effort: a storage failure must not fail the calculation.
    try {
      await saveCalculationResult(
        admin,
        {
          period: computation.period,
          rows: computation.rows,
          diagnostics: computation.diagnostics,
        },
        guard.userId,
      )
    } catch (persistErr) {
      console.error("[pricing/calculate] failed to persist shared result:", persistErr)
    }

    // The register is returned too so the client can re-check bill-to live as
    // the user edits a kundnr, without another round-trip.
    return NextResponse.json({ ok: true, ...computation, customerRegister: fortnoxCustomers })
  } catch (err) {
    if (err instanceof PricingParseError) {
      return NextResponse.json({ error: err.message }, { status: 422 })
    }
    console.error("[pricing/calculate]", err)
    return NextResponse.json(
      { error: "Ett fel uppstod vid beräkningen. Kontrollera filformaten." },
      { status: 500 },
    )
  }
}
