# DASHBOARD KNOWLEDGE

## Scope
This file applies to `src/app/(dashboard)` and its subdirectories unless a deeper `AGENTS.md` overrides it.

## Purpose
- Dashboard pages provide operational CRM workflows (reports, customers, users, settings).
- Prioritize fast scanning, clear state, and consistent table/list behavior.

## Entry Points
- `src/app/(dashboard)/page.tsx` is the URL root page because `(dashboard)` is a route group.
- `layout.tsx` loads the authenticated profile with the server Supabase client and wraps `DashboardShell`.
- Shared app UI comes from `src/components/app`; shared shell/navigation comes from `src/components/layout`.

## UI and Interaction Rules
- Reuse existing UI primitives and shared components from `src/components/ui` and `src/components/app`.
- Keep terminology consistent: use "cost center".
- Reports module lists should follow the same list style as the rest of report view modules.
- Avoid adding unnecessary wrappers or nested card patterns when existing modules use simpler section layout.
- Keep filter controls and KPI context concise; place contextual counters close to filter controls when applicable.
- Use `PageHeader`, `DataTable`, `KpiCards`, `EmptyState`, `LoadingState`, `ActionBar`, and existing dialog patterns before inventing new page-local primitives.
- Prefer `useTranslation` with fallback strings for visible dashboard copy.

## Data Display Rules
- Prefer ex-VAT turnover values (`total_ex_vat`) whenever available.
- Month labels should be English 3-letter format with leading capital letter.
- For unknown cost center fallback text, include identifier when available.
- Contract-related KPI totals should represent active contracts.
- Customer list pages default to active customers unless a filter explicitly widens scope.
- Local storage keys should be stable and namespaced for the page/domain.

## Next.js App Router Rules
- `page.tsx` and `layout.tsx` may use default export; other modules should use named exports.
- Match existing async route params typing conventions used in this codebase.

## Editing Guidance
- Keep pages focused: move repeated logic to shared helpers/components when already patterned nearby.
- Do not introduce visual styles that conflict with existing dashboard spacing/typography decisions.
- Keep comments minimal and only where logic is non-obvious.
- Reports, mail, and settings pages are large hotspots; extract helpers instead of expanding page bodies when behavior repeats.

## Verification
- Run diagnostics for modified files.
- Run relevant tests for touched behavior.
- Run project typecheck/build when changes affect shared UI or data flow.
