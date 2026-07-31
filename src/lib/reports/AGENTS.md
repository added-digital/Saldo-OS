# REPORTING LIB KNOWLEDGE

## Scope
Applies to `src/lib/reports`.

## Overview
Reporting helpers back the dashboard reports page and API/chat KPI tools. Keep business rules here instead of growing `src/app/(dashboard)/reports/page.tsx`.

## Structure
| File | Role |
|------|------|
| `index.ts` | Barrel exports. |
| `types.ts` | Report row, filter, metric, and option types. |
| `constants.ts` | Storage keys, page sizes, aliases, article group defaults, chart config. |
| `formatters.ts` | SEK/hour formatters, month labels, normalization, chart scaling, chunking. |
| `windows.ts` | Month keys, reporting windows, default month, sorting. |
| `turnover.ts` | Strict ex-VAT invoice mapping. |
| `hours.ts` | Time-report metric classification. |
| `accruals.ts` | Contract total annualization. |

## Data Rules
- Use `total_ex_vat` for turnover; do not fall back to gross `total` unless the UI explicitly labels that difference.
- Contract KPI totals use active contracts only.
- Customer matching may require both `customer_id` and Fortnox customer number.
- Deduplicate invoice aggregates by invoice id when joining through row/detail data.
- Ownership/manager mapping flows through `fortnox_cost_center` where no direct FK exists.
- Default article-group reporting excludes `Licenser` and handles unmapped groups explicitly.

## Time And Month Rules
- Reporting windows are current month, rolling 12 months, and rolling year.
- Default selected reports month is the previous month.
- Time metrics classify `time`, `absence`, `internal`, other, and total.
- Dashboard report month labels use English 3-letter style with leading capital letter.

## Editing Guidance
- Add new report types and helper functions here before expanding `reports/page.tsx`.
- Keep helper outputs serializable and usable from both dashboard and API/chat tools.
- Preserve existing localStorage keys such as `reports.filters.v1` unless coordinating migrations.
