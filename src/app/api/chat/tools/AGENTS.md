# CHAT TOOL KNOWLEDGE

## Scope
Applies to `src/app/api/chat/tools`.

## Overview
This directory registers Anthropic tool schemas and handlers for authenticated CRM assistant questions.

## Tool Registration
- Add schema definitions in `index.ts` and handler files beside existing tools.
- Tool names are snake_case.
- Export handlers with named exports.
- `executeTool` should return compact JSON-serializable results and convert tool failures to `{ error }`.

## Data Access
- Default to the RLS-scoped Supabase client from `ToolContext`.
- Use admin clients only for documented firm-wide data such as document chunk search.
- Clamp and normalize inputs: limits, years, months, search strings, and IDs.
- Batch where possible; do not loop one KPI tool call per customer when a batch mode exists.

## Reporting Rules
- KPI totals come from `customer_kpis` or dashboard-aligned rollups.
- `search_invoices` is for raw row listing, not totals or rankings.
- Use `total_ex_vat`, active customer filters, active contract policy, and Fortnox cost-center ownership consistently.

## Anti-Patterns
- Do not add verbose tool results that bloat model context.
- Do not bypass entity resolution when user input is ambiguous.
- Do not leak service-role-only fields or internal debug details.
