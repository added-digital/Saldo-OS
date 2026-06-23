import type { createClient } from "@/lib/supabase/client"

/**
 * Shared logic for the "Fakturapåminnelse" (invoice reminder) mail template.
 *
 * This template is a plain-text email (no branded styling). When it is selected
 * in the composer it is only sent to customers that have at least one unpaid
 * invoice overdue by more than {@link OVERDUE_GRACE_DAYS} days, and each
 * customer's overdue invoices are injected into the body.
 *
 * The overdue definition mirrors the customers/reports pages: an invoice counts
 * when `balance > 0` and `due_date` is more than the grace period in the past.
 * `final_pay_date` is the date an invoice was fully paid (NULL while unpaid), so
 * `due_date` is the correct column to compare against.
 */

type SupabaseBrowserClient = ReturnType<typeof createClient>

/** Invoices overdue by more than this many days past due_date qualify. */
export const OVERDUE_GRACE_DAYS = 3

/**
 * Tokens replaced in the body with a recipient's formatted overdue invoices.
 * Both spellings are accepted so admins can write whichever reads naturally.
 */
export const INVOICE_TOKENS = ["@fakturor", "@invoices"] as const

export interface OverdueInvoice {
  id: string
  document_number: string
  invoice_date: string | null
  due_date: string | null
  total: number | null
  balance: number | null
  currency_code: string | null
}

/** Minimal customer shape needed to resolve overdue invoices. */
export interface OverdueLookupCustomer {
  id: string
  fortnox_customer_number: string | null
}

const sekFormatter = new Intl.NumberFormat("sv-SE", {
  style: "currency",
  currency: "SEK",
  maximumFractionDigits: 0,
})
const numberFormatter = new Intl.NumberFormat("sv-SE")

/** ISO (yyyy-mm-dd) cutoff date — invoices due before this are overdue. */
export function overdueCutoffIso(graceDays: number = OVERDUE_GRACE_DAYS): string {
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - graceDays)
  return cutoff.toISOString().slice(0, 10)
}

/** Whole days an invoice is past its due date (0 if not yet due / unparseable). */
export function daysOverdue(dueDate: string | null): number | null {
  if (!dueDate) return null
  const due = Date.parse(dueDate)
  if (Number.isNaN(due)) return null
  const today = Date.parse(new Date().toISOString().slice(0, 10))
  return Math.max(0, Math.floor((today - due) / 86_400_000))
}

export function formatInvoiceAmount(
  value: number | null,
  currencyCode: string | null,
): string {
  if (value == null) return "—"
  if (!currencyCode || currencyCode === "SEK") return sekFormatter.format(value)
  return `${numberFormatter.format(value)} ${currencyCode}`
}

/**
 * Build the Swedish plain-text block for a customer's overdue invoices — one
 * line per invoice (number, due date, outstanding amount, days overdue),
 * followed by a total of the outstanding balances. Plain text with `\n` breaks
 * so it drops straight into the plain email body.
 */
export function formatOverdueInvoiceBlock(invoices: OverdueInvoice[]): string {
  if (invoices.length === 0) return ""

  const lines = invoices.map((invoice) => {
    const due = invoice.due_date ?? "—"
    const amount = formatInvoiceAmount(
      invoice.balance ?? invoice.total,
      invoice.currency_code,
    )
    const days = daysOverdue(invoice.due_date)
    const daysLabel = days == null ? "" : ` (${days} dagar försenad)`
    return `• Faktura ${invoice.document_number} – förfallodatum ${due} – ${amount}${daysLabel}`
  })

  // Total outstanding, summed per currency so mixed-currency lists stay honest.
  const totalsByCurrency = new Map<string, number>()
  for (const invoice of invoices) {
    const amount = invoice.balance ?? invoice.total
    if (amount == null) continue
    const currency = invoice.currency_code || "SEK"
    totalsByCurrency.set(currency, (totalsByCurrency.get(currency) ?? 0) + amount)
  }
  const totalLine = Array.from(totalsByCurrency.entries())
    .map(([currency, amount]) => formatInvoiceAmount(amount, currency))
    .join(" + ")

  return [...lines, "", `Totalt utestående: ${totalLine}`].join("\n")
}

/**
 * Fetch every unpaid invoice overdue by more than the grace period for the
 * given customers, keyed by customer id. Invoice rows can carry a NULL
 * customer_id, so we also match on fortnox_customer_number and fold those rows
 * back onto the owning customer (same fallback used across customers/reports).
 */
export async function fetchOverdueInvoicesByCustomer(
  supabase: SupabaseBrowserClient,
  customers: OverdueLookupCustomer[],
  graceDays: number = OVERDUE_GRACE_DAYS,
): Promise<Map<string, OverdueInvoice[]>> {
  const result = new Map<string, OverdueInvoice[]>()
  if (customers.length === 0) return result

  const cutoffIso = overdueCutoffIso(graceDays)
  const customerIds = customers.map((customer) => customer.id)
  const fortnoxNumbers = customers
    .map((customer) => customer.fortnox_customer_number)
    .filter((value): value is string => Boolean(value))

  // OR across id and fortnox number so NULL-customer_id rows still match.
  const orFilters: string[] = []
  if (customerIds.length > 0) {
    orFilters.push(`customer_id.in.(${customerIds.join(",")})`)
  }
  if (fortnoxNumbers.length > 0) {
    orFilters.push(`fortnox_customer_number.in.(${fortnoxNumbers.join(",")})`)
  }
  if (orFilters.length === 0) return result

  const { data, error } = await supabase
    .from("invoices")
    .select(
      "id, document_number, customer_id, fortnox_customer_number, invoice_date, due_date, total, balance, currency_code",
    )
    .gt("balance", 0)
    .lt("due_date", cutoffIso)
    .or(orFilters.join(","))
    .order("due_date", { ascending: true })

  if (error || !data) return result

  const byId = new Map(customers.map((customer) => [customer.id, customer]))
  const byFortnox = new Map(
    customers
      .filter((customer) => customer.fortnox_customer_number)
      .map((customer) => [customer.fortnox_customer_number as string, customer]),
  )

  const rows = data as unknown as Array<
    OverdueInvoice & {
      customer_id: string | null
      fortnox_customer_number: string | null
    }
  >

  for (const row of rows) {
    const owner =
      (row.customer_id ? byId.get(row.customer_id) : undefined) ??
      (row.fortnox_customer_number
        ? byFortnox.get(row.fortnox_customer_number)
        : undefined)
    if (!owner) continue
    const existing = result.get(owner.id) ?? []
    existing.push({
      id: row.id,
      document_number: row.document_number,
      invoice_date: row.invoice_date,
      due_date: row.due_date,
      total: row.total,
      balance: row.balance,
      currency_code: row.currency_code,
    })
    result.set(owner.id, existing)
  }

  return result
}

/**
 * Replace the invoice token(s) in a body with the formatted overdue block. If
 * the body has no token, the block is appended after a blank line so invoices
 * are never silently dropped.
 */
export function injectInvoiceBlock(body: string, block: string): string {
  if (!block) return body
  let replaced = body
  let didReplace = false
  for (const token of INVOICE_TOKENS) {
    const pattern = new RegExp(
      token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "gi",
    )
    if (pattern.test(replaced)) {
      replaced = replaced.replace(pattern, block)
      didReplace = true
    }
  }
  if (didReplace) return replaced
  return `${body.trimEnd()}\n\n${block}`
}

/** Default Swedish placeholder copy shipped with the built-in template. */
export function defaultInvoiceReminderCopy(): { subject: string; body: string } {
  return {
    subject: "Påminnelse: förfallna fakturor",
    body: [
      "Hej @customer,",
      "",
      "Detta är en påminnelse om att följande faktura/fakturor har passerat förfallodatum och ännu inte är betalda:",
      "",
      "@fakturor",
      "",
      "Vi ber dig betala det utestående beloppet snarast. Har betalningen redan genomförts kan du bortse från detta meddelande.",
      "",
      "Har du frågor om fakturorna är du välkommen att kontakta oss.",
      "",
      "Med vänliga hälsningar,",
      "Saldo Redovisning",
    ].join("\n"),
  }
}
