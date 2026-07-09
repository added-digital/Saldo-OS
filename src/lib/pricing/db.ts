/**
 * Server-side helpers to load the pricing feature's reference data from
 * Supabase (price list + saved per-client config) using the admin client.
 * Callers must already have verified the caller is an admin.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/types/database"
import type { PriceListEntry } from "./price-list"
import type { CustomerConfig, FortnoxCustomerRef, StoredCalculation } from "./compute"

type Admin = SupabaseClient<Database>

type PriceRow = {
  article_number: string
  product_name: string | null
  monthly_price: number | null
}
type ConfigRow = {
  org_number: string
  name: string | null
  fortnox_customer_number: string | null
  discount_percent: number | null
  fixed_price_fortnox: number | null
  fixed_price_reda: number | null
  fixed_price_nvr: number | null
  nvr_start_fee_charged_at: string | null
  comment: string | null
  status: string | null
}

/** Load the editable Fortnox price list. Empty array falls back to the code constant. */
export async function loadPriceList(admin: Admin): Promise<PriceListEntry[]> {
  const { data, error } = await admin
    .from("license_price_list")
    .select("article_number, product_name, monthly_price")
    .returns<PriceRow[]>()
  if (error) throw error
  return (data ?? []).map((r) => ({
    articleNo: String(r.article_number),
    name: r.product_name ?? "",
    price: Number(r.monthly_price ?? 0),
  }))
}

/** Load every saved per-client override. */
export async function loadCustomerConfigs(admin: Admin): Promise<CustomerConfig[]> {
  const { data, error } = await admin
    .from("license_customer_config")
    .select(
      "org_number, name, fortnox_customer_number, discount_percent, fixed_price_fortnox, fixed_price_reda, fixed_price_nvr, nvr_start_fee_charged_at, comment, status",
    )
    .returns<ConfigRow[]>()
  if (error) throw error
  return (data ?? []).map((r) => ({
    orgNumber: String(r.org_number),
    fortnoxCustomerNumber: r.fortnox_customer_number,
    discountPercent: r.discount_percent == null ? 0 : Number(r.discount_percent),
    fixedPriceFortnox: r.fixed_price_fortnox == null ? null : Number(r.fixed_price_fortnox),
    fixedPriceReda: r.fixed_price_reda == null ? null : Number(r.fixed_price_reda),
    fixedPriceNvr: r.fixed_price_nvr == null ? null : Number(r.fixed_price_nvr),
    nvrStartFeeChargedAt: r.nvr_start_fee_charged_at,
    comment: r.comment,
    status: r.status,
  }))
}

/**
 * Load the Fortnox customer register (customer number → company) used to check
 * whether a row's kundnr invoices a different company than the row's own.
 *
 * The `customers` table is the primary source, but its `fortnox_customer_number`
 * is only filled for customers synced through the Fortnox customer API — many
 * clients imported via SIE/other flows have the company (and org number) but no
 * number, so a number-only lookup misses them. We therefore also bridge through
 * `invoices`: every invoice carries the real Fortnox customer number and links
 * to the customer (→ org number), which covers customers that have been billed.
 * Contract accruals add name-only coverage for anything still unresolved.
 */
export async function loadFortnoxCustomers(admin: Admin): Promise<FortnoxCustomerRef[]> {
  // Page through a query (Supabase caps a single select at 1000 rows). The
  // caller applies `.range(from, to)` to a fully-built query so column typing
  // stays intact.
  async function pageAll<T>(
    run: (
      from: number,
      to: number,
    ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
    maxRows = 20000,
  ): Promise<T[]> {
    const out: T[] = []
    const size = 1000
    for (let from = 0; from < maxRows; from += size) {
      const { data, error } = await run(from, from + size - 1)
      if (error) throw new Error(error.message)
      const batch = data ?? []
      out.push(...batch)
      if (batch.length < size) break
    }
    return out
  }

  // 1. Customers — company identity (name + org), by id and by any number set.
  const customers = await pageAll<{
    id: string
    name: string | null
    org_number: string | null
    fortnox_customer_number: string | null
  }>((from, to) =>
    admin
      .from("customers")
      .select("id, name, org_number, fortnox_customer_number")
      .range(from, to)
      .returns<
        {
          id: string
          name: string | null
          org_number: string | null
          fortnox_customer_number: string | null
        }[]
      >(),
  )

  const byId = new Map<string, { name: string; org: string }>()
  const register = new Map<string, FortnoxCustomerRef>()
  for (const c of customers) {
    byId.set(c.id, { name: c.name ?? "", org: c.org_number ?? "" })
    const num = (c.fortnox_customer_number ?? "").trim()
    if (num && !register.has(num)) {
      register.set(num, {
        fortnoxCustomerNumber: num,
        name: c.name ?? "",
        orgNumber: c.org_number ?? "",
      })
    }
  }

  // 2. Invoices — number → company (org via the linked customer). Best-effort:
  //    a failure here must not break the calculation, and we scan the most
  //    recent invoices first so active/billed customers are covered.
  try {
    const invoices = await pageAll<{
      fortnox_customer_number: string | null
      customer_name: string | null
      customer_id: string | null
    }>((from, to) =>
      admin
        .from("invoices")
        .select("fortnox_customer_number, customer_name, customer_id")
        .not("fortnox_customer_number", "is", null)
        .order("invoice_date", { ascending: false })
        .range(from, to)
        .returns<
          {
            fortnox_customer_number: string | null
            customer_name: string | null
            customer_id: string | null
          }[]
        >(),
    )
    for (const inv of invoices) {
      const num = (inv.fortnox_customer_number ?? "").trim()
      if (!num || register.has(num)) continue
      const linked = inv.customer_id ? byId.get(inv.customer_id) : undefined
      register.set(num, {
        fortnoxCustomerNumber: num,
        name: linked?.name || inv.customer_name || "",
        orgNumber: linked?.org ?? "",
      })
    }
  } catch (err) {
    console.error("[pricing] invoice register bridge failed (continuing):", err)
  }

  return [...register.values()]
}

/**
 * Persist the computed result as the single shared 'latest' snapshot so every
 * logged-in user can view it. Called by admins on calculate / after edits.
 */
export async function saveCalculationResult(
  admin: Admin,
  payload: StoredCalculation,
  computedBy: string | null,
) {
  const { error } = await admin.from("license_calculation_result").upsert(
    {
      id: "latest",
      period: payload.period || null,
      payload: payload as unknown as Record<string, unknown>,
      computed_by: computedBy,
      computed_at: new Date().toISOString(),
    } as never,
    { onConflict: "id" },
  )
  if (error) throw error
}

/** Load the shared 'latest' result snapshot, or null if none has been computed. */
export async function loadCalculationResult(admin: Admin): Promise<StoredCalculation | null> {
  const { data, error } = await admin
    .from("license_calculation_result")
    .select("payload")
    .eq("id", "latest")
    .maybeSingle<{ payload: StoredCalculation }>()
  if (error) throw error
  return data?.payload ?? null
}

/** Upsert one per-client override, keyed by org number. */
export async function upsertCustomerConfig(
  admin: Admin,
  cfg: CustomerConfig & { name?: string | null },
) {
  const orgKey = cfg.orgNumber.replace(/\D/g, "")
  const payload = {
    org_number: orgKey,
    name: cfg.name ?? null,
    fortnox_customer_number: cfg.fortnoxCustomerNumber ?? null,
    discount_percent: cfg.discountPercent ?? 0,
    fixed_price_fortnox: cfg.fixedPriceFortnox ?? null,
    fixed_price_reda: cfg.fixedPriceReda ?? null,
    fixed_price_nvr: cfg.fixedPriceNvr ?? null,
    nvr_start_fee_charged_at: cfg.nvrStartFeeChargedAt ?? null,
    comment: cfg.comment ?? null,
    status: cfg.status ?? null,
  }
  const { error } = await admin
    .from("license_customer_config")
    .upsert(payload as never, { onConflict: "org_number" })
  if (error) throw error
}
