/**
 * Thin SheetJS wrappers for reading an uploaded spreadsheet into a cell grid
 * and writing a priced result set out to an .xlsx workbook.
 *
 * Kept isolated so `xlsx` (SheetJS) is the only module that imports it, and the
 * pure engine/parsers stay dependency-free.
 */

import * as XLSX from "xlsx"
import type { Grid } from "./parsers"
import type { PricingComputation } from "./compute"

/** Read the first worksheet of a spreadsheet buffer into a `Cell[][]` grid. */
export function bufferToGrid(buffer: ArrayBuffer | Uint8Array): Grid {
  const wb = XLSX.read(buffer, { type: "array" })
  const sheet = wb.Sheets[wb.SheetNames[0]]
  if (!sheet) return []
  // header:1 → array-of-arrays; blankrows keeps row alignment; raw values.
  return XLSX.utils.sheet_to_json<Grid[number]>(sheet, {
    header: 1,
    blankrows: true,
    defval: null,
    raw: true,
  }) as Grid
}

const SEK = (n: number) => Math.round(n * 100) / 100

/** Build a multi-sheet .xlsx workbook (Summary + per-client rows) as bytes. */
export function computationToWorkbook(comp: PricingComputation): Uint8Array {
  const wb = XLSX.utils.book_new()

  // --- Summary sheet ---
  const s = comp.summary
  const summaryAoa: (string | number)[][] = [
    [`Licensfakturering — ${comp.period || ""}`],
    [],
    ["Fortnox", "Belopp (SEK)"],
    ["Fakturerade bolag", s.invoicedCount],
    ["Fakturerat (kundpris)", SEK(s.totalInvoicedFortnox)],
    ["Listpris", SEK(s.totalListPrice)],
    ["Kostnad fastpris", SEK(s.totalFixedCost)],
    ["Kostnad extra licenser", SEK(s.totalExtraCost)],
    ["Resultat (marginal)", SEK(s.result)],
    ["Marginal %", s.marginPct],
    [],
    ["Reda", "Belopp (SEK)"],
    ["Fakturerat (kundpris)", SEK(s.totalInvoicedReda)],
    ["Kostnad", SEK(s.totalRedaCost)],
    ["Resultat", SEK(s.redaResult)],
    [],
    ["NVR / Aktiebok", "Belopp (SEK)"],
    ["Fakturerat (kundpris)", SEK(s.totalInvoicedNvr)],
    ["Löpande (per aktieägare)", SEK(s.totalNvrRecurring)],
    ["Aktieägare", s.nvrShareholders],
    ["Bolag med aktiebok", s.aktiebokCount],
  ]
  const summarySheet = XLSX.utils.aoa_to_sheet(summaryAoa)
  summarySheet["!cols"] = [{ wch: 28 }, { wch: 16 }]
  XLSX.utils.book_append_sheet(wb, summarySheet, "Summering")

  // --- Per-client sheet ---
  const header = [
    "Abonnemangsnr",
    "Orgnr",
    "Namn",
    "Kundnr Fortnox",
    "Rabatt %",
    "Fast pris Fortnox",
    "Fast pris Reda",
    "Fast pris NVR",
    "Listpris",
    "Kundpris Fortnox",
    "Diff mot listpris",
    "Kundpris Reda",
    "Aktieägare",
    "Kundpris NVR (löpande)",
    "Kostnad fast",
    "Kostnad extra",
    "Kostnad Reda",
    "Netto (marginal)",
    "Faktureras ej",
    "Status",
    "Kommentar",
  ]
  const rowsAoa = comp.rows.map((r) => [
    r.databaseNumber,
    r.orgNumber,
    r.name,
    r.fortnoxCustomerNumber ?? "",
    r.discountPercent,
    r.fixedPriceFortnox ?? "",
    r.fixedPriceReda ?? "",
    r.fixedPriceNvr ?? "",
    SEK(r.listPrice),
    SEK(r.fortnoxPrice),
    SEK(r.diffVsList),
    SEK(r.redaPrice),
    r.nvrShareholders,
    SEK(r.nvrRecurring),
    SEK(r.fixedCost),
    SEK(r.extraLicenseCost),
    SEK(r.redaCost),
    SEK(
      r.fortnoxPrice + r.redaPrice + r.nvrPrice - r.fixedCost - r.extraLicenseCost - r.redaCost,
    ),
    r.notInvoiced ? "JA" : "",
    r.status ?? "",
    r.comment ?? "",
  ])
  const clientSheet = XLSX.utils.aoa_to_sheet([header, ...rowsAoa])
  clientSheet["!cols"] = [
    { wch: 13 }, { wch: 13 }, { wch: 32 }, { wch: 14 }, { wch: 9 },
    { wch: 15 }, { wch: 13 }, { wch: 13 }, { wch: 11 }, { wch: 15 },
    { wch: 14 }, { wch: 12 }, { wch: 11 }, { wch: 18 },
    { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 12 },
    { wch: 20 }, { wch: 24 },
  ]
  XLSX.utils.book_append_sheet(wb, clientSheet, "Kunder")

  return XLSX.write(wb, { type: "array", bookType: "xlsx" }) as Uint8Array
}
