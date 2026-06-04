import { createAdminClient } from "@/lib/supabase/admin";

import type { ToolHandler } from "./types";

/**
 * Raw account-balance lookup for one customer from the synced SIE ledger.
 *
 * Answers precise bookkeeping questions the aggregated KPIs don't cover:
 *   - "what's [customer]'s cash at year end" (account 1910)
 *   - "balance of account 2081 / 3010 / 1510 for [customer]"
 *   - "[customer]'s incoming vs outgoing balance on account X"
 *
 * Reads `sie_account_balances` (admin-only RLS → admin client) and joins
 * `sie_accounts` for human-readable names. Bounded: caller passes explicit
 * account numbers (max 50), so this can't dump the whole chart.
 *
 * SIGN: amounts are the RAW SIE values. Swedish BAS stores credit-balanced
 * classes (2 equity/liabilities, 3 income, 8 financial) as NEGATIVE numbers;
 * debit-balanced classes (1 assets, 4-7 costs) as positive. `amount` is left
 * as stored and `account_class` is included so the figure can be interpreted
 * correctly — see the `sign_note` in the response.
 */

export type GetSieAccountBalanceInput = {
  customer_id: string;
  /** Explicit BAS account numbers, e.g. ["1910", "2081"]. */
  accounts: string[];
  /** Financial year (e.g. 2026). Defaults to current. */
  year?: number | null;
  /** ib = year-start, ub = year-end (default), res = result-account closing. */
  kind?: "ib" | "ub" | "res";
};

type BalanceRow = {
  account_number: string;
  account_class: number | null;
  amount: number | string | null;
};

type AccountNameRow = {
  account_number: string;
  account_name: string | null;
};

const MAX_ACCOUNTS = 50;

function toNumber(value: number | string | null): number | null {
  if (value == null) return null;
  const n = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(n) ? n : null;
}

export const getSieAccountBalance: ToolHandler<
  GetSieAccountBalanceInput
> = async (input) => {
  const supabase = createAdminClient();

  const customerId = input.customer_id?.trim();
  if (!customerId) {
    return {
      error:
        "`customer_id` is required. Call resolve_customer first to get the UUID.",
    };
  }

  const accounts = Array.isArray(input.accounts)
    ? Array.from(
        new Set(
          input.accounts
            .map((a) => (typeof a === "string" ? a.trim() : String(a)))
            .filter((a) => a.length > 0),
        ),
      )
    : [];
  if (accounts.length === 0) {
    return { error: "`accounts` must be a non-empty list of BAS account numbers." };
  }
  if (accounts.length > MAX_ACCOUNTS) {
    return {
      error: `Too many accounts (${accounts.length}). Max ${MAX_ACCOUNTS} per call.`,
    };
  }

  const year =
    input.year != null ? Math.trunc(Number(input.year)) : new Date().getFullYear();
  if (!Number.isInteger(year) || year < 2000 || year > 3000) {
    return { error: "`year` must be a sensible integer (e.g. 2026)." };
  }
  const financialYearFrom = `${year}-01-01`;

  const kind = input.kind ?? "ub";
  if (!["ib", "ub", "res"].includes(kind)) {
    return { error: "`kind` must be one of 'ib', 'ub', 'res'." };
  }

  // ---------------------------------------------------------------------------
  // Balances + account names (two small bounded queries).
  // ---------------------------------------------------------------------------
  const [balRes, nameRes, custRes] = await Promise.all([
    supabase
      .from("sie_account_balances")
      .select("account_number, account_class, amount")
      .eq("customer_id", customerId)
      .eq("financial_year_from", financialYearFrom)
      .eq("kind", kind)
      .in("account_number", accounts),
    supabase
      .from("sie_accounts")
      .select("account_number, account_name")
      .eq("customer_id", customerId)
      .in("account_number", accounts),
    supabase
      .from("customers")
      .select("name, fortnox_customer_number")
      .eq("id", customerId)
      .maybeSingle(),
  ]);

  if (balRes.error) return { error: balRes.error.message };

  const nameByAccount = new Map<string, string | null>();
  if (!nameRes.error) {
    for (const row of (nameRes.data ?? []) as unknown as AccountNameRow[]) {
      nameByAccount.set(row.account_number, row.account_name);
    }
  }

  let customerName: string | null = null;
  if (!custRes.error && custRes.data) {
    customerName =
      (custRes.data as unknown as { name: string | null }).name ?? null;
  }

  const balanceByAccount = new Map<string, BalanceRow>();
  for (const row of (balRes.data ?? []) as unknown as BalanceRow[]) {
    balanceByAccount.set(row.account_number, row);
  }

  // Echo every requested account so a missing one is explicit, not silent.
  const results = accounts.map((account) => {
    const row = balanceByAccount.get(account);
    return {
      account_number: account,
      account_name: nameByAccount.get(account) ?? null,
      account_class: row?.account_class ?? null,
      amount: row ? toNumber(row.amount) : null,
      found: Boolean(row),
    };
  });

  const anyFound = results.some((r) => r.found);

  return {
    customer_id: customerId,
    customer_name: customerName,
    year,
    kind,
    has_data: anyFound,
    accounts: results,
    sign_note:
      "Amounts are raw SIE values. BAS credit-balanced classes (2 = " +
      "equity/liabilities, 3 = income, 8 = financial) are stored NEGATIVE; " +
      "negate them to present a positive figure (e.g. revenue, share capital, " +
      "debt). Classes 1 (assets) and 4-7 (costs) are stored positive.",
    ...(anyFound
      ? {}
      : {
          note:
            `No balances found for ${customerName ?? "this customer"} on the ` +
            `requested accounts in ${year} (kind=${kind}). The customer may ` +
            "have no synced SIE file for that year, or those accounts aren't " +
            "in their chart. This is NOT the same as a zero balance.",
        }),
    source:
      "sie_account_balances (synced SIE general ledger; admin/firm-wide read).",
  };
};
