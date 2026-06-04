import { chunkArray } from "@/lib/reports";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  HIT_LIST_RULES,
  HIT_LIST_RULES_BY_KEY,
  accountsForRules,
  kpiKeysForRules,
  resolveValue,
  ruleMatches,
  type CustomerFinancials,
  type HitListRule,
} from "@/lib/fortnox-sie/hit-list-definitions";

import { drainPages } from "./contract-values";
import type { ToolHandler } from "./types";

/**
 * Expose the Träfflista / hit-list rules engine to chat.
 *
 * Same evaluation as the /hit-list page (reuses HIT_LIST_RULES, ruleMatches,
 * resolveValue) so answers reconcile with the UI exactly, plus the per-company
 * handling status from hit_list_statuses.
 *
 * Three modes:
 *   - customer_id set        → which rules this ONE company triggers.
 *   - rule_key set           → which companies match that rule (ranked).
 *   - neither                → the whole hit list: every rule + its matches.
 *
 * Admin/firm-wide read (the SIE tables and hit_list_statuses are admin-only
 * RLS), matching the other SIE chat tools. Coverage is bounded to customers
 * with a synced SIE file for the year.
 */

export type GetHitListMatchesInput = {
  rule_key?: string;
  customer_id?: string;
  year?: number | null;
  /** Max companies per rule. Default 25, max 100. */
  limit?: number | null;
};

type BalanceRow = {
  customer_id: string;
  account_number: string;
  kind: string;
  amount: number | string | null;
};

type KpiRow = {
  customer_id: string;
  kpi_key: string;
  value: number | string | null;
};

type StatusRow = {
  customer_id: string;
  rule_key: string;
  status: string;
};

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const CUSTOMER_ID_CHUNK = 200;

function toNumber(value: number | string | null): number | null {
  if (value == null) return null;
  const n = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(n) ? n : null;
}

function ruleMeta(rule: HitListRule) {
  return {
    rule_key: rule.key,
    name_sv: rule.names.sv,
    name_en: rule.names.en,
    summary_sv: rule.summary.sv,
    summary_en: rule.summary.en,
    value_label_sv: rule.valueLabel.sv,
    value_label_en: rule.valueLabel.en,
    value_unit: rule.valueUnit,
  };
}

export const getHitListMatches: ToolHandler<GetHitListMatchesInput> = async (
  input,
) => {
  const supabase = createAdminClient();

  const year =
    input.year != null ? Math.trunc(Number(input.year)) : new Date().getFullYear();
  if (!Number.isInteger(year) || year < 2000 || year > 3000) {
    return { error: "`year` must be a sensible integer (e.g. 2026)." };
  }
  const financialYearFrom = `${year}-01-01`;

  const limit =
    typeof input.limit === "number" && Number.isInteger(input.limit) && input.limit > 0
      ? Math.min(input.limit, MAX_LIMIT)
      : DEFAULT_LIMIT;

  const ruleKey = input.rule_key?.trim();
  if (ruleKey && !HIT_LIST_RULES_BY_KEY[ruleKey]) {
    return {
      error:
        `Unknown rule_key '${ruleKey}'. Allowed: ` +
        `${HIT_LIST_RULES.map((r) => r.key).join(", ")}.`,
    };
  }
  const customerId = input.customer_id?.trim() || null;

  // Which rules are in play (one, or all).
  const rules = ruleKey ? [HIT_LIST_RULES_BY_KEY[ruleKey]] : HIT_LIST_RULES;

  // ---------------------------------------------------------------------------
  // Load the financials these rules read — account balances + YEAR KPIs.
  // Paginated (drainPages) because account 2081's ub/ib across every synced
  // customer can exceed PostgREST's 1000-row cap.
  // ---------------------------------------------------------------------------
  const accounts = accountsForRules(rules);
  const kpiKeys = kpiKeysForRules(rules);

  const finByCustomer = new Map<string, CustomerFinancials>();
  const finFor = (id: string): CustomerFinancials => {
    let fin = finByCustomer.get(id);
    if (!fin) {
      fin = { accounts: new Map(), kpis: new Map() };
      finByCustomer.set(id, fin);
    }
    return fin;
  };

  if (accounts.length > 0) {
    const { rows, error } = await drainPages<BalanceRow>(() => {
      let q = supabase
        .from("sie_account_balances")
        .select("customer_id, account_number, kind, amount")
        .eq("financial_year_from", financialYearFrom)
        .in("kind", ["ub", "ib"])
        .in("account_number", accounts);
      if (customerId) q = q.eq("customer_id", customerId);
      return q;
    });
    if (error) return { error };
    for (const row of rows) {
      const map = finFor(row.customer_id).accounts;
      let entry = map.get(row.account_number);
      if (!entry) {
        entry = { ub: null, ib: null };
        map.set(row.account_number, entry);
      }
      const amount = toNumber(row.amount);
      if (row.kind === "ub") entry.ub = amount;
      else if (row.kind === "ib") entry.ib = amount;
    }
  }

  if (kpiKeys.length > 0) {
    const { rows, error } = await drainPages<KpiRow>(() => {
      let q = supabase
        .from("sie_kpis")
        .select("customer_id, kpi_key, value")
        .eq("financial_year_from", financialYearFrom)
        .eq("period", "YEAR")
        .in("kpi_key", kpiKeys);
      if (customerId) q = q.eq("customer_id", customerId);
      return q;
    });
    if (error) return { error };
    for (const row of rows) {
      finFor(row.customer_id).kpis.set(row.kpi_key, toNumber(row.value));
    }
  }

  // ---------------------------------------------------------------------------
  // Evaluate. rawMatches[ruleKey] = [{ customerId, value }], sorted later.
  // ---------------------------------------------------------------------------
  const rawMatches = new Map<string, Array<{ customerId: string; value: number | null }>>();
  const matchedCustomerIds = new Set<string>();
  for (const rule of rules) {
    const list: Array<{ customerId: string; value: number | null }> = [];
    for (const [cid, fin] of finByCustomer) {
      if (!ruleMatches(rule, fin)) continue;
      list.push({ customerId: cid, value: resolveValue(rule.displayValue, fin) });
      matchedCustomerIds.add(cid);
    }
    const dir = rule.sort === "asc" ? 1 : -1;
    list.sort((a, b) => ((a.value ?? 0) - (b.value ?? 0)) * dir);
    rawMatches.set(rule.key, list);
  }

  // ---------------------------------------------------------------------------
  // Resolve names + handling statuses for the matched companies.
  // ---------------------------------------------------------------------------
  const nameById = new Map<
    string,
    { name: string; fortnox_customer_number: string | null }
  >();
  const statusByKey = new Map<string, string>(); // `${ruleKey}|${customerId}`

  if (matchedCustomerIds.size > 0) {
    const ids = Array.from(matchedCustomerIds);
    for (const chunk of chunkArray(ids, CUSTOMER_ID_CHUNK)) {
      const { data } = await supabase
        .from("customers")
        .select("id, name, fortnox_customer_number")
        .in("id", chunk);
      for (const c of (data ?? []) as unknown as Array<{
        id: string;
        name: string;
        fortnox_customer_number: string | null;
      }>) {
        nameById.set(c.id, {
          name: c.name,
          fortnox_customer_number: c.fortnox_customer_number,
        });
      }
    }

    for (const chunk of chunkArray(ids, CUSTOMER_ID_CHUNK)) {
      let sq = supabase
        .from("hit_list_statuses")
        .select("customer_id, rule_key, status")
        .in("customer_id", chunk);
      if (ruleKey) sq = sq.eq("rule_key", ruleKey);
      const { data } = await sq;
      for (const s of (data ?? []) as unknown as StatusRow[]) {
        statusByKey.set(`${s.rule_key}|${s.customer_id}`, s.status);
      }
    }
  }

  const companyEntry = (ruleKeyForStatus: string, m: { customerId: string; value: number | null }) => {
    const info = nameById.get(m.customerId);
    return {
      customer_id: m.customerId,
      customer_name: info?.name ?? null,
      fortnox_customer_number: info?.fortnox_customer_number ?? null,
      value: m.value,
      status: statusByKey.get(`${ruleKeyForStatus}|${m.customerId}`) ?? null,
    };
  };

  const coverage = {
    customers_with_sie_data: finByCustomer.size,
    year,
  };

  // ---------------------------------------------------------------------------
  // Mode 1 — single customer: which rules does this company trigger?
  // ---------------------------------------------------------------------------
  if (customerId) {
    const triggered = rules
      .filter((rule) =>
        (rawMatches.get(rule.key) ?? []).some((m) => m.customerId === customerId),
      )
      .map((rule) => {
        const m = (rawMatches.get(rule.key) ?? []).find(
          (x) => x.customerId === customerId,
        )!;
        return {
          ...ruleMeta(rule),
          value: m.value,
          status: statusByKey.get(`${rule.key}|${customerId}`) ?? null,
          advisory_services: rule.advisoryServices,
        };
      });

    const info = nameById.get(customerId);
    return {
      mode: "customer",
      customer_id: customerId,
      customer_name: info?.name ?? null,
      year,
      has_sie_data: finByCustomer.has(customerId),
      triggered_rules: triggered,
      triggered_count: triggered.length,
      rules_evaluated: rules.map((r) => r.key),
      note:
        finByCustomer.has(customerId)
          ? undefined
          : "This customer has no synced SIE data for the year, so no rules " +
            "could be evaluated. Absence of matches here does NOT mean the " +
            "company is healthy.",
      source: "hit-list rules evaluated over sie_account_balances + sie_kpis.",
    };
  }

  // ---------------------------------------------------------------------------
  // Mode 2 — single rule: which companies match it?
  // ---------------------------------------------------------------------------
  if (ruleKey) {
    const rule = HIT_LIST_RULES_BY_KEY[ruleKey];
    const all = rawMatches.get(ruleKey) ?? [];
    const companies = all.slice(0, limit).map((m) => companyEntry(ruleKey, m));
    return {
      mode: "rule",
      ...ruleMeta(rule),
      advisory_services: rule.advisoryServices,
      year,
      match_count: all.length,
      companies,
      coverage,
      ...(all.length > companies.length
        ? {
            _compacted: [
              {
                field: "companies",
                total_count: all.length,
                shown_count: companies.length,
                note: "More companies match — raise `limit` (max 100).",
              },
            ],
          }
        : {}),
      source: "hit-list rule evaluated over sie_account_balances + sie_kpis.",
    };
  }

  // ---------------------------------------------------------------------------
  // Mode 3 — all rules: counts + capped match lists.
  // ---------------------------------------------------------------------------
  const ruleResults = rules.map((rule) => {
    const all = rawMatches.get(rule.key) ?? [];
    const companies = all.slice(0, limit).map((m) => companyEntry(rule.key, m));
    return {
      ...ruleMeta(rule),
      match_count: all.length,
      companies,
      ...(all.length > companies.length
        ? {
            _compacted: [
              {
                field: "companies",
                total_count: all.length,
                shown_count: companies.length,
                note:
                  "More companies match — query this rule_key directly with a " +
                  "higher limit.",
              },
            ],
          }
        : {}),
    };
  });

  return {
    mode: "all",
    year,
    rules: ruleResults,
    coverage,
    source: "hit-list rules evaluated over sie_account_balances + sie_kpis.",
  };
};
