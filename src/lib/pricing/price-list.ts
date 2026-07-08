/**
 * Fortnox standard price list — article number → product → monthly price ex VAT.
 *
 * Mirrors the "Fortnox standardpris" sheet in the reference workbook
 * (Huvud excel.xlsm). This is editable reference data: when a Fortnox license
 * file reports a different unit price for an article, the file price takes
 * precedence at import time (see the pricing engine). Unknown article numbers
 * encountered during import are appended here for the user to price.
 *
 * See docs/pricing-tool-spec.md §5.
 */

export interface PriceListEntry {
  /** Fortnox article number (string — some are numeric, some alphanumeric). */
  articleNo: string
  /** Product name. */
  name: string
  /** Standard monthly price ex VAT (SEK). */
  price: number
}

export const STANDARD_PRICE_LIST: PriceListEntry[] = [
  { articleNo: "101030", name: "Bokföring", price: 149 },
  { articleNo: "101230", name: "Bokföring Attest & Läs", price: 79 },
  { articleNo: "102030", name: "Fakturering", price: 149 },
  { articleNo: "103030", name: "Byråpartner", price: 329 },
  { articleNo: "105030", name: "Offert & Order", price: 89 },
  { articleNo: "106030", name: "Anläggningsregister", price: 109 },
  { articleNo: "111030", name: "Autogiro", price: 109 },
  { articleNo: "112030", name: "Integration", price: 169 },
  { articleNo: "114030", name: "Leverantörsfakturaattest", price: 49 },
  { articleNo: "117030", name: "Lager", price: 369 },
  { articleNo: "202030", name: "Arkivplats", price: 109 },
  { articleNo: "202560", name: "Extra Utrymme", price: 109 },
  { articleNo: "301030", name: "Lön", price: 169 },
  { articleNo: "302170", name: "Tid", price: 89 },
  { articleNo: "302280", name: "Förening", price: 279 },
  { articleNo: "55006052", name: "Enkel Lön", price: 69 },
  { articleNo: "55006057", name: "Löpande Bas", price: 239 },
  { articleNo: "55006064", name: "Bokslut & Skatt - Byrå", price: 349 },
  { articleNo: "55006110", name: "Standard", price: 369 },
  { articleNo: "55006111", name: "Plus", price: 519 },
  { articleNo: "55006112", name: "Fortnox Revisor", price: 149 },
  { articleNo: "55006113", name: "Fortnox Läs", price: 79 },
  { articleNo: "55006116", name: "Gör Det Själv Bas", price: 239 },
  { articleNo: "55006150", name: "Personalattest", price: 49 },
  { articleNo: "55006164", name: "Byrå Koncern Liten", price: 149 },
  { articleNo: "55006166", name: "Byrå Koncern Mellan", price: 249 },
  { articleNo: "550066184", name: "Findity AB/Kvitto  Resa", price: 109 },
  { articleNo: "55066197", name: "Attest & Koll", price: 99 },
  { articleNo: "66000011", name: "Standout AB/Zapier", price: 169 },
  { articleNo: "82500", name: "Fast kostnad klienter", price: 0 },
  { articleNo: "55066199", name: "Rapport & Analys - Byrå", price: 199 },
  { articleNo: "55066200", name: "Rapport & Analys Utökad", price: 99 },
  { articleNo: "55006195", name: "Rapport & Analys - Företag", price: 149 },
  { articleNo: "55006196", name: "Rapport & Analys Plus", price: 299 },
  { articleNo: "55006114", name: "Löpande Mini", price: 99 },
  { articleNo: "55066205", name: "Mellan", price: 529 },
  { articleNo: "55066203", name: "Liten", price: 349 },
  { articleNo: "55066204", name: "Liten+", price: 479 },
  { articleNo: "55066206", name: "Mellan+", price: 659 },
  { articleNo: "55006109", name: "Bas", price: 349 },
  { articleNo: "55066201", name: "Mini", price: 209 },
  { articleNo: "55066198", name: "Bokslut & Skatt - Företag", price: 349 },
  { articleNo: "82501", name: "Fast kostnad klienter", price: 500 },
  { articleNo: "55066208", name: "Stor+", price: 919 },
  { articleNo: "55066244", name: "Lön Kivra", price: 5 },
]

/** Import/invoice configuration constants (from the reference workbook). */
export const PRICING_CONFIG = {
  /** Article carrying the fixed per-client fee. */
  fixedLicensePriceArticle: "82501",
  /** Invoice article number for aggregated Fortnox licenses. */
  fortnoxArticleNumber: "97",
  /** Invoice article number for Reda scanning. */
  redaArticleNumber: "99",
  /** Default price per Reda supplier-invoice scan (SEK ex VAT). */
  redaUnitPrice: 2.5,
  /** Recurring price per aktieägare for the aktiebok/NVR service (SEK ex VAT). */
  nvrUnitPrice: 15,
  /** One-time NVR/aktiebok start fee, billed once when a client gets aktiebok. */
  nvrStartFee: 3000,
  /** Day of month used as the invoice date. */
  invoiceDay: 16,
  /** Saldo's own Fortnox database number (excluded from most summary buckets). */
  saldoDatabaseNumber: "65018",
} as const

/** Build a lookup map: articleNo → entry. */
export function priceListMap(
  list: PriceListEntry[] = STANDARD_PRICE_LIST,
): Map<string, PriceListEntry> {
  const m = new Map<string, PriceListEntry>()
  for (const e of list) m.set(String(e.articleNo).trim(), e)
  return m
}
