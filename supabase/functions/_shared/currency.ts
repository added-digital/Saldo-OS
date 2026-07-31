import { createAdminClient } from "./supabase.ts";

/**
 * Converting foreign-currency invoices to SEK for the KPI rollups.
 *
 * Fortnox stamps `currency_code` on every invoice and contract, with the amount
 * left in that currency. Everything Saldo reports is in kronor, so the rollups
 * multiply by the rate below before accumulating. Nothing is written back to
 * the source rows — `invoices` and `contract_accruals` stay exactly as Fortnox
 * delivered them.
 */
export type CurrencyRates = Map<string, number>;

export const BASE_CURRENCY = "SEK";

export async function loadCurrencyRates(
  supabase: ReturnType<typeof createAdminClient>,
): Promise<CurrencyRates> {
  const rates: CurrencyRates = new Map([[BASE_CURRENCY, 1]]);

  const { data, error } = await supabase
    .from("currency_rates")
    .select("code, rate_to_sek");

  if (error) {
    // Missing table or a transient read failure must not abort a sync: with an
    // empty map every amount converts at 1, which is exactly the behaviour
    // before this feature existed. SEK customers (all but a couple) are
    // unaffected either way.
    console.warn(
      JSON.stringify({
        scope: "currency",
        event: "rate_load_failed",
        error: error.message,
      }),
    );
    return rates;
  }

  for (const row of (data ?? []) as Array<{
    code: string;
    rate_to_sek: number;
  }>) {
    const rate = Number(row.rate_to_sek);
    if (Number.isFinite(rate) && rate > 0) {
      rates.set(row.code.trim().toUpperCase(), rate);
    }
  }

  return rates;
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
  const value = Number(amount ?? 0);
  if (!Number.isFinite(value) || value === 0) return 0;

  const code = (currencyCode ?? "").trim().toUpperCase() || BASE_CURRENCY;
  if (code === BASE_CURRENCY) return value;

  return value * (rates.get(code) ?? 1);
}
