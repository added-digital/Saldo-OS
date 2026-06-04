import type Anthropic from "@anthropic-ai/sdk";

import { KPI_DEFINITIONS } from "@/lib/fortnox-sie/kpi-definitions";
import { HIT_LIST_RULES } from "@/lib/fortnox-sie/hit-list-definitions";

import { getChurnAnalysis } from "./get-churn-analysis";
import { getChurnedCustomers } from "./get-churned-customers";
import { getConsultantCustomers } from "./get-consultant-customers";
import { getCostCenterDetails } from "./get-cost-center-details";
import { getCustomerOverview } from "./get-customer-overview";
import { getConsultantPersonalHours } from "./get-consultant-personal-hours";
import { getKpiByConsultant } from "./get-kpi-by-consultant";
import { getKpiSummary } from "./get-kpi-summary";
import { getTopCustomers } from "./get-top-customers";
import { listCostCenters } from "./list-cost-centers";
import { getHitListMatches } from "./get-hit-list-matches";
import { getSieAccountBalance } from "./get-sie-account-balance";
import { getSieAccountTrend } from "./get-sie-account-trend";
import { getSieKpis } from "./get-sie-kpis";
import { rankSieKpis } from "./rank-sie-kpis";
import { resolveConsultant } from "./resolve-consultant";
import { resolveCustomer } from "./resolve-customer";
import { searchDocuments } from "./search-documents";
import { searchInvoices } from "./search-invoices";
import type { ToolContext, ToolResult } from "./types";

// Allowed SIE KPI keys for the schema enums, derived from the canonical
// registry so the tool schema can never drift from the definitions/engine.
const SIE_KPI_KEYS = KPI_DEFINITIONS.map((d) => d.key);
const SIE_KPI_KEY_HINT = KPI_DEFINITIONS.map(
  (d) => `${d.key} (${d.names.sv})`,
).join(", ");

// Hit-list rule keys, derived from the canonical rule registry so the schema
// enum and the hint can't drift from the rules the engine actually evaluates.
const HIT_LIST_RULE_KEYS = HIT_LIST_RULES.map((r) => r.key);
const HIT_LIST_RULE_HINT = HIT_LIST_RULES.map(
  (r) => `${r.key} (${r.names.sv})`,
).join(", ");

/**
 * Tool definitions sent to Claude. Names are snake_case to match Anthropic's
 * convention. Keep input_schema strict — Claude will refuse to call a tool
 * whose schema rejects valid inputs, so over-narrow constraints hurt.
 */
export const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: "resolve_customer",
    description:
      "Look up customers by name, organisation number, or Fortnox customer " +
      "number. Returns up to `limit` candidates so you can disambiguate before " +
      "calling other tools that need a customer_id (UUID). Always call this " +
      "first when the user references a customer by name.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Free-text fragment — customer name, org number, or Fortnox " +
            "number. Case-insensitive substring match.",
        },
        limit: {
          type: "integer",
          description: "Max candidates to return (1-20). Default 5.",
          minimum: 1,
          maximum: 20,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_customer_overview",
    description:
      "Return a compact dossier for a single customer: profile fields, the " +
      "latest monthly KPI snapshot (turnover, hours, contract value), the " +
      "count of active contracts, recent activities, AND the customer's " +
      "contacts (primary first). Use this as the first call for any " +
      "customer-scoped question — it usually answers 'how's customer X " +
      "doing?' and 'vem ska jag kontakta på X?' / 'who do I contact at X?' " +
      "without further tool calls.\n\n" +
      "Contact fields:\n" +
      "  - `primary_contact` → the single flagged primary, or null if none " +
      "is flagged.\n" +
      "  - `contacts` → up to 10 contacts (name, first_name, last_name, " +
      "role, email, phone, linkedin, is_primary, relationship_label), " +
      "ordered with the primary first. NEVER tell the user to check " +
      "Fortnox for contact info when these fields are populated.",
    input_schema: {
      type: "object",
      properties: {
        customer_id: {
          type: "string",
          description: "Customer UUID (from resolve_customer.matches[].id).",
        },
      },
      required: ["customer_id"],
    },
  },
  {
    name: "get_kpi_summary",
    description:
      "Return aggregated KPI numbers (total turnover, invoice count, hours, " +
      "contract value) for a given period. Reads from the precomputed " +
      "`customer_kpis` rollup — the SAME source the reports dashboard uses, " +
      "so numbers will match the UI exactly. ALWAYS prefer this tool over " +
      "search_invoices for questions like 'how much did we invoice in March', " +
      "'how many invoices last year', 'compare X to Y month'.\n\n" +
      "Three modes:\n" +
      "  - No customer scope → global rollup across all active customers " +
      "(set include_inactive=true to widen).\n" +
      "  - `customer_id` (single string) → one customer's numbers.\n" +
      "  - `customer_ids` (array) → BATCH mode. Returns aggregate totals AND " +
      "a `by_customer` array with one entry per customer — use this when " +
      "the user asks for per-customer numbers across a portfolio (e.g. " +
      "'show me each of Alice's customers' March numbers'). Do NOT call " +
      "this tool once per customer in a loop.",
    input_schema: {
      type: "object",
      properties: {
        year: {
          type: "integer",
          description: "Period year (e.g. 2026).",
          minimum: 2000,
          maximum: 3000,
        },
        month: {
          type: "integer",
          description:
            "Optional period month (1-12). Omit to get yearly rollup with " +
            "per-month breakdown in `by_month`.",
          minimum: 1,
          maximum: 12,
        },
        customer_id: {
          type: "string",
          description:
            "Optional single customer UUID. Use customer_ids for batch.",
        },
        customer_ids: {
          type: "array",
          description:
            "Optional array of customer UUIDs. When provided, the response " +
            "includes a `by_customer` breakdown alongside aggregate totals. " +
            "Prefer this over calling the tool once per customer.",
          items: { type: "string" },
        },
        include_inactive: {
          type: "boolean",
          description:
            "If true, includes inactive customers in the aggregation. " +
            "Default false (matches dashboard behavior of summing only " +
            "active customers).",
        },
        include_per_customer: {
          type: "boolean",
          description:
            "Force-include `by_customer` breakdown in the response. " +
            "Defaults to true when customer_id or customer_ids is set.",
        },
      },
      required: ["year"],
    },
  },
  {
    name: "get_kpi_by_consultant",
    description:
      "PORTFOLIO-scoped KPIs per consultant — turnover, invoice count, hours " +
      "and contract value summed across every customer assigned to the " +
      "consultant's Fortnox cost center.\n\n" +
      "Important field-level interpretation:\n" +
      "  • REVENUE (total_turnover, invoice_count, contract_value) IS the " +
      "    consultant's production. In a customer-manager model the " +
      "    consultant owns the customer relationship — their portfolio's " +
      "    invoiced revenue IS their personal output. There is no separate " +
      "    per-consultant revenue source. Label as 'omsättning' / " +
      "    'avtalsvärde'. DO NOT caveat as 'not personal production'.\n" +
      "  • HOURS (total_hours, customer_hours) here are time LOGGED ON THE " +
      "    CONSULTANT'S CUSTOMERS by anyone in the firm — NOT the " +
      "    consultant's own time reports. If the user wants the " +
      "    consultant's personally-reported hours, use " +
      "    get_consultant_personal_hours instead.\n\n" +
      "Use for portfolio-ranking questions: 'which consultant's portfolio " +
      "invoiced most', 'top 5 consultants by avtalsvärde', 'rank the team " +
      "by turnover'. Do NOT chain resolve_consultant + " +
      "get_consultant_customers + get_kpi_summary in a loop — this tool " +
      "does the whole thing in one call.\n\n" +
      "Note on shared cost centers: if multiple consultants share a Fortnox " +
      "cost center, their totals overlap (same KPI rows attributed to each, " +
      "flagged via `shared_cost_center: true`). Mention this caveat in the " +
      "answer when relevant.",
    input_schema: {
      type: "object",
      properties: {
        year: {
          type: "integer",
          description: "Period year (e.g. 2026).",
          minimum: 2000,
          maximum: 3000,
        },
        month: {
          type: "integer",
          description:
            "Optional period month (1-12). Omit for full-year aggregation.",
          minimum: 1,
          maximum: 12,
        },
        active_consultants_only: {
          type: "boolean",
          description:
            "If true (default), only consultants with profiles.is_active=true " +
            "are included.",
        },
        active_customers_only: {
          type: "boolean",
          description:
            "If true (default), only customers with status='active' " +
            "contribute to the totals (matches dashboard behaviour).",
        },
        limit: {
          type: "integer",
          description:
            "Cap on the number of consultants returned (top-N after " +
            "sorting). Default 30, max 200. Increase only if the user " +
            "explicitly wants a full ranking.",
          minimum: 1,
          maximum: 200,
        },
        sort_by: {
          type: "string",
          description: "Field to sort consultants by, descending. Default total_turnover.",
          enum: [
            "total_turnover",
            "invoice_count",
            "total_hours",
            "customer_hours",
            "contract_value",
            "customer_count",
          ],
        },
      },
      required: ["year"],
    },
  },
  {
    name: "get_consultant_personal_hours",
    description:
      "PERSONAL hours per consultant — the actually-reported time from " +
      "manager_time_kpis. This is what each consultant logged in Fortnox " +
      "during the period (customer/absence/internal/other), NOT a sum of " +
      "their portfolio's activity.\n\n" +
      "Use for personal-time questions: 'Hur många timmar har Klara " +
      "jobbat i år?', 'top 10 by personal hours', 'compare Klara's logged " +
      "hours to Derya's', 'hours X reported this month'.\n\n" +
      "Revenue is NOT here — per-consultant revenue does not exist as a " +
      "separate source. For revenue use get_kpi_by_consultant; that figure " +
      "IS the consultant's production via customer-manager ownership.\n\n" +
      "Label results as 'rapporterade timmar' / 'personliga timmar' / " +
      "'egen tid'. If the user's question is ambiguous between portfolio " +
      "hours and personal hours, ASK before picking.",
    input_schema: {
      type: "object",
      properties: {
        year: {
          type: "integer",
          description: "Period year (e.g. 2026).",
          minimum: 2000,
          maximum: 3000,
        },
        month: {
          type: "integer",
          description:
            "Optional period month (1-12). Omit for full-year aggregation.",
          minimum: 1,
          maximum: 12,
        },
        active_consultants_only: {
          type: "boolean",
          description:
            "If true (default), only consultants with profiles.is_active=true " +
            "are included.",
        },
        consultant_ids: {
          type: "array",
          description:
            "Optional list of consultant profile UUIDs (from " +
            "resolve_consultant). Omit to return all consultants the caller " +
            "can see.",
          items: { type: "string" },
        },
        limit: {
          type: "integer",
          description:
            "Cap on consultants returned (top-N after sorting). Default 30, " +
            "max 200.",
          minimum: 1,
          maximum: 200,
        },
        sort_by: {
          type: "string",
          description: "Field to sort by, descending. Default total_hours.",
          enum: [
            "total_hours",
            "customer_hours",
            "absence_hours",
            "internal_hours",
            "other_hours",
          ],
        },
      },
      required: ["year"],
    },
  },
  {
    name: "get_top_customers",
    description:
      "Return the top-N customers ranked by a chosen metric for a given " +
      "period, pre-sorted at the database level. ALWAYS use this for " +
      "ranking-shaped customer questions — 'top 10 most profitable', " +
      "'top 5 by turnover', 'highest-revenue customers this year', 'mest " +
      "lönsamma kunder', 'kunder med högst omsättning', etc. Never fetch a " +
      "full customer list and rank in your head — that overflows the " +
      "context window on real customer counts.\n\n" +
      "ALSO use this for THRESHOLD-shaped questions — 'customers with " +
      "contract value over 200 000 kr', 'kunder med avtalsvärde över X', " +
      "'med minst X kr i omsättning', 'more than X', etc. Pass `min_value` " +
      "with the threshold. Do NOT infer threshold matches from " +
      "get_kpi_summary.by_customer; that list is capped and may silently " +
      "exclude qualifying customers. Get the answer here.\n\n" +
      "Metrics:\n" +
      "  - 'turnover' (default) → total invoiced amount. Maps to both " +
      "'omsättning' and 'lönsamma' (colloquial Swedish business usage). " +
      "Pick this unless the user explicitly asks about margin/profitability " +
      "PER HOUR.\n" +
      "  - 'turnover_per_hour' → effective hourly rate (turnover ÷ hours). " +
      "Use only for explicit margin/profitability-per-engagement questions.\n" +
      "  - 'contract_value' → annualized recurring contract value (årsavtal). " +
      "Read live from contract_accruals (per-contract total_ex_vat × billing " +
      "frequency, summed per active contract). This is the truth — the " +
      "monthly KPI rollup understates it for many customers.\n" +
      "  - 'hours' → total billed hours.\n" +
      "  - 'invoice_count' → number of invoices.\n\n" +
      "Scope:\n" +
      "  - `year` is required. Optional `month` for monthly ranking. " +
      "(`month` has no effect for `contract_value` — contract value is a " +
      "stock metric, not a flow.)\n" +
      "  - Optional `consultant_id` to scope to one consultant's portfolio " +
      "(call resolve_consultant first).\n" +
      "  - Optional `min_value` — only customers whose metric value is " +
      "at least this number are included. Use for 'över X', 'minst X', " +
      "'more than X', 'with at least X' questions.\n" +
      "  - `n` defaults to 10, max 50. Use 5 or 10 unless the user asks " +
      "for a larger ranking.\n\n" +
      "Data sources: customer_kpis rollup for turnover/hours/invoice_count " +
      "(matches dashboard); contract_accruals live for contract_value.",
    input_schema: {
      type: "object",
      properties: {
        year: {
          type: "integer",
          description: "Period year (e.g. 2026).",
          minimum: 2000,
          maximum: 3000,
        },
        month: {
          type: "integer",
          description:
            "Optional period month (1-12). Omit for full-year ranking.",
          minimum: 1,
          maximum: 12,
        },
        metric: {
          type: "string",
          description:
            "Which metric to rank by. Default 'turnover'. See tool " +
            "description for when to use each.",
          enum: [
            "turnover",
            "turnover_per_hour",
            "contract_value",
            "hours",
            "invoice_count",
          ],
        },
        n: {
          type: "integer",
          description: "Number of customers to return (1-50). Default 10.",
          minimum: 1,
          maximum: 50,
        },
        consultant_id: {
          type: "string",
          description:
            "Optional consultant profile UUID (from resolve_consultant). " +
            "Restricts the ranking to that consultant's customer portfolio.",
        },
        active_only: {
          type: "boolean",
          description:
            "If true (default), only customers with status='active' are " +
            "ranked. Matches dashboard behaviour.",
        },
        min_value: {
          type: "number",
          description:
            "Optional threshold. Only customers whose metric value is at " +
            "least this number are returned. Use for threshold questions " +
            "('över X kr', 'med minst X', 'more than X', 'with at least X').",
          minimum: 0,
        },
      },
      required: ["year"],
    },
  },
  {
    name: "search_invoices",
    description:
      "Return RAW invoice rows filtered by customer and/or date range, " +
      "sorted newest first. Use this only for 'show me individual invoices' " +
      "/ 'list specific invoices' questions. Do NOT use for totals, counts " +
      "or KPIs — use get_kpi_summary instead. Turnover here is per-row " +
      "ex-VAT, but row-level totals will differ from the dashboard because " +
      "the dashboard's KPI rollup applies business filters (Licenser " +
      "exclusion etc.) at sync time, while this tool returns raw rows.",
    input_schema: {
      type: "object",
      properties: {
        customer_id: {
          type: "string",
          description: "Optional customer UUID.",
        },
        date_from: {
          type: "string",
          description: "Inclusive start date (YYYY-MM-DD).",
        },
        date_to: {
          type: "string",
          description: "Inclusive end date (YYYY-MM-DD).",
        },
        limit: {
          type: "integer",
          description:
            "Max rows to return (1-200). Default 25. For aggregate " +
            "questions ('total turnover for the year') always prefer " +
            "get_kpi_summary over fetching all rows — that's pre-aggregated " +
            "and matches the dashboard.",
          minimum: 1,
          maximum: 200,
        },
      },
    },
  },
  {
    name: "list_cost_centers",
    description:
      "List the firm's cost centers (Fortnox cost centers) with the number " +
      "of customers and consultants assigned to each. Use this for questions " +
      "like 'which cost centers do we have?' or 'how many customers in each " +
      "cost center?'. By default only active centers are returned — pass " +
      "active_only=false to include retired ones. Results capped at `limit` " +
      "(default 50, max 200); response includes `total_count` so you know " +
      "when the list is a truncated slice.",
    input_schema: {
      type: "object",
      properties: {
        active_only: {
          type: "boolean",
          description:
            "If true (default), only active cost centers are returned. Set " +
            "false to include inactive ones.",
        },
        limit: {
          type: "integer",
          description:
            "Max cost centers to return (1-200). Default 50. Raise only if " +
            "the user explicitly asks for the full list.",
          minimum: 1,
          maximum: 200,
        },
      },
    },
  },
  {
    name: "get_cost_center_details",
    description:
      "Drill into a single cost center: returns the cost center record plus " +
      "every customer and consultant assigned to it. Look up by `code` (the " +
      "Fortnox cost center code, e.g. '101') — call list_cost_centers first " +
      "if you don't know the code. Customers are paginated via " +
      "customer_limit (default 50); raise it for full lists.",
    input_schema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "The cost center code (e.g. '101', 'STO').",
        },
        customer_limit: {
          type: "integer",
          description: "Max customers to return (1-500). Default 50.",
          minimum: 1,
          maximum: 500,
        },
      },
      required: ["code"],
    },
  },
  {
    name: "resolve_consultant",
    description:
      "Look up a consultant / employee (a profile row) by name or email. " +
      "Returns up to `limit` candidates with id, full_name, email, role, " +
      "team_id, fortnox_cost_center and is_active so you can pick the right " +
      "person. Always call this first when the user references a consultant " +
      "by name (e.g. 'Alex Chaumon').",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Free-text fragment — full name or email. Case-insensitive " +
            "substring match.",
        },
        limit: {
          type: "integer",
          description: "Max candidates (1-20). Default 5.",
          minimum: 1,
          maximum: 20,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_consultant_customers",
    description:
      "Return every customer in a consultant's portfolio. Customers are " +
      "matched to consultants via Fortnox cost center (consultant's " +
      "profiles.fortnox_cost_center == customer.fortnox_cost_center). Use " +
      "this for questions like 'how many customers does X have?' or 'list " +
      "Y's clients'. Defaults to active customers only — set " +
      "active_only=false to include inactive.",
    input_schema: {
      type: "object",
      properties: {
        consultant_id: {
          type: "string",
          description:
            "Consultant profile UUID (from resolve_consultant.matches[].id).",
        },
        active_only: {
          type: "boolean",
          description:
            "If true (default), only customers with status='active' are " +
            "returned.",
        },
        limit: {
          type: "integer",
          description:
            "Max customers to return. Default 30, max 200. Raise only if " +
            "the user explicitly asks for a full list.",
          minimum: 1,
          maximum: 200,
        },
      },
      required: ["consultant_id"],
    },
  },
  {
    name: "get_churn_analysis",
    description:
      "Customer churn / retention / new-customer analysis between two date " +
      "windows, computed entirely in the database. ALWAYS use this for any " +
      "churn, retention, or new-customer question ('what's our churn rate?', " +
      "'kundtapp senaste året', 'how many customers did we lose/gain?', " +
      "'retention rate', 'churn vs last year').\n\n" +
      "Pass FOUR dates defining two windows:\n" +
      "  • period1 = the EARLIER / baseline window (period1_start, " +
      "period1_end).\n" +
      "  • period2 = the LATER / comparison window (period2_start, " +
      "period2_end).\n" +
      "Churn is measured moving period1 → period2.\n\n" +
      "DEFAULT (use unless the user specifies other dates): rolling 12 months " +
      "vs the previous 12 months, counted in FULLY COMPLETED calendar months " +
      "so neither window includes the current partial month. Let M = the most " +
      "recently completed month (the month before today's). Then period2 runs " +
      "from the first day of the month 11 months before M to the last day of M; " +
      "period1 is the 12 completed months immediately before period2. Example: " +
      "today 2026-06-01 → period2 = 2025-06-01..2026-05-31, period1 = " +
      "2024-06-01..2025-05-31.\n\n" +
      "Returns aggregate numbers only — never customer lists:\n" +
      "  - churned       → had revenue in period1 but not period2.\n" +
      "  - new_customers → had revenue in period2 but not period1.\n" +
      "  - retained      → had revenue in both.\n" +
      "  - churn_rate    → churned ÷ period1 customer base, as a percent.\n" +
      "  - total_period1 / total_period2 → ex-VAT revenue per window (SEK).\n\n" +
      "A customer counts as active in a window when their summed invoiced " +
      "amount in it is > 0. This is the ONLY correct path for churn — do NOT " +
      "fetch customer lists and diff them yourself.",
    input_schema: {
      type: "object",
      properties: {
        period1_start: {
          type: "string",
          description:
            "Earlier/baseline window start, YYYY-MM-DD (e.g. the start of " +
            "the previous 12 months).",
        },
        period1_end: {
          type: "string",
          description: "Earlier/baseline window end, YYYY-MM-DD.",
        },
        period2_start: {
          type: "string",
          description:
            "Later/comparison window start, YYYY-MM-DD (e.g. the start of " +
            "the most recent 12 months).",
        },
        period2_end: {
          type: "string",
          description:
            "Later/comparison window end, YYYY-MM-DD (usually today).",
        },
      },
      required: [
        "period1_start",
        "period1_end",
        "period2_start",
        "period2_end",
      ],
    },
  },
  {
    name: "get_churned_customers",
    description:
      "Drill-down companion to get_churn_analysis. Returns the ACTUAL LIST of " +
      "churned customers — those with revenue in period1 (earlier baseline) " +
      "but NOT period2 (later comparison) — instead of just the count. Use " +
      "this when the user asks WHICH customers churned, wants to SEE / LIST " +
      "the churned customers, or 'who did we lose?'.\n\n" +
      "Pass the SAME four dates as the get_churn_analysis call that produced " +
      "the count, so the list reconciles with the headline number (see " +
      "get_churn_analysis for how to derive the default rolling-12-vs-" +
      "previous-12 windows from completed months).\n\n" +
      "Each row has: customer_name, total_revenue_period1 (ex-VAT SEK), and " +
      "last_invoice_date (their most recent invoice within period1). Ordered " +
      "by period1 revenue descending, capped at 200 rows — if capped, the " +
      "response flags it; use get_churn_analysis for the exact total count.",
    input_schema: {
      type: "object",
      properties: {
        period1_start: {
          type: "string",
          description: "Earlier/baseline window start, YYYY-MM-DD.",
        },
        period1_end: {
          type: "string",
          description: "Earlier/baseline window end, YYYY-MM-DD.",
        },
        period2_start: {
          type: "string",
          description: "Later/comparison window start, YYYY-MM-DD.",
        },
        period2_end: {
          type: "string",
          description: "Later/comparison window end, YYYY-MM-DD.",
        },
      },
      required: [
        "period1_start",
        "period1_end",
        "period2_start",
        "period2_end",
      ],
    },
  },
  {
    name: "get_sie_kpis",
    description:
      "Return a single customer's SIE-derived FINANCIAL KPIs for a year — the " +
      "Nyckeltal numbers computed from their synced general ledger (SIE file). " +
      "Reads the SAME `sie_kpis` source the /key-metrics page shows, so figures " +
      "reconcile with the UI.\n\n" +
      `KPIs returned: ${SIE_KPI_KEY_HINT}.\n\n` +
      "Use for ledger/accounting questions about ONE customer: 'what's X's " +
      "soliditet / kassalikviditet / rörelseresultat / bruttomarginal', 'is X " +
      "profitable on the books', 'X:s nyckeltal'. Call resolve_customer first " +
      "to get the customer_id.\n\n" +
      "IMPORTANT: these are LEDGER-derived and DISTINCT from invoice turnover. " +
      "'Omsättning/revenue' here is the income-statement figure from the SIE " +
      "file, NOT the invoiced turnover from get_kpi_summary/get_top_customers — " +
      "do not mix them. If has_data is false, the customer has no synced SIE " +
      "file/KPIs for that year; say so (it does NOT mean zero).",
    input_schema: {
      type: "object",
      properties: {
        customer_id: {
          type: "string",
          description: "Customer UUID (from resolve_customer.matches[].id).",
        },
        year: {
          type: "integer",
          description: "Financial year (e.g. 2026). Defaults to current year.",
          minimum: 2000,
          maximum: 3000,
        },
        include_monthly: {
          type: "boolean",
          description:
            "Include the month-by-month trend for flow KPIs (revenue, gross " +
            "margin, EBIT). Default false. Use for 'how did X's revenue trend " +
            "over the year' questions.",
        },
      },
      required: ["customer_id"],
    },
  },
  {
    name: "rank_sie_kpis",
    description:
      "Rank / threshold / flag-filter customers by ONE SIE financial KPI for a " +
      "year. The SIE counterpart to get_top_customers, but for ledger-derived " +
      "KPIs rather than invoice turnover. Reads `sie_kpis` (matches " +
      "/key-metrics and the hit-list rules).\n\n" +
      `Allowed kpi_key: ${SIE_KPI_KEY_HINT}.\n\n` +
      "Examples:\n" +
      "  - 'which customers have negative EBIT' → kpi_key=ebit, flagged_only=true\n" +
      "  - 'lowest soliditet' → kpi_key=soliditet, order=asc\n" +
      "  - 'kassalikviditet under 100%' → kpi_key=kassalikviditet, max_value=100\n" +
      "  - 'highest ledger revenue' → kpi_key=revenue, order=desc\n\n" +
      "`flagged_only` selects customers breaching the KPI's healthy target " +
      "(e.g. EBIT < 0, kassalikviditet < 100%, soliditet < 30%). Always cite " +
      "`customers_with_kpi` as the coverage denominator — the ranking only " +
      "spans customers with a synced SIE file, not the whole customer base.",
    input_schema: {
      type: "object",
      properties: {
        kpi_key: {
          type: "string",
          description: "Which SIE KPI to rank by.",
          enum: SIE_KPI_KEYS,
        },
        year: {
          type: "integer",
          description: "Financial year (e.g. 2026). Defaults to current year.",
          minimum: 2000,
          maximum: 3000,
        },
        order: {
          type: "string",
          description:
            "Sort direction by value. 'desc' (default) = highest first; " +
            "'asc' = lowest first (use for 'worst'/'lowest' questions like " +
            "lowest soliditet or weakest liquidity).",
          enum: ["asc", "desc"],
        },
        flagged_only: {
          type: "boolean",
          description:
            "If true, only customers whose value breaches the KPI's target " +
            "(flagged=true) are returned. Use for 'which customers are at " +
            "risk / unprofitable / under the threshold'.",
        },
        min_value: {
          type: "number",
          description: "Only include customers whose value is >= this.",
        },
        max_value: {
          type: "number",
          description:
            "Only include customers whose value is <= this (e.g. " +
            "kassalikviditet <= 100).",
        },
        n: {
          type: "integer",
          description: "Number of customers to return (1-50). Default 10.",
          minimum: 1,
          maximum: 50,
        },
      },
      required: ["kpi_key"],
    },
  },
  {
    name: "get_sie_account_balance",
    description:
      "Look up specific account balances for ONE customer from their synced " +
      "SIE general ledger. Use for precise bookkeeping questions the KPIs " +
      "don't cover: 'what's X's cash at year end' (1910), 'balance of account " +
      "2081 / 3010', 'X:s kassa', 'saldo på konto 1510'. Call resolve_customer " +
      "first.\n\n" +
      "Pass explicit BAS account numbers in `accounts` (max 50). `kind`: 'ub' " +
      "= year-end (default), 'ib' = year-start, 'res' = result-account close.\n\n" +
      "SIGN WARNING: amounts are RAW SIE values. Credit-balanced BAS classes " +
      "(2 equity/liabilities, 3 income, 8 financial) are stored NEGATIVE — " +
      "negate them when stating revenue, equity, share capital or debt. Each " +
      "row includes account_class; read the sign_note in the response. For " +
      "ratio/whole-company health use get_sie_kpis instead.",
    input_schema: {
      type: "object",
      properties: {
        customer_id: {
          type: "string",
          description: "Customer UUID (from resolve_customer.matches[].id).",
        },
        accounts: {
          type: "array",
          description:
            "BAS account numbers to look up, e.g. ['1910','2081']. Max 50.",
          items: { type: "string" },
        },
        year: {
          type: "integer",
          description: "Financial year (e.g. 2026). Defaults to current year.",
          minimum: 2000,
          maximum: 3000,
        },
        kind: {
          type: "string",
          description:
            "'ub' = closing/year-end balance (default), 'ib' = opening/" +
            "year-start, 'res' = result-account closing.",
          enum: ["ib", "ub", "res"],
        },
      },
      required: ["customer_id", "accounts"],
    },
  },
  {
    name: "get_sie_account_trend",
    description:
      "Structured monthly or yearly ledger aggregates for ONE customer, " +
      "computed server-side from the SIE period balances (NOT raw " +
      "transactions). Use for trends and totals the year-end KPIs and " +
      "point-in-time balances don't cover:\n" +
      "  - 'how did X's revenue trend month by month' → account_class=3, " +
      "granularity=month (negate — class 3 is stored negative)\n" +
      "  - 'X:s totala personalkostnader i år' → account_class=7, granularity=year\n" +
      "  - 'monthly movement on account 1910' → accounts=['1910']\n" +
      "  - 'class 5 costs per account this year' → account_class=5, " +
      "granularity=year, per_account=true\n\n" +
      "Pick EXACTLY ONE selection: `accounts` (explicit numbers), " +
      "`account_class` (1-8), or `account_from`+`account_to` (range). Call " +
      "resolve_customer first.\n\n" +
      "SEMANTICS: values are monthly MOVEMENTS (psaldo), not running balances. " +
      "For income/cost accounts (3-8) the movement is the month's revenue/cost " +
      "(negate class 3 & 8). For balance-sheet accounts (1-2) it's the monthly " +
      "CHANGE — use get_sie_account_balance for actual balances. See sign_note.",
    input_schema: {
      type: "object",
      properties: {
        customer_id: {
          type: "string",
          description: "Customer UUID (from resolve_customer.matches[].id).",
        },
        accounts: {
          type: "array",
          description:
            "Explicit BAS account numbers (max 50; per-account monthly series " +
            "max 20). Mutually exclusive with account_class and the range.",
          items: { type: "string" },
        },
        account_class: {
          type: "integer",
          description:
            "Single BAS class 1-8 (1 assets, 2 equity/liabilities, 3 income, " +
            "4-7 costs, 8 financial). Mutually exclusive with accounts/range.",
          minimum: 1,
          maximum: 8,
        },
        account_from: {
          type: "string",
          description:
            "Inclusive range start, e.g. '3000'. Use WITH account_to. " +
            "Mutually exclusive with accounts/account_class.",
        },
        account_to: {
          type: "string",
          description: "Inclusive range end, e.g. '3999'. Use WITH account_from.",
        },
        year: {
          type: "integer",
          description: "Financial year (e.g. 2026). Defaults to current year.",
          minimum: 2000,
          maximum: 3000,
        },
        granularity: {
          type: "string",
          description:
            "'month' (default) → per-month series; 'year' → full-year sum.",
          enum: ["month", "year"],
        },
        per_account: {
          type: "boolean",
          description:
            "Break the result down per account instead of summing. With " +
            "granularity='month' requires an explicit `accounts` list (≤20).",
        },
        limit: {
          type: "integer",
          description: "Cap for per-account lists in year mode (1-200). Default 50.",
          minimum: 1,
          maximum: 200,
        },
      },
      required: ["customer_id"],
    },
  },
  {
    name: "get_hit_list_matches",
    description:
      "Run the Träfflista / hit-list rules engine — the same financial " +
      "warning/opportunity rules shown on the /hit-list page. Three modes:\n" +
      "  - customer_id → which rules a single company triggers (+ advisory " +
      "services + handling status).\n" +
      "  - rule_key → which companies match one rule, ranked.\n" +
      "  - neither → the whole hit list: every rule with its matching " +
      "companies.\n\n" +
      `Rules: ${HIT_LIST_RULE_HINT}.\n\n` +
      "Use for: 'vilka kunder är en akut likviditetsrisk', 'which companies " +
      "should we offer aktiekapital-minskning', 'is [customer] on the hit " +
      "list / why', 'visa träfflistan'. Each company carries its handling " +
      "`status` (under_hantering / hanterad / null). Cite " +
      "coverage.customers_with_sie_data as the denominator — the list only " +
      "spans customers with a synced SIE file.",
    input_schema: {
      type: "object",
      properties: {
        rule_key: {
          type: "string",
          description:
            "Restrict to one hit-list rule. Omit to evaluate all rules.",
          enum: HIT_LIST_RULE_KEYS,
        },
        customer_id: {
          type: "string",
          description:
            "Restrict to one customer — returns which rules that company " +
            "triggers. From resolve_customer.matches[].id.",
        },
        year: {
          type: "integer",
          description: "Financial year (e.g. 2026). Defaults to current year.",
          minimum: 2000,
          maximum: 3000,
        },
        limit: {
          type: "integer",
          description: "Max companies per rule (1-100). Default 25.",
          minimum: 1,
          maximum: 100,
        },
      },
    },
  },
  {
    name: "search_documents",
    description:
      "Vector search over the firm's uploaded documents — INCLUDING the " +
      "personnel policy / handbook, service descriptions, contracts, " +
      "internal notes, processes and any other PDF/DOCX uploaded by " +
      "admins.\n\n" +
      "CALL THIS for any question about:\n" +
      "  • Workplace / HR / office-life topics — food, snacks, allergies, " +
      "    alcohol, dress code, conduct, remote work, leave, vacation, " +
      "    parental leave, holidays, perks, expenses, travel, working " +
      "    hours, social events. Even casual phrasings ('Får jag äta nötter " +
      "    på kontoret', 'vad ska jag ha på mig', 'hur funkar semester') " +
      "    map to this tool — Saldo's handbook covers them.\n" +
      "  • Services, offerings, packages, internal processes, company " +
      "    info.\n" +
      "  • Anything where the answer might live in an uploaded document " +
      "    rather than the structured CRM tables.\n\n" +
      "Returns top matching chunks with file_name, document_type, " +
      "similarity score and an excerpt. If the top chunks have low " +
      "similarity or unrelated content, the handbook genuinely doesn't " +
      "cover the topic — say so and suggest asking a manager or HR. Do NOT " +
      "skip calling this tool just because you suspect the topic isn't in " +
      "the docs; you don't know until you search.\n\n" +
      "Combine with CRM tools when the answer needs both (e.g. 'what does " +
      "our standard accounting service include for [customer]?').",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Natural-language query to embed and search against. Use the " +
            "user's question (or a focused rephrasing of it).",
        },
        match_count: {
          type: "integer",
          description:
            "Max chunks to return. Default 6, max 8. Each chunk excerpt " +
            "is independently truncated to ~800 chars for token safety. " +
            "Raise toward 8 for broad handbook/policy questions where the " +
            "relevant passage might not be in the very top hits.",
          minimum: 1,
          maximum: 8,
        },
      },
      required: ["query"],
    },
  },
];

type AnyToolHandler = (
  input: unknown,
  context: ToolContext,
) => Promise<ToolResult>;

const HANDLERS: Record<string, AnyToolHandler> = {
  resolve_customer: resolveCustomer as AnyToolHandler,
  get_churn_analysis: getChurnAnalysis as AnyToolHandler,
  get_churned_customers: getChurnedCustomers as AnyToolHandler,
  get_customer_overview: getCustomerOverview as AnyToolHandler,
  get_kpi_summary: getKpiSummary as AnyToolHandler,
  get_kpi_by_consultant: getKpiByConsultant as AnyToolHandler,
  get_consultant_personal_hours: getConsultantPersonalHours as AnyToolHandler,
  get_top_customers: getTopCustomers as AnyToolHandler,
  search_invoices: searchInvoices as AnyToolHandler,
  list_cost_centers: listCostCenters as AnyToolHandler,
  get_cost_center_details: getCostCenterDetails as AnyToolHandler,
  resolve_consultant: resolveConsultant as AnyToolHandler,
  get_consultant_customers: getConsultantCustomers as AnyToolHandler,
  get_sie_kpis: getSieKpis as AnyToolHandler,
  rank_sie_kpis: rankSieKpis as AnyToolHandler,
  get_sie_account_balance: getSieAccountBalance as AnyToolHandler,
  get_sie_account_trend: getSieAccountTrend as AnyToolHandler,
  get_hit_list_matches: getHitListMatches as AnyToolHandler,
  search_documents: searchDocuments as AnyToolHandler,
};

/**
 * Dispatcher. Returns a JSON-serialisable result Claude can read back as a
 * tool_result block. Errors are returned as `{ error: string }` rather than
 * thrown, so a single bad tool call doesn't poison the whole turn.
 */
export async function executeTool(
  name: string,
  input: unknown,
  context: ToolContext,
): Promise<ToolResult> {
  const handler = HANDLERS[name];
  if (!handler) {
    return { error: `Unknown tool: ${name}` };
  }

  try {
    return await handler(input, context);
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Tool execution failed.",
    };
  }
}
