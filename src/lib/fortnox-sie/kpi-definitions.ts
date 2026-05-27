/**
 * SIE-derived KPI definitions.
 *
 * Each KPI is an expression tree over account-range sums, modeled after the
 * Oxceed `Oxceed.Core.Finance.KeyPerformanceIndicator` JSON shape (see the
 * Kassalikviditet sample in docs). The shape is intentionally portable so
 * we can move to user-configurable JSONB-stored definitions later without
 * rewriting the evaluator.
 *
 * Round-one KPI set (Swedish BAS chart, all customers we sync):
 *   - revenue            (Omsättning)             — income statement
 *   - gross_margin_pct   (Bruttomarginal)         — income statement
 *   - ebit               (Rörelseresultat)        — income statement
 *   - kassalikviditet    (Kassalikviditet)        — balance sheet
 *   - soliditet          (Soliditet)              — balance sheet
 *
 * BAS sign conventions to keep in mind:
 *   - Income accounts (class 3) are credit-balanced → stored as NEGATIVE
 *     numbers in SIE. Revenue formulas negate the sum to surface a
 *     positive figure for display.
 *   - Cost accounts (classes 4–7) are debit-balanced → stored as POSITIVE.
 *     Revenue − Costs therefore equals revenue PLUS the negative income
 *     numbers, i.e. just sum(3000..7999) negated.
 *   - Equity / liabilities (class 2) are credit-balanced → NEGATIVE in
 *     SIE; negate to surface positive equity / debt totals.
 */

// ---------------------------------------------------------------------------
// Expression tree types
// ---------------------------------------------------------------------------

/** A contiguous range of BAS account numbers, both bounds inclusive. */
export interface AccountInterval {
  from: number;
  to: number;
}

/**
 * Leaf node: sum the closing balances (UB) of every account whose number
 * falls inside any of the provided intervals.
 *
 * `useOpeningBalances` switches to incoming balances (IB) — used for
 * point-in-time KPIs that average against the start-of-year position.
 *
 * `negate` flips the sign. Liability/equity sums need this because they're
 * stored credit-balanced (negative) in the SIE source.
 *
 * `flow` switches the source from year-end balances (UB) to the sum of all
 * twelve period balances (PSALDO). For income-statement accounts this is
 * the correct year-to-date figure; for balance-sheet accounts it's
 * nonsensical, so flow nodes only point at flow accounts (classes 3-8).
 */
export interface AccountSumNode {
  kind: "sum";
  /** Human-readable for the "why this number" explainer on the detail page. */
  label: string;
  intervals: AccountInterval[];
  /** Read IB (year-start) instead of UB (year-end). Defaults to false. */
  useOpeningBalances?: boolean;
  /** Negate the sum after computing. Used for credit-balanced accounts. */
  negate?: boolean;
  /** Read flow (sum of monthly PSALDO) instead of balance. Defaults to false. */
  flow?: boolean;
}

/** Binary operator over two sub-expressions. */
export interface BinaryOpNode {
  kind: "binary";
  op: "+" | "-" | "*" | "/";
  left: KpiExpression;
  right: KpiExpression;
}

/** Multiply by a constant. Used to convert ratios to percentages (×100). */
export interface ScaleNode {
  kind: "scale";
  factor: number;
  child: KpiExpression;
}

export type KpiExpression = AccountSumNode | BinaryOpNode | ScaleNode;

// ---------------------------------------------------------------------------
// Target / flagging rule
// ---------------------------------------------------------------------------

export interface KpiTarget {
  /** Flag when the computed value crosses this threshold in the named direction. */
  op: "gte" | "gt" | "lte" | "lt";
  value: number;
  unit: "kr" | "%" | "ratio";
}

// ---------------------------------------------------------------------------
// KPI definition
// ---------------------------------------------------------------------------

export interface KpiDefinition {
  /** Stable, lowercase, snake_case. Stored in sie_kpis.kpi_key. */
  key: string;
  /** Localized display names. */
  names: { sv: string; en: string };
  /** Localized descriptions — surface as the tooltip / detail explainer. */
  descriptions: { sv: string; en: string };
  /** Unit of the result. Drives formatting on the page. */
  unit: "kr" | "%" | "ratio";
  /** Decimal places for display. */
  decimals: number;
  /**
   * Optional target rule. When omitted, the KPI is informational and never
   * gets flagged. When present, the engine evaluates it and stores both
   * the rule snapshot and the boolean `flagged` outcome.
   *
   * Convention: target means "the healthy side of the threshold". The
   * engine flags when the value is on the WRONG side of `op`.
   *   - `gte: 100` → flag if value < 100
   *   - `lte: 50`  → flag if value > 50
   */
  target?: KpiTarget;
  /** Income-statement KPIs ('flow') sum periods; balance-sheet KPIs ('stock') read UB. */
  type: "flow" | "stock";
  /** The expression tree the engine evaluates. */
  expression: KpiExpression;
}

// ---------------------------------------------------------------------------
// Convenience builders — keep the definitions readable
// ---------------------------------------------------------------------------

function sum(
  label: string,
  intervals: AccountInterval[],
  opts: { negate?: boolean; useOpeningBalances?: boolean; flow?: boolean } = {},
): AccountSumNode {
  return { kind: "sum", label, intervals, ...opts };
}

function div(left: KpiExpression, right: KpiExpression): BinaryOpNode {
  return { kind: "binary", op: "/", left, right };
}

function sub(left: KpiExpression, right: KpiExpression): BinaryOpNode {
  return { kind: "binary", op: "-", left, right };
}

function scale(factor: number, child: KpiExpression): ScaleNode {
  return { kind: "scale", factor, child };
}

// ---------------------------------------------------------------------------
// Round-one definitions
// ---------------------------------------------------------------------------

/**
 * Omsättning — total revenue for the period.
 * Sum of class 3 accounts (3000–3999), negated because income is stored
 * credit-balanced in SIE.
 */
const REVENUE: KpiDefinition = {
  key: "revenue",
  names: { sv: "Omsättning", en: "Revenue" },
  descriptions: {
    sv: "Summan av samtliga intäktskonton (klass 3) under perioden. Formel: −Summa(3000–3999).",
    en: "Sum of all income accounts (class 3) over the period. Formula: −Sum(3000–3999).",
  },
  unit: "kr",
  decimals: 0,
  type: "flow",
  expression: sum("Intäkter", [{ from: 3000, to: 3999 }], {
    negate: true,
    flow: true,
  }),
};

/**
 * Bruttomarginal — gross margin percentage.
 * (Revenue − COGS) / Revenue × 100, where revenue is negated class 3 and
 * COGS is class 4 (debit-balanced, positive). Equivalent expression:
 *   −Sum(3000–3999) − Sum(4000–4999), divided by −Sum(3000–3999), ×100.
 *
 * Implemented as: (−sum(3..) − sum(4..)) / −sum(3..) × 100.
 */
const GROSS_MARGIN_PCT: KpiDefinition = {
  key: "gross_margin_pct",
  names: { sv: "Bruttomarginal", en: "Gross margin" },
  descriptions: {
    sv: "Bruttovinst i procent av omsättning. Formel: (Omsättning − KSV) / Omsättning × 100. Negativ marginal flaggas.",
    en: "Gross profit as a percentage of revenue. Formula: (Revenue − COGS) / Revenue × 100. Negative margins are flagged.",
  },
  unit: "%",
  decimals: 1,
  target: { op: "gte", value: 0, unit: "%" },
  type: "flow",
  expression: scale(
    100,
    div(
      sub(
        sum("Intäkter", [{ from: 3000, to: 3999 }], { negate: true, flow: true }),
        sum("Kostnad sålda varor", [{ from: 4000, to: 4999 }], { flow: true }),
      ),
      sum("Intäkter", [{ from: 3000, to: 3999 }], { negate: true, flow: true }),
    ),
  ),
};

/**
 * Rörelseresultat (EBIT) — operating result before financial items.
 * Revenue minus all operating costs (classes 4–7). Class 8 (financial
 * items) is excluded so this is operating result rather than net result.
 *
 * Sign math:
 *   class 3 stored negative, classes 4–7 stored positive.
 *   EBIT = −sum(3..) − sum(4–7..)
 *        = −[sum(3..) + sum(4–7..)]
 *        = −sum(3000..7999)
 */
const EBIT: KpiDefinition = {
  key: "ebit",
  names: { sv: "Rörelseresultat", en: "Operating result" },
  descriptions: {
    sv: "Rörelseresultat (EBIT). Intäkter minus rörelsekostnader (klasserna 4–7). Formel: −Summa(3000–7999). Negativt resultat flaggas.",
    en: "Operating result (EBIT). Revenue minus operating costs (classes 4–7). Formula: −Sum(3000–7999). Losses are flagged.",
  },
  unit: "kr",
  decimals: 0,
  target: { op: "gte", value: 0, unit: "kr" },
  type: "flow",
  expression: sum("Rörelseintäkter och -kostnader", [{ from: 3000, to: 7999 }], {
    negate: true,
    flow: true,
  }),
};

/**
 * Kassalikviditet — quick ratio.
 * Direct port of the Oxceed JSON in docs/examples:
 *   (Omsättningstillgångar 1400–1999 − Varulager 1400–1499)
 *     / −Kortfristiga skulder 2400–2999  ×100
 *
 * Liabilities are credit-balanced (negative) in SIE so the denominator is
 * negated. Year-start (IB) balances per the Oxceed default.
 */
const KASSALIKVIDITET: KpiDefinition = {
  key: "kassalikviditet",
  names: { sv: "Kassalikviditet", en: "Quick ratio" },
  descriptions: {
    sv: "BAS-nyckeltal T45. (Omsättningstillgångar − Varulager) / Kortfristiga skulder × 100. Bör vara minst 100%.",
    en: "BAS KPI T45. (Current assets − inventory) / current liabilities × 100. Should be at least 100%.",
  },
  unit: "%",
  decimals: 0,
  target: { op: "gte", value: 100, unit: "%" },
  type: "stock",
  expression: scale(
    100,
    div(
      sub(
        sum("Omsättningstillgångar", [{ from: 1400, to: 1999 }], {
          useOpeningBalances: true,
        }),
        sum("Varulager", [{ from: 1400, to: 1499 }], { useOpeningBalances: true }),
      ),
      sum("Kortfristiga skulder", [{ from: 2400, to: 2999 }], {
        useOpeningBalances: true,
        negate: true,
      }),
    ),
  ),
};

/**
 * Soliditet — equity ratio.
 *   −Sum(2000–2099, equity) / Sum(1000–1999, total assets) × 100
 *
 * Equity sits in 2000–2099 and is credit-balanced; assets in 1000–1999 are
 * debit-balanced and positive. Year-end balances per the Swedish convention.
 */
const SOLIDITET: KpiDefinition = {
  key: "soliditet",
  names: { sv: "Soliditet", en: "Equity ratio" },
  descriptions: {
    sv: "Eget kapital i procent av balansomslutningen. Formel: −Summa(2000–2099) / Summa(1000–1999) × 100. Under 30% flaggas.",
    en: "Equity as a percentage of total assets. Formula: −Sum(2000–2099) / Sum(1000–1999) × 100. Flagged below 30%.",
  },
  unit: "%",
  decimals: 0,
  target: { op: "gte", value: 30, unit: "%" },
  type: "stock",
  expression: scale(
    100,
    div(
      sum("Eget kapital", [{ from: 2000, to: 2099 }], { negate: true }),
      sum("Totala tillgångar", [{ from: 1000, to: 1999 }]),
    ),
  ),
};

// ---------------------------------------------------------------------------
// Exported registry
// ---------------------------------------------------------------------------

/**
 * Canonical list. Ordering controls the default column order on the
 * Nyckeltal overview page and the card order on the detail page.
 */
export const KPI_DEFINITIONS: KpiDefinition[] = [
  REVENUE,
  GROSS_MARGIN_PCT,
  EBIT,
  KASSALIKVIDITET,
  SOLIDITET,
];

/** Quick lookup by `key`. */
export const KPI_DEFINITIONS_BY_KEY: Record<string, KpiDefinition> =
  Object.fromEntries(KPI_DEFINITIONS.map((d) => [d.key, d]));

/** Convenience: which KPIs should produce a monthly trend on the detail page. */
export const FLOW_KPI_KEYS: string[] = KPI_DEFINITIONS.filter(
  (d) => d.type === "flow",
).map((d) => d.key);
