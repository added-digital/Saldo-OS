import type { SupabaseClient } from "@supabase/supabase-js";

import { createAdminClient } from "@/lib/supabase/admin";

import {
  KPI_DEFINITIONS,
  type AccountSumNode,
  type KpiDefinition,
  type KpiExpression,
  type KpiTarget,
} from "./kpi-definitions";

/**
 * SIE KPI evaluator.
 *
 * Pure function over the rows already in sie_account_balances and
 * sie_period_balances. Given a (customer, financial_year_from) it:
 *
 *   1. Loads every relevant balance row in two queries (one for stock,
 *      one for flow). One round-trip per kind is enough — accounts/ranges
 *      are filtered in memory.
 *   2. For each KPI definition, walks the expression tree, summing the
 *      ranges from the loaded rows and computing the operator results.
 *   3. Optionally evaluates the target threshold to set `flagged`.
 *   4. Returns one EvaluatedKpi per definition AND per period — the YEAR
 *      rollup, plus a YYYYMM row for every month present (flow KPIs only —
 *      stock KPIs only make sense at year-end / year-start).
 *
 * The function does NOT write to sie_kpis. That's the job of the
 * generate-kpis route, which calls this function and persists the
 * results. Keeping the engine pure makes it trivially unit-testable.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EvaluatedKpi {
  kpiKey: string;
  period: string; // 'YEAR' or 'YYYYMM'
  value: number | null;
  unit: "kr" | "%" | "ratio";
  flagged: boolean;
  target: KpiTarget | null;
  inputs: Record<string, number | null>;
}

export interface EvaluateKpisOptions {
  customerId: string;
  financialYearFrom: string; // ISO date, e.g. '2026-01-01'
  admin?: SupabaseClient;
}

export interface EvaluateKpisResult {
  customerId: string;
  financialYearFrom: string;
  kpis: EvaluatedKpi[];
  /** Months we found period balances for; useful for the detail page. */
  monthsCovered: string[];
}

// ---------------------------------------------------------------------------
// Loader — single round-trip per kind
// ---------------------------------------------------------------------------

interface LoadedBalances {
  /** account_number → IB (year-start) amount. */
  ib: Map<string, number>;
  /** account_number → UB (year-end) amount. */
  ub: Map<string, number>;
  /**
   * account_number → period → amount. Period is 'YYYYMM'. Used for flow
   * KPIs (revenue, EBIT) so we can roll up across all months for the YEAR
   * rollup AND emit per-month values for the trend chart.
   */
  psaldo: Map<string, Map<string, number>>;
  monthsCovered: string[];
}

async function loadBalances(
  admin: SupabaseClient,
  customerId: string,
  financialYearFrom: string,
): Promise<LoadedBalances> {
  const [acctRes, periodRes] = await Promise.all([
    admin
      .from("sie_account_balances")
      .select("account_number, kind, amount")
      .eq("customer_id", customerId)
      .eq("financial_year_from", financialYearFrom)
      .in("kind", ["ib", "ub"]),
    admin
      .from("sie_period_balances")
      .select("account_number, period, kind, amount, objects")
      .eq("customer_id", customerId)
      .eq("financial_year_from", financialYearFrom)
      .eq("kind", "psaldo"),
  ]);

  if (acctRes.error) {
    throw new Error(
      `kpi-engine: failed to load sie_account_balances: ${acctRes.error.message}`,
    );
  }
  if (periodRes.error) {
    throw new Error(
      `kpi-engine: failed to load sie_period_balances: ${periodRes.error.message}`,
    );
  }

  const ib = new Map<string, number>();
  const ub = new Map<string, number>();
  for (const row of (acctRes.data ?? []) as Array<{
    account_number: string;
    kind: string;
    amount: number | string;
  }>) {
    const amount =
      typeof row.amount === "string" ? Number(row.amount) : row.amount;
    if (!Number.isFinite(amount)) continue;
    (row.kind === "ib" ? ib : ub).set(row.account_number, amount);
  }

  const psaldo = new Map<string, Map<string, number>>();
  const monthsSet = new Set<string>();
  for (const row of (periodRes.data ?? []) as Array<{
    account_number: string;
    period: string;
    amount: number | string;
    objects: unknown;
  }>) {
    // Object-scoped rows (cost-centre / project filters) are NOT included
    // in the headline KPI total. They live alongside the unscoped row in
    // sie_period_balances; if we sum them we'd double-count. Skip them.
    if (Array.isArray(row.objects) && row.objects.length > 0) continue;

    const amount =
      typeof row.amount === "string" ? Number(row.amount) : row.amount;
    if (!Number.isFinite(amount)) continue;
    monthsSet.add(row.period);
    let perAccount = psaldo.get(row.account_number);
    if (!perAccount) {
      perAccount = new Map();
      psaldo.set(row.account_number, perAccount);
    }
    // Multiple psaldo rows can exist for the same (account, period) when
    // the file carries un-objected AND object-objected variants. We already
    // filtered out the objected ones, so any remaining duplicate is a
    // re-emission of the same un-objected total — last-write wins.
    perAccount.set(row.period, amount);
  }

  return {
    ib,
    ub,
    psaldo,
    monthsCovered: Array.from(monthsSet).sort(),
  };
}

// ---------------------------------------------------------------------------
// Sum helper — does the account-range arithmetic the AccountSumNode describes
// ---------------------------------------------------------------------------

/**
 * Return the parsed integer account number if it's numeric. Some SIE files
 * include alphanumeric sub-accounts (rare but legal); those never match a
 * numeric range and are silently excluded.
 */
function parseAccountNumber(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function inAnyInterval(
  accountNumber: number,
  intervals: AccountSumNode["intervals"],
): boolean {
  for (const i of intervals) {
    if (accountNumber >= i.from && accountNumber <= i.to) return true;
  }
  return false;
}

interface SumContext {
  balances: LoadedBalances;
  /**
   * If set, evaluate flow nodes against this single period rather than
   * the full-year roll-up. Used to produce monthly values.
   */
  monthOverride?: string;
}

function evaluateAccountSum(
  node: AccountSumNode,
  ctx: SumContext,
): number {
  const intervals = node.intervals;
  let total = 0;

  if (node.flow) {
    // Flow node: walk psaldo. If a month override is set, only that
    // month's row counts; otherwise sum every month.
    for (const [acctRaw, perPeriod] of ctx.balances.psaldo.entries()) {
      const acct = parseAccountNumber(acctRaw);
      if (acct == null) continue;
      if (!inAnyInterval(acct, intervals)) continue;

      if (ctx.monthOverride) {
        const v = perPeriod.get(ctx.monthOverride);
        if (typeof v === "number") total += v;
      } else {
        for (const v of perPeriod.values()) total += v;
      }
    }
  } else {
    // Stock node: walk IB or UB.
    const source = node.useOpeningBalances
      ? ctx.balances.ib
      : ctx.balances.ub;
    for (const [acctRaw, amount] of source.entries()) {
      const acct = parseAccountNumber(acctRaw);
      if (acct == null) continue;
      if (!inAnyInterval(acct, intervals)) continue;
      total += amount;
    }
  }

  return node.negate ? -total : total;
}

// ---------------------------------------------------------------------------
// Expression evaluator
// ---------------------------------------------------------------------------

interface EvaluationOutcome {
  value: number | null;
  /** Sub-totals captured along the way, keyed by AccountSumNode.label. */
  inputs: Record<string, number | null>;
}

function evaluateExpression(
  node: KpiExpression,
  ctx: SumContext,
  inputs: Record<string, number | null>,
): number | null {
  if (node.kind === "sum") {
    const v = evaluateAccountSum(node, ctx);
    // Capture under the leaf's label so the detail page can show "Intäkter
    // = 1 234 567 kr" alongside the headline KPI.
    inputs[node.label] = v;
    return v;
  }

  if (node.kind === "scale") {
    const child = evaluateExpression(node.child, ctx, inputs);
    if (child == null || !Number.isFinite(child)) return null;
    return child * node.factor;
  }

  // Binary operator.
  const left = evaluateExpression(node.left, ctx, inputs);
  const right = evaluateExpression(node.right, ctx, inputs);
  if (left == null || right == null) return null;
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;

  switch (node.op) {
    case "+":
      return left + right;
    case "-":
      return left - right;
    case "*":
      return left * right;
    case "/":
      // Divide-by-zero → null, so the row gets stored as "couldn't
      // compute" instead of NaN / Infinity polluting the UI.
      if (right === 0) return null;
      return left / right;
    default: {
      // Exhaustiveness guard — the union is closed.
      const _exhaustive: never = node.op;
      void _exhaustive;
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Target evaluation
// ---------------------------------------------------------------------------

function isFlagged(value: number | null, target: KpiTarget | undefined): boolean {
  if (!target) return false;
  if (value == null || !Number.isFinite(value)) return false;
  switch (target.op) {
    case "gte":
      return value < target.value;
    case "gt":
      return value <= target.value;
    case "lte":
      return value > target.value;
    case "lt":
      return value >= target.value;
    default: {
      const _exhaustive: never = target.op;
      void _exhaustive;
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function evaluateKpisForCustomer(
  opts: EvaluateKpisOptions,
): Promise<EvaluateKpisResult> {
  const admin = opts.admin ?? createAdminClient();
  const balances = await loadBalances(
    admin,
    opts.customerId,
    opts.financialYearFrom,
  );

  return evaluateKpisFromBalances({
    customerId: opts.customerId,
    financialYearFrom: opts.financialYearFrom,
    balances,
  });
}

/**
 * Same as `evaluateKpisForCustomer` but works against already-loaded
 * balances. Exposed for unit tests and for any callers that already have
 * the rows in memory.
 */
export function evaluateKpisFromBalances(input: {
  customerId: string;
  financialYearFrom: string;
  balances: LoadedBalances;
}): EvaluateKpisResult {
  const kpis: EvaluatedKpi[] = [];

  for (const def of KPI_DEFINITIONS) {
    // Always emit the YEAR rollup.
    kpis.push(evaluateOne(def, { balances: input.balances }));

    // Monthly rows — only for flow KPIs. Stock KPIs use point-in-time
    // balances; emitting them "per month" would be misleading.
    if (def.type === "flow") {
      for (const month of input.balances.monthsCovered) {
        kpis.push(
          evaluateOne(def, { balances: input.balances, monthOverride: month }),
        );
      }
    }
  }

  return {
    customerId: input.customerId,
    financialYearFrom: input.financialYearFrom,
    kpis,
    monthsCovered: input.balances.monthsCovered,
  };
}

function evaluateOne(def: KpiDefinition, ctx: SumContext): EvaluatedKpi {
  const inputs: Record<string, number | null> = {};
  const raw = evaluateExpression(def.expression, ctx, inputs);
  const value =
    raw == null || !Number.isFinite(raw)
      ? null
      : roundTo(raw, def.decimals + 2); // keep two extra decimals in storage
  return {
    kpiKey: def.key,
    period: ctx.monthOverride ?? "YEAR",
    value,
    unit: def.unit,
    flagged: isFlagged(value, def.target),
    target: def.target ?? null,
    inputs,
  };
}

function roundTo(value: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}
