# PROJECT KNOWLEDGE BASE

**Generated:** 2026-05-04
**Commit:** 4c6eaa4
**Branch:** main

## OVERVIEW
Saldo CRM is a white-label internal operations CRM built with Next.js App Router, React 19, TypeScript, Tailwind CSS 4, shadcn/Radix UI, and Supabase. Core domains: dashboard reporting, customers/contacts, mail, Fortnox sync, document AI, and operational settings.

## STRUCTURE
```
Saldo-CRM/
├── src/app/                 # App Router routes; root page lives in (dashboard)
├── src/components/          # ui primitives, app compositions, dashboard layout
├── src/config/              # white-label, navigation, scopes, i18n
├── src/hooks/               # client providers and browser/data hooks
├── src/lib/                 # Supabase, Fortnox, reporting, sync, validation helpers
├── src/styles/theme.css     # OKLCH design token source of truth
├── src/types/               # database and Fortnox type surfaces
└── supabase/                # migrations, seed, Edge Functions, local config
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| App startup/auth | `src/app/layout.tsx`, `src/app/(dashboard)/layout.tsx`, `src/middleware.ts` | Dashboard root route is `src/app/(dashboard)/page.tsx`, not `src/app/page.tsx`. |
| Dashboard pages | `src/app/(dashboard)` | Existing scoped guidance applies. Reports/mail/settings are the largest hotspots. |
| API routes | `src/app/api` | Existing scoped guidance applies; chat/questions/documents/sync have deeper rules. |
| Shared components | `src/components` | Preserve `ui`/`app`/`layout` layering. |
| Supabase app clients | `src/lib/supabase` | Browser/server/admin split. |
| Reporting logic | `src/lib/reports`, `src/app/(dashboard)/reports/page.tsx` | Prefer extracting repeated logic from the large page. |
| White-label config | `src/config/system.ts`, `src/styles/theme.css`, `public/brand` | README deployment customization points. |
| DB schema/RLS | `supabase/migrations` | Numeric migrations, RLS helpers, pgvector, sync queue, mail/doc tables. |
| Edge sync | `supabase/functions` | Deno sync steps and shared Fortnox helpers. |

## CODE MAP
LSP codemap unavailable: `typescript-language-server` is not installed in this environment.

| Area | Location | Role |
|------|----------|------|
| Dashboard shell | `src/components/layout/dashboard-shell.tsx` | Wraps profile, sync, sidebar, topbar providers. |
| Table primitive | `src/components/app/data-table.tsx` | Shared TanStack table, search, sorting, selection, navigation. |
| Reports utilities | `src/lib/reports/index.ts` | Barrel for reporting constants, types, windows, formatters, turnover, hours, accruals. |
| Supabase server client | `src/lib/supabase/server.ts` | Async cookie-backed server client. |
| Supabase admin client | `src/lib/supabase/admin.ts` | Service-role client; keep server-only. |
| Chat tool registry | `src/app/api/chat/tools/index.ts` | Anthropic tool schemas and handler dispatch. |
| Sync shared helpers | `supabase/functions/_shared/sync-helpers.ts` | Sync job updates, Fortnox token refresh, CORS. |

## CONVENTIONS
- Use TypeScript strictly. Do not use `as any`, `@ts-ignore`, or `@ts-expect-error`.
- Prefer named exports except `page.tsx` and `layout.tsx` default exports.
- Use `@/*` imports for `src/*` modules.
- Client-visible environment variables must use `NEXT_PUBLIC_`.
- Use async server Supabase client creators and sync client-side creators according to the existing utility split.
- For Supabase insert/update/upsert calls, follow the existing `as never` convention where required.
- Route params in pages/layouts should follow the async params shape already used in the codebase.
- Follow existing formatting in touched files; there is no Prettier/Biome/EditorConfig.
- Docs use pnpm commands, but both `pnpm-lock.yaml` and `package-lock.json` exist; avoid lockfile churn.
- i18n: every user-facing string uses `t("scope.key", "English fallback")` from `useTranslation`, AND the key must be added to both the `en` and `sv` dictionaries in `src/config/i18n.ts`. Missing `sv` entries are bugs. Applies to placeholders, toasts, empty states, aria-labels.

## DATA RULES
- Turnover values should use ex-VAT source fields, especially `total_ex_vat`, when available.
- Contract totals and KPIs should be based on active contracts only.
- UI labels say "cost center", not "contributor".
- Reporting ownership maps through Fortnox cost centers where no direct FK exists.
- Month labels in dashboard reports use English 3-letter style with leading capital letter.

## ANTI-PATTERNS (THIS PROJECT)
- Do not expose service-role credentials or provider payload dumps in client-visible code/routes.
- Do not add one-off UI patterns before checking `src/components/ui` and `src/components/app`.
- Do not grow large page/route hotspots when repeated logic belongs in `src/lib` or scoped helpers.
- Do not use raw invoice rows for KPI totals when `customer_kpis` or report rollups are the dashboard source.
- Do not log secrets, OAuth tokens, sensitive personal data, or full Fortnox/Microsoft payloads.

## UNIQUE STYLES
- shadcn/ui uses `new-york`, Radix wrappers, Lucide icons, `data-slot`, `cn()`, and Tailwind CSS 4 variables.
- Theme tokens live in `src/styles/theme.css` using OKLCH and are bridged in `src/app/globals.css`.
- Dashboard UI is dark-first, compact, table-heavy, and built from simple cards/sections.
- Supabase Edge Functions are Deno files excluded from root `tsconfig.json`.

## COMMANDS
```bash
pnpm dev
pnpm lint
pnpm build
pnpm script:check-i18n
pnpm supabase db push
supabase functions deploy
```

## VERIFICATION
- Run diagnostics for changed TypeScript/TSX files when LSP is available.
- Run relevant request simulations or dry-runs for API, sync, and mail behavior.
- Run `pnpm lint` and `pnpm build` for shared UI, routing, data-flow, or type changes.
- No formal test runner is configured; use targeted manual/API verification where needed.

## NOTES
- README references `.env.example`, but no `.env.example` exists in this checkout.
- `package.json` references `scripts/*.ts`, while `/scripts/` is ignored and absent in this checkout.
- `vercel.json` is empty; deployment likely relies on Vercel dashboard defaults.
