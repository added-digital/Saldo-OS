// Page-context registry for the chat assistant.
//
// When the user toggles "use this page as context" in the chat, we look up the
// current route here and hand the assistant a short label + guideline so it
// can resolve references like "this", "these numbers", or "here" against the
// page the user is actually looking at.
//
// Keep descriptions short and factual — they're injected verbatim into the
// model's prompt. Labels mirror src/config/navigation.ts.

/**
 * An entity the current route is scoped to (e.g. a single customer). The id is
 * the database UUID, which the chat tools accept directly — so the assistant
 * can pull the same live data the page shows without a name-resolution step.
 */
export type PageEntity = {
  type: "customer"
  id: string
}

export type PageContext = {
  /** Human-readable page name, e.g. "Reports". */
  label: string
  /** The route the user is on, e.g. "/reports". */
  path: string
  /** One-line description of what the page shows, for the assistant. */
  description: string
  /** Set when the route is scoped to a specific record. */
  entity?: PageEntity
}

// Keyed by the first path segment. Multi-segment routes (mail/history,
// customer details) are special-cased in getPageContext below.
const PAGE_CONTEXTS: Record<string, Omit<PageContext, "path">> = {
  customers: {
    label: "Customers",
    description:
      "The customer list — companies the firm works with, including status, customer manager, segment and key figures.",
  },
  contacts: {
    label: "Contacts",
    description: "The list of contact persons across the firm's customers.",
  },
  mail: {
    label: "Send mail",
    description: "The page for composing and sending email to customers.",
  },
  reports: {
    label: "Reports",
    description:
      "Financial and operational reports and charts — revenue, hours, and profitability across customers and consultants.",
  },
  "key-metrics": {
    label: "Key Metrics",
    description:
      "Financial KPIs derived from synced SIE files: revenue, gross margin, EBIT, kassalikviditet and soliditet.",
  },
  "hit-list": {
    label: "Hit list",
    description:
      "The träfflista — financial warnings and opportunities scoped from synced SIE files (e.g. share-capital reduction candidates).",
  },
  settings: {
    label: "Settings",
    description: "Account and system configuration for the Saldo CRM.",
  },
}

/**
 * Resolve the current pathname to a page context, or null when the route isn't
 * recognised (the chat then simply omits the page-context option).
 */
export function getPageContext(pathname: string | null): PageContext | null {
  if (!pathname) return null

  const segments = pathname.split("/").filter(Boolean)
  const first = segments[0] ?? ""

  // Special cases first.
  if (first === "mail" && segments[1] === "history") {
    return {
      label: "Mail history",
      path: pathname,
      description: "A log of emails previously sent to customers.",
    }
  }

  // Per-customer financial KPIs (/key-metrics/<customerId>). Scoped to one
  // customer whose UUID is in the path.
  if (first === "key-metrics" && segments[1]) {
    return {
      label: "Key Metrics",
      path: pathname,
      description:
        "The per-customer financial KPI page — SIE-derived nyckeltal (revenue, gross margin, EBIT, soliditet, kassalikviditet, etc.) for the current financial year, with a monthly revenue/EBIT trend and a P&L summary.",
      entity: { type: "customer", id: segments[1] },
    }
  }

  if (first === "customers" && segments[1] && segments[1] !== "contacts") {
    return {
      label: "Customer details",
      path: pathname,
      description:
        "The detail view for a single customer — their profile, contacts, invoices, logged hours, contracts and KPIs.",
      entity: { type: "customer", id: segments[1] },
    }
  }

  const base = PAGE_CONTEXTS[first]
  if (!base) return null

  return { ...base, path: pathname }
}

/**
 * Build the string handed to the chat API. Phrased so the model treats it as
 * orientation, not an instruction to talk about the page unprompted.
 *
 * When the route is scoped to a customer, the resolved `entityName` (if known)
 * and the UUID are included so the assistant can call customer-scoped tools
 * (get_customer_overview, get_sie_kpis, get_hit_list_matches, …) directly —
 * pulling the same live data the page renders, no resolve_customer step.
 */
export function buildPageContextPrompt(
  context: PageContext,
  entityName?: string | null,
): string {
  const base =
    `The user is currently viewing the "${context.label}" page (${context.path}) ` +
    `of the Saldo CRM. ${context.description}`

  if (context.entity?.type === "customer") {
    const named = entityName
      ? `the customer "${entityName}" (customer_id: ${context.entity.id})`
      : `a specific customer (customer_id: ${context.entity.id})`
    return (
      `${base} This view is scoped to ${named}. Treat that customer as the ` +
      `subject of the user's question unless they name a different one. You can ` +
      `call customer-scoped tools (e.g. get_customer_overview, get_sie_kpis, ` +
      `get_hit_list_matches) directly with this customer_id — do NOT call ` +
      `resolve_customer first. When the question says "this", "these", "here", ` +
      `or refers to figures without naming a source, interpret them against ` +
      `this customer and page.`
    )
  }

  return (
    `${base} When their question uses words like "this", "these", "here", or ` +
    `refers to figures without naming a source, interpret it in light of this ` +
    `page where relevant.`
  )
}
