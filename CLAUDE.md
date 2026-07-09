<# Saldo CRM — Claude Code Guide

## Tech Stack

- **Framework:** Next.js 16.1.6, React 19, TypeScript 5
- **Styling:** Tailwind CSS v4 (PostCSS), no `tailwind.config.js` — configured via `@theme` in `src/app/globals.css`
- **UI Primitives:** Radix UI + shadcn/ui (New York style)
- **Icons:** Lucide React (`lucide-react`)
- **Data Fetching:** Supabase (PostgreSQL)
- **Forms:** React Hook Form + Zod
- **Tables:** TanStack React Table v8
- **Animations:** GSAP, tw-animate-css, @number-flow/react
- **Charts:** Recharts v3.8
- **Notifications:** Sonner v2
- **Theme:** next-themes (light/dark via `data-theme` attribute)

---

## Project Structure

```
src/
├── app/                  # Next.js App Router pages
│   ├── (auth)/           # Auth route group
│   ├── (dashboard)/      # Dashboard route group
│   ├── api/              # API routes
│   ├── globals.css       # Global styles + Tailwind @theme config
│   └── layout.tsx        # Root layout
├── components/
│   ├── ui/               # 25 shadcn/ui primitives
│   ├── layout/           # Sidebar, topbar, breadcrumbs, shell
│   └── app/              # Domain-specific components
├── styles/
│   └── theme.css         # All CSS design tokens (OKLCH variables)
├── lib/
│   ├── utils.ts          # cn(), formatters, helpers
│   ├── supabase/         # Supabase client
│   ├── fortnox/          # Fortnox API
│   ├── mail/             # Email service
│   └── validations/      # Zod schemas
├── hooks/                # Custom React hooks
├── config/               # navigation.ts, system.ts, scopes.ts
├── types/                # TypeScript types
└── emails/               # React Email templates
public/
└── brand/                # logo.svg, logo-mark.svg
```

**Path alias:** `@/*` → `src/*`

---

## Design Token System

All tokens are defined in `src/styles/theme.css` using **OKLCH color space** CSS variables. They are imported into `src/app/globals.css` and mapped to Tailwind via `@theme inline`.

### Colors

```css
/* Brand */
--color-brand-primary: oklch(0.78 0.09 80);
--color-brand-primary-hover: oklch(0.72 0.09 80);
--color-brand-primary-subtle: oklch(0.30 0.03 80);

/* Semantic */
--color-success: oklch(0.65 0.12 145);
--color-warning: oklch(0.75 0.14 85);
--color-error: oklch(0.60 0.18 25);
--color-info: oklch(0.65 0.12 250);

/* Backgrounds (dark-first) */
--color-bg-primary: oklch(0.18 0 0);
--color-bg-secondary: oklch(0.24 0 0);
--color-bg-tertiary: oklch(0.28 0 0);
--color-bg-inverse: oklch(1 0 0);

/* Text */
--color-text-primary: oklch(0.98 0 0);
--color-text-secondary: oklch(0.78 0 0);
--color-text-tertiary: oklch(0.60 0 0);
--color-text-on-brand: oklch(0.18 0 0);

/* Borders */
--color-border-default: oklch(0.30 0 0);
--color-border-strong: oklch(0.40 0 0);
--color-border-brand: var(--color-brand-primary);
```

shadcn/ui bridge variables (`--background`, `--foreground`, `--primary`, etc.) are also defined in `theme.css` and automatically available.

### Spacing

```css
--space-page-x: 1.5rem;
--space-page-y: 1.5rem;
--space-section-gap: 2rem;
--space-card-padding: 1.5rem;
--sidebar-width: 16rem;
--sidebar-width-collapsed: 4.5rem;
```

### Border Radius

```css
--radius-sm: 0.375rem;   /* 6px */
--radius-md: 0.5rem;     /* 8px */
--radius-lg: 0.75rem;    /* 12px */
--radius-xl: 1rem;       /* 16px */
--radius-full: 9999px;
```

### Shadows

```css
--shadow-sm: 0 1px 2px oklch(0 0 0 / 0.25);
--shadow-md: 0 4px 6px -1px oklch(0 0 0 / 0.35);
--shadow-lg: 0 10px 25px -3px oklch(0 0 0 / 0.45);
```

### Typography

```css
/* Fonts */
--font-geist-sans  /* sans-serif, via Google Fonts */
--font-geist-mono  /* monospace, via Google Fonts */

/* Sizes: --text-xs (0.75rem) → --text-3xl (1.875rem) */
/* Weights: 400, 500, 600, 700 */
/* Line heights: 1.25 (tight), 1.5 (normal), 1.625 (relaxed) */
```

### Animation

```css
--duration-fast: 100ms;
--duration-normal: 200ms;
--duration-slow: 300ms;
--easing-default: cubic-bezier(0.4, 0, 0.2, 1);
```

---

## i18n / Translations

All user-facing UI text goes through `t()` from `useTranslation` (`@/hooks/use-translation`):

```tsx
const { t } = useTranslation()
t("leads.add.title", "Add lead") // key + English fallback
```

**Mandatory when adding or changing any UI string:**

1. Call `t("scope.key", "English fallback")` — never hardcode display text.
2. Add the key to **both** the `en` and `sv` dictionaries in `src/config/i18n.ts`. The fallback keeps things working, but Swedish users see English until the `sv` key exists — a missing `sv` entry is a bug, not a nice-to-have.
3. Key naming: `area.subarea.name` (e.g. `leads.activity.logFailed`), matching the existing dictionary grouping.
4. This applies to placeholders, toasts, empty states, aria-labels, dialog descriptions — every string a user can see.

---

## Styling Conventions

### 1. Class Merging — always use `cn()`

```typescript
import { cn } from "@/lib/utils"

<div className={cn("base-classes", conditional && "conditional-class", className)} />
```

### 2. Variants — use `class-variance-authority` (CVA)

```typescript
import { cva, type VariantProps } from "class-variance-authority"

const buttonVariants = cva("base-classes", {
  variants: {
    variant: { default: "...", outline: "..." },
    size: { sm: "...", md: "...", lg: "..." },
  },
  defaultVariants: { variant: "default", size: "md" },
})
```

### 3. Data attributes for semantic CSS hooks

Components include `data-slot` and `data-variant` attributes:

```tsx
<button data-slot="button" data-variant={variant} ... />
<div data-slot="card" ... />
```

### 4. Dark mode

Use `data-theme="dark"` selector (set by next-themes). Do **not** use Tailwind's `dark:` prefix — all dark mode overrides are in `theme.css`.

---

## Component Patterns

### UI Primitives (`src/components/ui/`)

Built on Radix UI. Available: `alert-dialog`, `avatar`, `badge`, `button`, `card`, `chart`, `checkbox`, `collapsible`, `command`, `dialog`, `dropdown-menu`, `form`, `input`, `label`, `popover`, `select`, `separator`, `sheet`, `skeleton`, `sonner`, `switch`, `table`, `tabs`, `textarea`, `tooltip`.

### Button

```tsx
import { Button } from "@/components/ui/button"

// Variants: default | destructive | outline | secondary | ghost | link
// Sizes: xs | sm | default | lg | icon | icon-xs | icon-sm | icon-lg
<Button variant="outline" size="sm">Label</Button>
```

### Card

```tsx
import { Card, CardHeader, CardTitle, CardDescription, CardAction, CardContent, CardFooter } from "@/components/ui/card"

<Card>
  <CardHeader>
    <CardTitle>Title</CardTitle>
    <CardDescription>Description</CardDescription>
    <CardAction>...</CardAction>
  </CardHeader>
  <CardContent>...</CardContent>
  <CardFooter>...</CardFooter>
</Card>
```

### Form Fields

Use the `FormField` app component for consistent form layout, or compose with `react-hook-form` + Zod + shadcn `Form` primitives.

---

## Icon System

```tsx
import { ChevronDown, PanelLeftOpen } from "lucide-react"

// Always size via className, never width/height props
<ChevronDown className="size-4" />
```

Icons are Lucide React (575+ icons). The icon library is configured as `"lucide"` in `components.json`.

---

## Asset Paths

| Asset | Path |
|-------|------|
| Logo (full) | `/brand/logo.svg` |
| Logo mark | `/brand/logo-mark.svg` |
| Brand color | `oklch(0.78 0.09 80)` ≈ `#EABF89` |

System metadata in `src/config/system.ts`.

---

## Figma → Code Integration Notes

When implementing Figma designs:

1. **Colors:** Map Figma fills to the nearest token in `theme.css`. Prefer semantic tokens (`--color-bg-secondary`) over raw OKLCH values.
2. **Spacing:** Use Tailwind spacing scale. For page layout use `--space-page-x`/`--space-page-y` tokens.
3. **Radius:** Map to `--radius-sm` through `--radius-xl`. Avoid arbitrary values.
4. **Shadows:** Use `--shadow-sm/md/lg` tokens.
5. **Typography:** Use `--text-*` scale + `font-medium`/`font-semibold`/`font-bold`.
6. **Components:** Always reuse existing components from `src/components/ui/` or `src/components/app/` before creating new ones.
7. **Icons:** Use Lucide React — search for the closest match.
8. **Dark mode:** Design tokens already handle dark/light; just use semantic color tokens.
9. **Animations:** Use `--duration-*` and `--easing-default` tokens. Use GSAP for complex sequences, Tailwind animate for simple transitions.

---

## Chat Assistant — Person vs. Customer Resolution

When a user query includes a person's first name (or last name, or any partial name) alongside words like `timmar`, `lönsamhet`, `kunder`, `jobbat`, `sammanställ`, or `omsättning` — always search for a consultant/customer manager first using `resolve_consultant`, **not** `resolve_customer`. Consultants (a.k.a. customer managers) are internal employees stored in the `profiles` table; customers are external companies stored in the `customers` table.

`resolve_consultant` performs a case-insensitive substring match against `full_name` and `email`, so first names, last names, and partial names all resolve:

- "Derya" → "Derya Kuzey"
- "Kuzey" → "Derya Kuzey"
- "kuzey" → "Derya Kuzey"

If `resolve_consultant` returns multiple matches (e.g. two people named Oscar), ask the user to clarify which person they mean before proceeding with any downstream tool that needs a specific `consultant_id`.
