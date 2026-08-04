/**
 * Foreign-currency amounts expressed in kronor.
 *
 * Fortnox stamps `currency_code` on every invoice and contract and leaves the
 * amount in that currency. The KPI rollups convert while accumulating (see
 * `supabase/functions/_shared/currency.ts`), so anything read from
 * `customer_kpis` or `customers.total_turnover` is already in SEK.
 *
 * This module is the counterpart for the places that bypass the rollups and
 * read `contract_accruals` (or invoices) live — the reports dashboard's
 * Avtalsvärde tile and the chat KPI tools. Without it a 2 250 EUR contract is
 * summed as 2 250 kr alongside real kronor.
 *
 * Kept deliberately identical in behaviour to the Edge Function helper: same
 * table, same fallback of converting at 1 when a rate is missing.
 */

type RateReader = {
  from: (table: "currency_rates") => {
    select: (columns: string) => PromiseLike<{
      data: Array<{ code: string; rate_to_sek: number }> | null
      error: { message: string } | null
    }>
  }
}

export type CurrencyRates = Map<string, number>

export const BASE_CURRENCY = "SEK"

export async function loadCurrencyRates(
  supabase: RateReader,
): Promise<CurrencyRates> {
  const rates: CurrencyRates = new Map([[BASE_CURRENCY, 1]])

  const { data, error } = await supabase.from("currency_rates").select("code, rate_to_sek")

  if (error) {
    // A missing rate must never blank out a dashboard: an empty map converts
    // everything at 1, which is what the app did before rates existed.
    console.warn("loadCurrencyRates: rate lookup failed", error.message)
    return rates
  }

  for (const row of data ?? []) {
    const rate = Number(row.rate_to_sek)
    if (Number.isFinite(rate) && rate > 0) {
      rates.set(row.code.trim().toUpperCase(), rate)
    }
  }

  return rates
}

/**
 * Amount in SEK. An unknown or missing currency converts at 1 rather than
 * dropping to null, so an unmapped currency reports at face value (visibly odd,
 * and fixable by adding a rate) instead of silently vanishing from a SUM.
 */
export function toSek(
  amount: number | null | undefined,
  currencyCode: string | null | undefined,
  rates: CurrencyRates,
): number {
  const value = Number(amount ?? 0)
  if (!Number.isFinite(value) || value === 0) return 0

  const code = (currencyCode ?? "").trim().toUpperCase() || BASE_CURRENCY
  if (code === BASE_CURRENCY) return value

  return value * (rates.get(code) ?? 1)
}
