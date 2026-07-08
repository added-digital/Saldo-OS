/**
 * Server-side helpers to load the pricing feature's reference data from
 * Supabase (price list + saved per-client config) using the admin client.
 * Callers must already have verified the caller is an admin.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/types/database"
import type { PriceListEntry } from "./price-list"
import type { CustomerConfig } from "./compute"

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
