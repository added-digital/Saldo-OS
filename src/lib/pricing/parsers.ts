/**
 * Parsers for the three monthly upload files, turning raw spreadsheet/CSV grids
 * into the per-client `listPrice / fixedCost / extraLicenseCost / redaCost`
 * figures the pricing engine consumes.
 *
 * The parsers work on already-extracted cell grids (`Cell[][]`) so the core
 * logic stays pure and testable and is decoupled from whatever library the
 * route layer uses to read .xlsx / .csv bytes.
 *
 * Validated against the reference workbook's real July 2026 exports:
 *  - extra-license cost allocated across clients reconciles to the öre with the
 *    Fortnox file's own "Summa produkter" total (22 665.00);
 *  - Reda matching resolved 280/281 rows (org number, then name fallback).
 *
 * See docs/pricing-tool-spec.md §4.
 */

import { normalizeOrgNumber } from "@/lib/fortnox-sie/org-number"
import {
  PRICING_CONFIG,
  STANDARD_PRICE_LIST,
  type PriceListEntry,
} from "./price-list"
import { round2 } from "./engine"

export type Cell = string | number | null | undefined
export type Grid = Cell[][]

const str = (v: Cell): string => (v == null ? "" : String(v)).trim()
const numCell = (v: Cell): number => {
  if (v == null || v === "") return 0
  const n =
    typeof v === "number" ? v : parseFloat(String(v).replace(/\s/g, "").replace(",", "."))
  return Number.isFinite(n) ? n : 0
}
/** Article/subscription numbers arrive as "82501" or "82501.0" — normalise. */
const idCell = (v: Cell): string => str(v).replace(/\.0+$/, "")
const isNumericId = (s: string): boolean => /^\d+$/.test(s)

// ---------------------------------------------------------------------------
// 1. Fortnox license file ("Faktureringsunderlag")
// ---------------------------------------------------------------------------

export interface FortnoxArticleTotals {
  articleNo: string
  name: string
  totalQuantity: number
  totalCost: number
  /** Paid unit price = round(totalCost / totalQuantity, 2). 0 ⇒ base license. */
  unitPaidPrice: number
}

export interface FortnoxClientLicenses {
  databaseNumber: string
  orgNumber: string
  name: string
  /** articleNo → quantity (fixed-fee article excluded here; tracked separately). */
  articles: Map<string, number>
  fixedUnits: number
}

export interface FortnoxLicenseData {
  /** Raw period label, e.g. "juli 2026". */
  period: string
  articleTotals: Map<string, FortnoxArticleTotals>
  clients: Map<string, FortnoxClientLicenses>
  fixedArticleNo: string
  fixedUnitPrice: number
  fixedTotalCount: number
  fixedTotalPaid: number
  grandTotalPaid: number
}

/**
 * Parse the single-sheet Fortnox license grid. Sections, per the export layout:
 *   Row with "Faktureringsunderlag <month> <year>"  → period
 *   "Summa produkter" then a header row, then article rows until a blank —
 *       columns: Produkt | Artikel nr | Antal | Kostnad (total cost)
 *   "Byråns egna" then per-client license rows (with "Klienter" sub-headers and
 *       repeated column headers interspersed — skipped by requiring a numeric
 *       Abo.nr): Företagsnamn | Abo.nr | Org.nr | Art.nr | Antal | Kostnad
 */
export function parseFortnoxLicenseGrid(grid: Grid): FortnoxLicenseData {
  const fixedArticleNo = PRICING_CONFIG.fixedLicensePriceArticle
  const cell = (r: number, c: number): Cell => grid[r]?.[c]
  const rows = grid.length

  // --- period ---
  let period = ""
  for (let r = 0; r < Math.min(rows, 5); r++) {
    const a = str(cell(r, 0))
    if (/^Faktureringsunderlag/i.test(a)) {
      period = a.replace(/^Faktureringsunderlag\s*/i, "").trim()
      break
    }
  }

  // --- locate "Summa produkter" ---
  let r = 0
  while (r < rows && str(cell(r, 0)) !== "Summa produkter") r++
  if (r >= rows)
    throw new PricingParseError(
      'Kunde inte hitta rubriken "Summa produkter" i Fortnox-filen.',
    )
  r += 2 // skip section title + column header

  // --- product summary ---
  const articleTotals = new Map<string, FortnoxArticleTotals>()
  let grandTotalPaid = 0
  for (; r < rows; r++) {
    if (str(cell(r, 0)) === "") break
    const name = str(cell(r, 0))
    const articleNo = idCell(cell(r, 1))
    if (!articleNo) continue
    const qty = numCell(cell(r, 2))
    const cost = numCell(cell(r, 3))
    grandTotalPaid += cost
    const existing = articleTotals.get(articleNo)
    if (existing) {
      existing.totalQuantity += qty
      existing.totalCost += cost
    } else {
      articleTotals.set(articleNo, {
        articleNo,
        name,
        totalQuantity: qty,
        totalCost: cost,
        unitPaidPrice: 0,
      })
    }
  }
  for (const a of articleTotals.values()) {
    a.unitPaidPrice = a.totalQuantity ? round2(a.totalCost / a.totalQuantity) : 0
  }
  const fixed = articleTotals.get(fixedArticleNo)
  const fixedUnitPrice = fixed?.unitPaidPrice || 0
  const fixedTotalCount = fixed?.totalQuantity || 0
  const fixedTotalPaid = fixed?.totalCost || 0

  // --- locate "Byråns egna" ---
  while (r < rows && str(cell(r, 0)) !== "Byråns egna") r++
  if (r >= rows)
    throw new PricingParseError(
      'Kunde inte hitta rubriken "Byråns egna" i Fortnox-filen.',
    )

  // --- per-client license lines ---
  const clients = new Map<string, FortnoxClientLicenses>()
  for (; r < rows; r++) {
    const abo = idCell(cell(r, 1))
    if (!isNumericId(abo)) continue // skips sub-headers & repeated column headers
    const name = str(cell(r, 0))
    const orgNumber = normalizeOrgNumber(str(cell(r, 2))) ?? str(cell(r, 2))
    const articleNo = idCell(cell(r, 3))
    const qty = numCell(cell(r, 4))

    let client = clients.get(abo)
    if (!client) {
      client = { databaseNumber: abo, orgNumber, name, articles: new Map(), fixedUnits: 1 }
      clients.set(abo, client)
    }
    if (articleNo && articleNo !== fixedArticleNo) {
      client.articles.set(articleNo, (client.articles.get(articleNo) ?? 0) + qty)
    }
  }

  return {
    period,
    articleTotals,
    clients,
    fixedArticleNo,
    fixedUnitPrice: fixedUnitPrice || 500,
    fixedTotalCount,
    fixedTotalPaid,
    grandTotalPaid: round2(grandTotalPaid),
  }
}

// ---------------------------------------------------------------------------
// 2. Saldo client list ("kundlista")
// ---------------------------------------------------------------------------

export interface KundlistaEntry {
  name: string
  databaseNumber: string
  orgNumber: string
}

/**
 * Parse the semicolon-separated Saldo client list. Header:
 * Namn ; Abonnemangsnr. ; Org.nr. ; …  (a UTF-8 BOM is tolerated).
 */
export function parseKundlistaCsv(text: string): KundlistaEntry[] {
  const out: KundlistaEntry[] = []
  const lines = text.replace(/^﻿/, "").split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    if (i === 0 && /namn/i.test(lines[i]) && /abonnemang/i.test(lines[i])) continue
    const cols = lines[i].split(";")
    if (cols.length < 3) continue
    const name = str(cols[0])
    const databaseNumber = idCell(cols[1])
    if (!name || !isNumericId(databaseNumber)) continue
    out.push({
      name,
      databaseNumber,
      orgNumber: normalizeOrgNumber(str(cols[2])) ?? str(cols[2]),
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// 3. Reda file
// ---------------------------------------------------------------------------

export interface RedaData {
  /** databaseNumber (resolved) → total scans. */
  scansByDatabase: Map<string, number>
  totalScans: number
  unmatched: { name: string; orgNumber: string; scans: number }[]
}

/**
 * Parse the Reda grid (header: Bolag | Orgnr | antal_dokument | …) and resolve
 * each row to a Fortnox database by org number, then by lowercased name.
 * Unmatched rows are attributed to Saldo's own database (and reported).
 */
export function parseRedaGrid(
  grid: Grid,
  clientsByOrg: Map<string, string>,
  clientsByName: Map<string, string>,
  saldoDatabaseNumber: string = PRICING_CONFIG.saldoDatabaseNumber,
): RedaData {
  const scansByDatabase = new Map<string, number>()
  const unmatched: RedaData["unmatched"] = []
  let totalScans = 0

  for (let r = 1; r < grid.length; r++) {
    const name = str(grid[r]?.[0])
    if (!name) continue
    const org = normalizeOrgNumber(str(grid[r]?.[1]))
    const scans = numCell(grid[r]?.[2])
    totalScans += scans

    let db = (org && clientsByOrg.get(org)) || clientsByName.get(name.toLowerCase())
    if (!db) {
      unmatched.push({ name, orgNumber: org ?? str(grid[r]?.[1]), scans })
      db = saldoDatabaseNumber
    }
    scansByDatabase.set(db, (scansByDatabase.get(db) ?? 0) + scans)
  }
  return { scansByDatabase, totalScans, unmatched }
}

// ---------------------------------------------------------------------------
// 4. NVR file (aktiebok / share register)
// ---------------------------------------------------------------------------

export interface NvrData {
  /** databaseNumber (resolved) → total shareholders (aktieägare). */
  shareholdersByDatabase: Map<string, number>
  /** Databases present in the NVR file ⇒ they have aktiebok as a service. */
  presentDatabases: Set<string>
  totalShareholders: number
  companyCount: number
  unmatched: { name: string; orgNumber: string; shareholders: number }[]
}

/**
 * Parse the NVR "group account companies" export (header:
 * Namn | Organisationsnummer | Kundnummer | … | Aktieägare | …). Columns are
 * located by header name (falling back to fixed positions) so the export's
 * column order can drift without breaking. Each company is resolved to a Fortnox
 * database by org number, then by lowercased name; presence in the file means
 * the client has the aktiebok service. Unmatched companies are reported, not
 * billed (unlike Reda, aktiebok is not defaulted onto Saldo).
 */
export function parseNvrGrid(
  grid: Grid,
  clientsByOrg: Map<string, string>,
  clientsByName: Map<string, string>,
): NvrData {
  const header = (grid[0] ?? []).map((c) => str(c).toLowerCase())
  const findIdx = (pred: (h: string) => boolean, fallback: number) => {
    const i = header.findIndex(pred)
    return i === -1 ? fallback : i
  }
  const nameIdx = findIdx((h) => h === "namn", 0)
  const orgIdx = findIdx((h) => h.startsWith("organisationsnummer"), 1)
  const shIdx = findIdx((h) => h.startsWith("aktieägare") || h.startsWith("aktieagare"), 8)

  const shareholdersByDatabase = new Map<string, number>()
  const presentDatabases = new Set<string>()
  const unmatched: NvrData["unmatched"] = []
  let totalShareholders = 0
  let companyCount = 0

  for (let r = 1; r < grid.length; r++) {
    const name = str(grid[r]?.[nameIdx])
    if (!name) continue
    companyCount += 1
    const org = normalizeOrgNumber(str(grid[r]?.[orgIdx]))
    const shareholders = numCell(grid[r]?.[shIdx])
    totalShareholders += shareholders

    const db = (org && clientsByOrg.get(org)) || clientsByName.get(name.toLowerCase())
    if (!db) {
      unmatched.push({ name, orgNumber: org ?? str(grid[r]?.[orgIdx]), shareholders })
      continue
    }
    presentDatabases.add(db)
    shareholdersByDatabase.set(db, (shareholdersByDatabase.get(db) ?? 0) + shareholders)
  }

  return { shareholdersByDatabase, presentDatabases, totalShareholders, companyCount, unmatched }
}

// ---------------------------------------------------------------------------
// Merge → per-client cost rows (L / M / N / O + NVR)
// ---------------------------------------------------------------------------

/** One license/subscription line a client carries (a Fortnox article). */
export interface LicenseLine {
  articleNo: string
  name: string
  quantity: number
  /** Standard (list) unit price used for pricing; 0 when the article is unpriced. */
  unitListPrice: number
}

export interface ClientCostRow {
  databaseNumber: string
  orgNumber: string
  name: string
  /** L — total list price. */
  listPrice: number
  /** M — fixed cost Saldo pays Fortnox. */
  fixedCost: number
  /** N — cost of extra/additional licenses. */
  extraLicenseCost: number
  /** O — Reda cost. */
  redaCost: number
  /** Number of shareholders (aktieägare) from the NVR file. */
  nvrShareholders: number
  /** True when the client appears in the NVR file (has aktiebok as a service). */
  hasAktiebok: boolean
  /** True when only present via the client list (no Fortnox license lines). */
  clientListOnly: boolean
  /** True when the company is only in the NVR file (aktiebok-only, no Fortnox/kundlista). */
  nvrOnly: boolean
  /** Individual Fortnox license lines (excludes the fixed base fee). */
  licenses: LicenseLine[]
}

export interface UnknownArticle {
  articleNo: string
  name: string
  unitPaidPrice: number
}

export interface MergeResult {
  rows: ClientCostRow[]
  unknownArticles: UnknownArticle[]
  redaUnmatched: RedaData["unmatched"]
  nvrUnmatched: NvrData["unmatched"]
  period: string
}

/**
 * Combine the three parsed inputs into per-client cost rows.
 *
 * `standardPrice(article)` = the Fortnox file's paid unit price when > 0 (the
 * file price wins), else the price-list price. Unknown articles with no price
 * are surfaced in `unknownArticles` for the user to price before invoicing.
 *
 * The fixed-fee remainder (fixed units billed by Fortnox minus those allocated
 * to in-file clients, e.g. clients that carry no other licenses) is loaded onto
 * Saldo's own database, matching the reference tool.
 */
export function mergeToClientCostRows(
  fortnox: FortnoxLicenseData,
  kundlista: KundlistaEntry[],
  reda: RedaData | null,
  nvr: NvrData | null,
  priceList: PriceListEntry[] = STANDARD_PRICE_LIST,
  redaUnitPrice: number = PRICING_CONFIG.redaUnitPrice,
  saldoDatabaseNumber: string = PRICING_CONFIG.saldoDatabaseNumber,
): MergeResult {
  const listPriceOf = new Map<string, number>()
  for (const e of priceList) listPriceOf.set(String(e.articleNo).trim(), e.price)

  const standardPrice = (articleNo: string): number | null => {
    const paid = fortnox.articleTotals.get(articleNo)?.unitPaidPrice ?? 0
    if (paid > 0) return paid
    if (listPriceOf.has(articleNo)) return listPriceOf.get(articleNo)!
    return null // unknown, no price
  }

  const unknown = new Map<string, UnknownArticle>()

  // Union of databases: Fortnox license file + client list.
  const dbs = new Map<string, { org: string; name: string; hasLicenses: boolean }>()
  for (const c of fortnox.clients.values())
    dbs.set(c.databaseNumber, { org: c.orgNumber, name: c.name, hasLicenses: true })
  for (const k of kundlista)
    if (!dbs.has(k.databaseNumber))
      dbs.set(k.databaseNumber, { org: k.orgNumber, name: k.name, hasLicenses: false })

  const rows: ClientCostRow[] = []
  let allocatedFixedUnits = 0

  for (const [db, info] of dbs) {
    const client = fortnox.clients.get(db)
    let listPrice = 0
    let extra = 0
    const licenses: LicenseLine[] = []
    if (client) {
      for (const [artNo, qty] of client.articles) {
        const sp = standardPrice(artNo)
        if (sp == null) {
          const at = fortnox.articleTotals.get(artNo)
          unknown.set(artNo, {
            articleNo: artNo,
            name: at?.name ?? "",
            unitPaidPrice: at?.unitPaidPrice ?? 0,
          })
        }
        listPrice += qty * (sp ?? 0)
        extra += qty * (fortnox.articleTotals.get(artNo)?.unitPaidPrice ?? 0)
        licenses.push({
          articleNo: artNo,
          name: fortnox.articleTotals.get(artNo)?.name ?? artNo,
          quantity: qty,
          unitListPrice: sp ?? 0,
        })
      }
      licenses.sort((a, b) => a.name.localeCompare(b.name, "sv"))
    }
    const fixedUnits = client?.fixedUnits ?? 1
    allocatedFixedUnits += fixedUnits
    const scans = reda?.scansByDatabase.get(db) ?? 0

    rows.push({
      databaseNumber: db,
      orgNumber: info.org,
      name: info.name,
      listPrice: round2(listPrice),
      fixedCost: round2(fixedUnits * fortnox.fixedUnitPrice),
      extraLicenseCost: round2(extra),
      redaCost: round2(scans * redaUnitPrice),
      nvrShareholders: nvr?.shareholdersByDatabase.get(db) ?? 0,
      hasAktiebok: nvr?.presentDatabases.has(db) ?? false,
      clientListOnly: !info.hasLicenses,
      nvrOnly: false,
      licenses,
    })
  }

  // Load the fixed-fee remainder onto Saldo's own database.
  const remainderUnits = fortnox.fixedTotalCount - allocatedFixedUnits
  if (remainderUnits !== 0) {
    const saldo = rows.find((x) => x.databaseNumber === saldoDatabaseNumber)
    if (saldo) saldo.fixedCost = round2(saldo.fixedCost + remainderUnits * fortnox.fixedUnitPrice)
  }

  // Aktiebok-only companies: present in the NVR file but not in Fortnox/kundlista.
  // They become their own billable rows (no Fortnox/Reda figures), keyed by org,
  // so a client who only buys aktiebok is still visible and invoiceable. Only
  // companies with no usable org number remain in the unmatched notice.
  const nvrUnresolved: NvrData["unmatched"] = []
  const existingOrgs = new Set(
    rows.map((r) => r.orgNumber.replace(/\D/g, "")).filter(Boolean),
  )
  const seenNvrOnly = new Set<string>()
  for (const u of nvr?.unmatched ?? []) {
    const orgDigits = u.orgNumber.replace(/\D/g, "")
    if (!orgDigits) {
      nvrUnresolved.push(u)
      continue
    }
    if (existingOrgs.has(orgDigits) || seenNvrOnly.has(orgDigits)) continue
    seenNvrOnly.add(orgDigits)
    rows.push({
      databaseNumber: `NVR:${orgDigits}`,
      orgNumber: u.orgNumber,
      name: u.name,
      listPrice: 0,
      fixedCost: 0,
      extraLicenseCost: 0,
      redaCost: 0,
      nvrShareholders: u.shareholders,
      hasAktiebok: true,
      clientListOnly: false,
      nvrOnly: true,
      licenses: [],
    })
  }

  return {
    rows,
    unknownArticles: [...unknown.values()],
    redaUnmatched: reda?.unmatched ?? [],
    nvrUnmatched: nvrUnresolved,
    period: fortnox.period,
  }
}

/** Build the org→db and name→db lookups Reda parsing needs. */
export function buildClientLookups(
  fortnox: FortnoxLicenseData,
  kundlista: KundlistaEntry[],
): { byOrg: Map<string, string>; byName: Map<string, string> } {
  const byOrg = new Map<string, string>()
  const byName = new Map<string, string>()
  const add = (org: string, name: string, db: string) => {
    const no = normalizeOrgNumber(org)
    if (no) byOrg.set(no, db)
    if (name) byName.set(name.toLowerCase(), db)
  }
  for (const c of fortnox.clients.values()) add(c.orgNumber, c.name, c.databaseNumber)
  for (const k of kundlista) add(k.orgNumber, k.name, k.databaseNumber)
  return { byOrg, byName }
}

export class PricingParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PricingParseError"
  }
}
