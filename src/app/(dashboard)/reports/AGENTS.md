# DASHBOARD REPORTS KNOWLEDGE

## Scope
Applies to `src/app/(dashboard)/reports`.

## Overview
Reports are the largest dashboard hotspot. Keep new business rules in `src/lib/reports` when possible instead of growing `page.tsx`.

## Where To Look
| Task | Location |
|------|----------|
| Main page | `page.tsx` |
| Shared report helpers | `src/lib/reports` |
| KPI cards | `src/components/app/kpi-cards.tsx` |
| Shared table | `src/components/app/data-table.tsx` |

## Data Rules
- Use `total_ex_vat` for turnover and label any exception clearly.
- Contract KPI totals use active contracts only.
- Customer matching may require both `customer_id` and Fortnox customer number.
- Deduplicate invoice aggregates by invoice id when joining detail/row data.
- Ownership and manager filters use `fortnox_cost_center` when no direct FK exists.
- Default article-group reporting excludes `Licenser` and handles unmapped groups explicitly.

## UI Rules
- Use existing report section/list style; avoid extra wrapper cards when sibling sections are simple.
- Keep filter controls compact and put contextual counts near filters.
- Month labels use English 3-letter style with leading capital letter.
- Use shared `DataTable`, `KpiCards`, `EmptyState`, and chart primitives.

## Editing Guidance
- Extract repeated Supabase paging/chunking and row mapping into `src/lib/reports`.
- Preserve `reports.filters.v1` unless coordinating localStorage migration behavior.
- Keep API/chat reporting tools aligned when changing shared report calculations.
- Prefer focused helper additions over broad page-level rewrites.
