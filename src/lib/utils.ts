import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatDate(date: string | Date, options?: Intl.DateTimeFormatOptions): string {
  const d = typeof date === "string" ? new Date(date) : date
  return d.toLocaleDateString("sv-SE", {
    year: "numeric",
    month: "short",
    day: "numeric",
    ...options,
  })
}

export function formatDateTime(date: string | Date): string {
  const d = typeof date === "string" ? new Date(date) : date
  return d.toLocaleString("sv-SE", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

/**
 * Money for display: Swedish grouping, "kr" suffix, no decimals. Amounts here
 * are estimates and running totals — the ören only add noise. Null renders as
 * an em dash so an unset value never reads as 0 kr.
 */
export function formatCurrency(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—"
  return `${new Intl.NumberFormat("sv-SE", { maximumFractionDigits: 0 }).format(value)} kr`
}

/**
 * The reporting currency. Every KPI, chart and total is expressed in it; other
 * currencies exist only on the documents that were issued in them.
 */
export const BASE_CURRENCY = "SEK"

/**
 * Currencies selectable as a customer's default. Kept short on purpose — the
 * list is what Saldo actually invoices in, not every ISO code in the world.
 */
export const SUPPORTED_CURRENCIES = [
  "SEK",
  "EUR",
  "USD",
  "GBP",
  "NOK",
  "DKK",
  "CHF",
] as const

export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number]

const CURRENCY_SYMBOLS: Record<string, string> = {
  SEK: "kr",
  EUR: "€",
  USD: "$",
  GBP: "£",
  NOK: "nkr",
  DKK: "dkk",
  CHF: "CHF",
}

export function normalizeCurrencyCode(value: string | null | undefined): string {
  const code = (value ?? "").trim().toUpperCase()
  return /^[A-Z]{3}$/.test(code) ? code : BASE_CURRENCY
}

/**
 * Money in a specific currency: same Swedish grouping as `formatCurrency`, with
 * the currency made explicit. SEK keeps the familiar "1 234 kr" suffix; other
 * currencies lead with their symbol ("€1 234") so a foreign amount is never
 * mistaken for kronor at a glance.
 */
export function formatAmountInCurrency(
  value: number | null | undefined,
  currencyCode: string | null | undefined,
  options?: { maximumFractionDigits?: number },
): string {
  if (value == null || !Number.isFinite(value)) return "—"

  const code = normalizeCurrencyCode(currencyCode)
  const formatted = new Intl.NumberFormat("sv-SE", {
    maximumFractionDigits: options?.maximumFractionDigits ?? 0,
  }).format(value)

  if (code === BASE_CURRENCY) return `${formatted} kr`

  const symbol = CURRENCY_SYMBOLS[code]
  return symbol ? `${symbol}${formatted}` : `${formatted} ${code}`
}

export function isBaseCurrency(value: string | null | undefined): boolean {
  return normalizeCurrencyCode(value) === BASE_CURRENCY
}

export function formatBytes(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—"
  if (value < 1024) return `${value} B`
  const units = ["KB", "MB", "GB", "TB"]
  let size = value / 1024
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit++
  }
  return `${size.toFixed(size < 10 ? 1 : 0)} ${units[unit]}`
}

export function getInitials(name: string | null | undefined): string {
  if (!name) return "?"
  return name
    .split(" ")
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase()
}

export function getRoleLabel(role: string): string {
  const labels: Record<string, string> = {
    admin: "Admin",
    team_lead: "Team Lead",
    user: "User",
  }
  return labels[role] ?? role
}

export function getStatusColor(status: string): "default" | "secondary" | "destructive" | "outline" {
  const colors: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
    active: "default",
    archived: "secondary",
    removed: "destructive",
    idle: "outline",
    syncing: "default",
    error: "destructive",
  }
  return colors[status] ?? "outline"
}
