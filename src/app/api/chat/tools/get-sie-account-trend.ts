import { createAdminClient } from "@/lib/supabase/admin";

import { drainPages } from "./contract-values";
import type { ToolHandler } from "./types";

/**
 * Structured monthly/yearly aggregates over the SIE ledger for ONE customer —
 * computed server-side, never raw transactions.
 *
 * Reads `sie_period_balances` (kind='psaldo' — the per-month movement on each
 * account). Answers questions the year-end KPIs and point-in-time balances
 * don't:
 *   - "how did [customer]'s revenue trend month by month"  (account_class=3, granularity=month)
 *   - "total personnel costs this year"                     (account_class=7, granularity=year)
 *   - "monthly movement on account 1910"                    (accounts=['1910'])
 *   - "class 5 costs broken down by account"                (account_class=5, granularity=year, per_account)
 *
 * Pick EXACTLY ONE selection: `accounts` (explicit numbers), `account_class`
 * (1-8), or `account_from`+`account_to` (range). Output is bounded (≤12 period
 * rows, or capped per-account lists), so this is safe to call broadly.
 *
 * SEMANTICS:
 *   - psaldo is the MOVEMENT within each month, not a running balance.
 *   - For income/cost accounts (classes 3-8) the monthly movement IS the
 *     month's revenue/cost — the natural trend. Class 3 (income) is stored
 *     NEGATIVE; negate to present positive revenue.
 *   - For balance-sheet accounts (classes 1-2) this is the month's CHANGE, not
 *     the closing balance. For point-in-time balances use get_sie_account_balance.
 *
 * Admin/firm-wide read (sie_period_balances is admin-only RLS).
 */

export type GetSieAccountTrendInput = {
  customer_id: string;
  year?: number | null;
  /** Explicit BAS account numbers (max 50; per_account series max 20). */
  accounts?: string[] | null;
  /** Single BAS class 1-8 (first digit of the account number). */
  account_class?: number | null;
  /** Inclusive account-number range bounds (lexicographic; use equal-length numbers). */
  account_from?: string | null;
  account_to?: string | null;
  /** 'month' (default) → per-month series; 'year' → full-year sum. */
  granularity?: "month" | "year";
  /** Break the result down per account instead of summing. Default false. */
  per_account?: boolean;
  /** Cap for per-account lists (year mode). Default 50, max 200. */
  limit?: number | null;
};

type PeriodRow = {
  period: string;
  account_number: string;
  account_class: number | null;
  amount: number | string | null;
};

type AccountNameRow = { account_number: string; account_name: string | null };

const MAX_ACCOUNTS = 50;
const MAX_PER_ACCOUNT_SERIES = 20;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function toNumber(value: number | string | null): number {
  if (value == null) return 0;
  const n = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(n) ? n : 0;
}

const SIGN_NOTE =
  "Values are raw SIE period movements (psaldo). BAS credit-balanced classes " +
  "(2 equity/liabilities, 3 income, 8 financial) are NEGATIVE — negate to show " +
  "positive revenue/equity/debt. Classes 1 (assets) and 4-7 (costs) are " +
  "positive. For balance-sheet accounts (1-2) this is the monthly CHANGE, not " +
  "a running balance — use get_sie_account_balance for point-in-time balances.";

export const getSieAccountTrend: ToolHandler<GetSieAccountTrendInput> = async (
  input,
) => {
  const supabase = createAdminClient();

  const customerId = input.customer_id?.trim();
  if (!customerId) {
    return {
      error:
        "`customer_id` is required. Call resolve_customer first to get the UUID.",
    };
  }

  const year =
    input.year != null ? Math.trunc(Number(input.year)) : new Date().getFullYear();
  if (!Number.isInteger(year) || year < 2000 || year > 3000) {
    return { error: "`year` must be a sensible integer (e.g. 2026)." };
  }
  const financialYearFrom = `${year}-01-01`;

  // --- Exactly one selection ------------------------------------------------
  const accounts = Array.isArray(input.accounts)
    ? Array.from(
        new Set(
          input.accounts
            .map((a) => (typeof a === "string" ? a.trim() : String(a)))
            .filter((a) => a.length > 0),
        ),
      )
    : [];
  const hasAccounts = accounts.length > 0;
  const hasClass = input.account_class != null;
  const hasRange = Boolean(input.account_from && input.account_to);

  const selectionCount = [hasAccounts, hasClass, hasRange].filter(Boolean).length;
  if (selectionCount === 0) {
    return {
      error:
        "Provide exactly one selection: `accounts`, `account_class`, or " +
        "`account_from`+`account_to`.",
    };
  }
  if (selectionCount > 1) {
    return {
      error:
        "Provide only ONE of `accounts`, `account_class`, or the " +
        "`account_from`/`account_to` range — not several.",
    };
  }
  if (hasAccounts && accounts.length > MAX_ACCOUNTS) {
    return { error: `Too many accounts (${accounts.length}). Max ${MAX_ACCOUNTS}.` };
  }

  let accountClass: number | null = null;
  if (hasClass) {
    accountClass = Math.trunc(Number(input.account_class));
    if (!Number.isInteger(accountClass) || accountClass < 1 || accountClass > 8) {
      return { error: "`account_class` must be an integer 1-8." };
    }
  }

  const granularity = input.granularity === "year" ? "year" : "month";
  const perAccount = Boolean(input.per_account);
  const limit =
    typeof input.limit === "number" && Number.isInteger(input.limit) && input.limit > 0
      ? Math.min(input.limit, MAX_LIMIT)
      : DEFAULT_LIMIT;

  // Per-account monthly series is the only path that can balloon; cap it.
  if (granularity === "month" && perAccount) {
    if (!hasAccounts) {
      return {
        error:
          "Per-account monthly series is only allowed with an explicit " +
          "`accounts` list. For a class/range, use granularity='year' with " +
          "per_account, or granularity='month' aggregated.",
      };
    }
    if (accounts.length > MAX_PER_ACCOUNT_SERIES) {
      return {
        error: `Per-account monthly series is capped at ${MAX_PER_ACCOUNT_SERIES} accounts.`,
      };
    }
  }

  // --- Load psaldo rows (paginated) -----------------------------------------
  const { rows, error } = await drainPages<PeriodRow>(() => {
    let q = supabase
      .from("sie_period_balances")
      .select("period, account_number, account_class, amount")
      .eq("customer_id", customerId)
      .eq("financial_year_from", financialYearFrom)
      .eq("kind", "psaldo");
    if (hasAccounts) q = q.in("account_number", accounts);
    else if (hasClass) q = q.eq("account_class", accountClass as number);
    else q = q.gte("account_number", input.account_from!).lte("account_number", input.account_to!);
    return q;
  });
  if (error) return { error };

  const selection = hasAccounts
    ? { type: "accounts" as const, accounts }
    : hasClass
      ? { type: "account_class" as const, account_class: accountClass }
      : { type: "range" as const, account_from: input.account_from, account_to: input.account_to };

  if (rows.length === 0) {
    return {
      customer_id: customerId,
      year,
      selection,
      granularity,
      has_data: false,
      note:
        `No ledger movements found for ${customerId} in ${year} for the ` +
        "requested accounts. The customer may have no synced SIE file for that " +
        "year, or no postings on those accounts. NOT the same as zero activity.",
      sign_note: SIGN_NOTE,
      source: "sie_period_balances (psaldo).",
    };
  }

  const yearTotal = rows.reduce((sum, r) => sum + toNumber(r.amount), 0);

  // --- YEAR granularity -----------------------------------------------------
  if (granularity === "year") {
    if (!perAccount) {
      return {
        customer_id: customerId,
        year,
        selection,
        granularity,
        has_data: true,
        year_total: yearTotal,
        sign_note: SIGN_NOTE,
        source: "sie_period_balances (psaldo), summed over the year.",
      };
    }

    const byAccount = new Map<string, number>();
    for (const r of rows) {
      byAccount.set(r.account_number, (byAccount.get(r.account_number) ?? 0) + toNumber(r.amount));
    }
    const accountNumbers = Array.from(byAccount.keys());
    const names = await fetchAccountNames(supabase, customerId, accountNumbers);

    const sorted = accountNumbers
      .map((acc) => ({
        account_number: acc,
        account_name: names.get(acc) ?? null,
        amount: byAccount.get(acc) ?? 0,
      }))
      .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

    return {
      customer_id: customerId,
      year,
      selection,
      granularity,
      has_data: true,
      per_account: true,
      year_total: yearTotal,
      account_count: sorted.length,
      accounts: sorted.slice(0, limit),
      ...(sorted.length > limit
        ? {
            _compacted: [
              {
                field: "accounts",
                total_count: sorted.length,
                shown_count: limit,
                note: "More accounts have activity — raise `limit` (max 200).",
              },
            ],
          }
        : {}),
      sign_note: SIGN_NOTE,
      source: "sie_period_balances (psaldo), summed per account over the year.",
    };
  }

  // --- MONTH granularity ----------------------------------------------------
  if (!perAccount) {
    const byPeriod = new Map<string, number>();
    for (const r of rows) {
      byPeriod.set(r.period, (byPeriod.get(r.period) ?? 0) + toNumber(r.amount));
    }
    const series = Array.from(byPeriod.entries())
      .map(([period, amount]) => ({ period, amount }))
      .sort((a, b) => a.period.localeCompare(b.period));

    return {
      customer_id: customerId,
      year,
      selection,
      granularity,
      has_data: true,
      series,
      year_total: yearTotal,
      sign_note: SIGN_NOTE,
      source: "sie_period_balances (psaldo), summed per month.",
    };
  }

  // Per-account monthly series (explicit accounts, ≤ MAX_PER_ACCOUNT_SERIES).
  const seriesByAccount = new Map<string, Map<string, number>>();
  for (const r of rows) {
    let m = seriesByAccount.get(r.account_number);
    if (!m) {
      m = new Map();
      seriesByAccount.set(r.account_number, m);
    }
    m.set(r.period, (m.get(r.period) ?? 0) + toNumber(r.amount));
  }
  const names = await fetchAccountNames(
    supabase,
    customerId,
    Array.from(seriesByAccount.keys()),
  );
  const perAccountSeries = Array.from(seriesByAccount.entries()).map(
    ([account_number, periods]) => ({
      account_number,
      account_name: names.get(account_number) ?? null,
      series: Array.from(periods.entries())
        .map(([period, amount]) => ({ period, amount }))
        .sort((a, b) => a.period.localeCompare(b.period)),
    }),
  );

  return {
    customer_id: customerId,
    year,
    selection,
    granularity,
    has_data: true,
    per_account: true,
    accounts: perAccountSeries,
    year_total: yearTotal,
    sign_note: SIGN_NOTE,
    source: "sie_period_balances (psaldo), per account per month.",
  };
};

async function fetchAccountNames(
  supabase: ReturnType<typeof createAdminClient>,
  customerId: string,
  accountNumbers: string[],
): Promise<Map<string, string | null>> {
  const names = new Map<string, string | null>();
  if (accountNumbers.length === 0) return names;
  // Bounded by the accounts present in the result; chunk defensively.
  const CHUNK = 200;
  for (let i = 0; i < accountNumbers.length; i += CHUNK) {
    const chunk = accountNumbers.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from("sie_accounts")
      .select("account_number, account_name")
      .eq("customer_id", customerId)
      .in("account_number", chunk);
    if (error) continue;
    for (const row of (data ?? []) as unknown as AccountNameRow[]) {
      names.set(row.account_number, row.account_name);
    }
  }
  return names;
}
