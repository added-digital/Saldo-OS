/**
 * Träfflista / Hit list rule definitions.
 *
 * Each rule scopes which customers (with synced SIE files) match a financial
 * "warning" / opportunity, expressed as one or more thresholds over the
 * customer's financials for the current financial year. The page (/hit-list)
 * evaluates these and lists the matching companies under an expandable row.
 *
 * A value can come from one of two sources:
 *   - "account": a raw SIE account closing/opening balance (sie_account_balances)
 *   - "kpi":     a precomputed KPI value (sie_kpis), reusing the KPI engine's
 *                range-sum math instead of recomputing ratios here.
 *
 * The shape is intentionally declarative so new rules can be added here
 * without touching the page's evaluation logic.
 *
 * BAS sign conventions (see kpi-definitions.ts for the full note):
 *   - Equity / liabilities (class 2) are credit-balanced → stored NEGATIVE in
 *     SIE. Set `negate: true` to surface a positive figure (e.g. registered
 *     share capital on account 2081).
 */

export type HitListUnit = "kr" | "%" | "ratio";

export type CompareOp = "gt" | "gte" | "lt" | "lte";

/** A reference to one account's balance for a financial year. */
export interface AccountRef {
  /** BAS account number, e.g. "2081" (Aktiekapital). */
  account: string;
  /** 'ub' = closing balance (year-end), 'ib' = opening balance (year-start). */
  balanceKind: "ub" | "ib";
  /** Negate the stored amount before use (credit-balanced class 2 accounts). */
  negate?: boolean;
}

/**
 * Where a numeric value comes from. Either a raw SIE account balance or a
 * precomputed KPI (by `sie_kpis.kpi_key`, period = 'YEAR').
 */
export type ValueSource =
  | ({ source: "account" } & AccountRef)
  | { source: "kpi"; kpiKey: string };

/** A single threshold test over a value source (AND-combined per rule). */
export interface Criterion {
  value: ValueSource;
  op: CompareOp;
  threshold: number;
}

export interface HitListRule {
  /** Stable, lowercase, snake_case identifier. */
  key: string;
  /** Localized rule name (the row title). */
  names: { sv: string; en: string };
  /** Short one-line criterion shown under the rule name. */
  summary: { sv: string; en: string };
  /** Advisory services this opportunity could lead to. */
  advisoryServices: { sv: string[]; en: string[] };
  /** Column label for the headline figure shown per matched company. */
  valueLabel: { sv: string; en: string };
  /** Unit of the headline figure (drives formatting). */
  valueUnit: HitListUnit;
  /** Which value to surface as the headline figure per company. */
  displayValue: ValueSource;
  /** All thresholds must pass (AND) for a company to match. */
  criteria: Criterion[];
  /**
   * Sort order for matched companies by the headline value. 'desc' surfaces
   * the biggest figure first (e.g. largest share capital); 'asc' surfaces the
   * lowest first (e.g. worst liquidity). Defaults to 'desc'.
   */
  sort?: "asc" | "desc";
}

// ---------------------------------------------------------------------------
// Round-one rules
// ---------------------------------------------------------------------------

/**
 * Minskning av aktiekapital — customers whose registered share capital
 * (account 2081) exceeds the SEK 25 000 statutory minimum and could therefore
 * reduce it, potentially repaying the difference to the owners.
 */
const SHARE_CAPITAL_REDUCTION: HitListRule = {
  key: "share_capital_reduction",
  names: {
    sv: "Minskning av aktiekapital",
    en: "Share capital reduction",
  },
  summary: {
    sv: "Registrerat aktiekapital > 25 000 kr",
    en: "Registered share capital > SEK 25,000",
  },
  advisoryServices: {
    sv: [
      "Minskning av aktiekapital",
      "Digital aktiebok",
      "Löpande arbete på kommande nyemissioner",
    ],
    en: [
      "Share capital reduction",
      "Digital share register",
      "Ongoing work on upcoming share issues",
    ],
  },
  valueLabel: { sv: "Aktiekapital", en: "Share capital" },
  valueUnit: "kr",
  displayValue: { source: "account", account: "2081", balanceKind: "ub", negate: true },
  criteria: [
    {
      value: { source: "account", account: "2081", balanceKind: "ub", negate: true },
      op: "gt",
      threshold: 25000,
    },
  ],
  sort: "desc",
};

/**
 * Akut likviditetsrisk — customers whose quick ratio (kassalikviditet) is at
 * or below 70 %, i.e. current assets excluding inventory are judged
 * insufficient to cover short-term liabilities. Reuses the precomputed
 * `kassalikviditet` KPI:
 *   (current assets 1400–1999 − inventory 1400–1499) / current liabilities
 *   2400–2999 × 100.
 */
const ACUTE_LIQUIDITY_RISK: HitListRule = {
  key: "acute_liquidity_risk",
  names: {
    sv: "Akut likviditetsrisk",
    en: "Acute liquidity risk",
  },
  summary: {
    sv: "Kassalikviditet ≤ 70 %",
    en: "Quick ratio ≤ 70%",
  },
  advisoryServices: {
    sv: [
      "Likviditetsbudget",
      "Kassaflödesanalys",
      "Finansieringsrådgivning",
      "Kostnadsgenomgång",
      "Förbättring av fakturerings- och betalrutiner",
    ],
    en: [
      "Liquidity budget",
      "Cash flow analysis",
      "Financing advisory",
      "Cost review",
      "Improved invoicing and payment routines",
    ],
  },
  valueLabel: { sv: "Kassalikviditet", en: "Quick ratio" },
  valueUnit: "%",
  displayValue: { source: "kpi", kpiKey: "kassalikviditet" },
  criteria: [
    {
      value: { source: "kpi", kpiKey: "kassalikviditet" },
      op: "lte",
      threshold: 70,
    },
  ],
  // Lowest quick ratio first — the most urgent cases at the top.
  sort: "asc",
};

// ---------------------------------------------------------------------------
// Exported registry
// ---------------------------------------------------------------------------

/** Canonical list. Ordering controls row order on the hit-list page. */
export const HIT_LIST_RULES: HitListRule[] = [
  SHARE_CAPITAL_REDUCTION,
  ACUTE_LIQUIDITY_RISK,
];

/** Quick lookup by `key`. */
export const HIT_LIST_RULES_BY_KEY: Record<string, HitListRule> =
  Object.fromEntries(HIT_LIST_RULES.map((r) => [r.key, r]));

/** Every value source a rule touches (criteria + display value). */
function valueSourcesForRule(rule: HitListRule): ValueSource[] {
  return [...rule.criteria.map((c) => c.value), rule.displayValue];
}

/** All distinct account numbers any rule needs (single sie_account_balances query). */
export function accountsForRules(rules: HitListRule[]): string[] {
  const set = new Set<string>();
  for (const rule of rules) {
    for (const v of valueSourcesForRule(rule)) {
      if (v.source === "account") set.add(v.account);
    }
  }
  return Array.from(set);
}

/** All distinct KPI keys any rule needs (single sie_kpis query). */
export function kpiKeysForRules(rules: HitListRule[]): string[] {
  const set = new Set<string>();
  for (const rule of rules) {
    for (const v of valueSourcesForRule(rule)) {
      if (v.source === "kpi") set.add(v.kpiKey);
    }
  }
  return Array.from(set);
}

/** Per-customer financial context the evaluator reads values from. */
export interface CustomerFinancials {
  /** account number → { ub, ib } */
  accounts: Map<string, { ub: number | null; ib: number | null }>;
  /** kpi_key → YEAR value */
  kpis: Map<string, number | null>;
}

/** Resolve a value source for a customer, applying account sign rules. */
export function resolveValue(
  source: ValueSource,
  fin: CustomerFinancials,
): number | null {
  if (source.source === "kpi") {
    return fin.kpis.get(source.kpiKey) ?? null;
  }
  const entry = fin.accounts.get(source.account);
  if (!entry) return null;
  const raw = source.balanceKind === "ub" ? entry.ub : entry.ib;
  if (raw == null) return null;
  return source.negate ? -raw : raw;
}

/** True when `value` satisfies the comparison. */
export function passesThreshold(
  value: number | null,
  op: CompareOp,
  threshold: number,
): boolean {
  if (value == null || !Number.isFinite(value)) return false;
  switch (op) {
    case "gt":
      return value > threshold;
    case "gte":
      return value >= threshold;
    case "lt":
      return value < threshold;
    case "lte":
      return value <= threshold;
  }
}

/** True when every criterion of `rule` passes for the given customer. */
export function ruleMatches(
  rule: HitListRule,
  fin: CustomerFinancials,
): boolean {
  return rule.criteria.every((c) =>
    passesThreshold(resolveValue(c.value, fin), c.op, c.threshold),
  );
}
