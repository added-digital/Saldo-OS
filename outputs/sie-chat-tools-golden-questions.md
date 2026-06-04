# SIE chat tools — golden-question checks (Phase 1)

Manual reconciliation set for `get_sie_kpis` and `rank_sie_kpis`. Both tools read
`sie_kpis` (period `YEAR`) — the same table the **/key-metrics (Nyckeltal)** and
**/hit-list (Träfflista)** pages render — so every answer must reconcile with the
UI for the same customer/year. Run these in the assistant against production after
deploy; each has a deterministic source of truth on screen.

## get_sie_kpis (single customer)

1. **"Vad är [Customer X]:s soliditet och kassalikviditet i år?"**
   - Expect: the exact soliditet/kassalikviditet shown for X on `/key-metrics`.
   - Check: numbers match the page cell; flagged KPIs match the warning badges.

2. **"Är [Customer X] lönsamt enligt bokföringen?"**
   - Expect: answer driven by `ebit` (Rörelseresultat); if negative it must be
     flagged and described as a loss, matching the X row's EBIT badge on `/key-metrics`.

3. **"[Customer with no synced SIE file] — visa nyckeltal."**
   - Expect: `has_data:false` → assistant says no synced SIE file/KPIs for that
     year. It must NOT report zeros, and must NOT confuse this with invoice turnover.

4. **Terminology trap: "Vad var [Customer X]:s omsättning i år?"**
   - Expect: assistant uses **invoice** turnover (get_kpi_summary), not the SIE
     `revenue` figure — or explicitly distinguishes the two. The ledger revenue
     (−Σ class 3) and invoiced turnover are different numbers; they must never be
     presented as interchangeable.

## rank_sie_kpis (cross-customer)

5. **"Vilka kunder har negativt rörelseresultat i år?"**
   - Tool: `kpi_key=ebit, flagged_only=true, order=asc`.
   - Expect: same set as `/hit-list` would show for an EBIT<0 rule and the
     flagged EBIT rows on `/key-metrics`. `customers_with_kpi` cited as denominator.

6. **"Vilka har lägst soliditet?"**
   - Tool: `kpi_key=soliditet, order=asc`.
   - Expect: bottom-N by soliditet on `/key-metrics`; values match the page.

7. **"Kunder med kassalikviditet under 100%."**
   - Tool: `kpi_key=kassalikviditet, max_value=100`.
   - Cross-check against the Träfflista "Akut likviditetsrisk" rule (which uses
     ≤70%) — the assistant's 100% list must be a superset of that rule's matches.

8. **Coverage honesty: "Hur ser nyckeltalen ut för alla kunder?"**
   - Expect: the assistant frames results as "X of Y customers with SIE data"
     using `customers_with_kpi`, never implying the full customer base is covered.

## get_sie_account_balance (Phase 2 — single customer)

9. **"Vad har [Customer X] i kassa vid årets slut?"** (account 1910/1930)
   - Tool: `accounts=['1910']` (+ other cash accounts), `kind=ub`.
   - Expect: a positive figure (assets, class 1 = stored positive). Cross-check
     against the SIE file's #UB row for that account if available.

10. **Sign trap: "Saldo på konto 3010 för [Customer X]?"** (an income account)
    - Expect: the assistant negates the raw value (class 3 stored negative) and
      states a positive revenue figure, guided by `sign_note`/`account_class`.
      It must NOT report the raw negative number as the balance.

11. **Missing account: "Saldo på konto 9999 för [Customer X]?"**
    - Expect: `found:false` for that account → assistant says the account isn't
      in the customer's chart / no data, not "0 kr".

## get_hit_list_matches (Phase 2 — Träfflista engine)

12. **"Vilka kunder är en akut likviditetsrisk?"**
    - Tool: `rule_key=acute_liquidity_risk`.
    - Expect: the SAME company set and order as the "Akut likviditetsrisk" row
      on `/hit-list`, including each company's handling status badge.

13. **"Är [Customer X] på träfflistan? Varför?"**
    - Tool: `customer_id=X`.
    - Expect: the rules X triggers with values + advisory services, matching
      what expanding those rules on `/hit-list` shows for X.

14. **"Visa hela träfflistan."**
    - Tool: no filter → all rules + counts.
    - Expect: per-rule `match_count` equals the count badge on each `/hit-list`
      row; `coverage.customers_with_sie_data` cited as the denominator.

15. **Status reconciliation:** mark a company "Hanterad" on `/hit-list`, then ask
    "vilka är redan hanterade på träfflistan?"
    - Expect: that company shows `status: "hanterad"` from `hit_list_statuses`.

## Invariants (no DB needed)

- `rank_sie_kpis` `kpi_key` and `get_hit_list_matches` `rule_key` enums are
  derived from `KPI_DEFINITIONS` / `HIT_LIST_RULES` in `index.ts`, so they
  cannot drift from the engine/rule registry.
- `get_hit_list_matches` reuses the page's own `ruleMatches` / `resolveValue`,
  so chat matches are identical to `/hit-list` by construction.
- Both tools format names/units/targets from `KPI_DEFINITIONS_BY_KEY`, so a KPI
  definition change propagates to chat automatically.
- SIE financial data is treated as firm-wide internal info: both tools read
  through the admin client (same pattern as `search_documents`), so answers
  span all customers with a synced ledger regardless of the asking user's
  portfolio scope. The `sie_kpis` table RLS and the admin-gated pages are
  unchanged — this is a chat-tool access decision only.
