import iconv from "iconv-lite";

/**
 * SIE 4 file parser.
 *
 * SIE (Standard Import Export) is a Swedish accounting interchange format
 * defined by SIE-gruppen — see https://sie.se/sie-format. Files are
 * line-based, ASCII-like text with `#`-prefixed directives. SIE 4 carries
 * the full picture: chart of accounts, dimensions, opening/closing
 * balances, period results, and the underlying voucher (verifikation)
 * stream with its transactions.
 *
 * This parser is lenient by design — unknown directives are skipped with
 * a warning rather than causing a hard failure, so the sync keeps working
 * even if Fortnox (or another exporter) emits a directive we haven't yet
 * mapped.
 *
 * The output object intentionally mirrors the shape we'll want in the
 * eventual storage tables (sie_accounts, sie_verifications, sie_transactions,
 * sie_period_balances, …), so a future "upsert this parsed file" step is
 * straightforward.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SieAccountType = "T" | "S" | "I" | "K";

export interface SieFinancialYearEntry {
  /** 0 = current year (the year the export covers), -1 = previous, … */
  yearIndex: number;
  /** ISO date string (YYYY-MM-DD). */
  fromDate: string;
  /** ISO date string (YYYY-MM-DD). */
  toDate: string;
}

export interface SieMeta {
  flagga: number | null;
  format: string | null;
  sietype: number | null;
  program: { name: string; version: string | null } | null;
  /** ISO date string. */
  generatedDate: string | null;
  generatedBy: string | null;
  /** Fortnox tenant id (or any exporter's internal company id). */
  fnr: string | null;
  companyName: string | null;
  orgNumber: string | null;
  industryCode: string | null;
  /** ISO date string — the period the file's balances cover. */
  periodCovered: string | null;
  chartType: string | null;
  currency: string | null;
  taxYear: string | null;
  /** Address from #ADRESS (contact, address, postal, phone). All optional. */
  address: {
    contact: string | null;
    street: string | null;
    postal: string | null;
    phone: string | null;
  } | null;
  financialYears: SieFinancialYearEntry[];
}

export interface SieAccount {
  number: string;
  name: string;
  /** T=asset, S=debt, I=income, K=cost. Null if exporter didn't include #KTYP. */
  type: SieAccountType | null;
  /** SRU (Standardiserat räkenskapsutdrag) tax-declaration code. */
  sru: string | null;
  unit: string | null;
}

export interface SieDimension {
  number: string;
  name: string;
  parent: string | null;
}

export interface SieObject {
  dimension: string;
  id: string;
  name: string;
}

export interface SieObjectRef {
  dimension: string;
  objectId: string;
}

export interface SieAccountBalance {
  /** "ib" = incoming balance, "ub" = outgoing, "res" = result account. */
  kind: "ib" | "ub" | "res";
  yearIndex: number;
  accountNumber: string;
  amount: number;
  quantity: number | null;
}

export interface SieObjectBalance {
  /** "oib" = object incoming, "oub" = object outgoing. */
  kind: "oib" | "oub";
  yearIndex: number;
  accountNumber: string;
  objects: SieObjectRef[];
  amount: number;
  quantity: number | null;
}

export interface SiePeriodBalance {
  kind: "psaldo" | "pbudget";
  yearIndex: number;
  /** YYYYMM. */
  period: string;
  accountNumber: string;
  objects: SieObjectRef[];
  amount: number;
  quantity: number | null;
}

export interface SieTransaction {
  /** TRANS = regular, RTRANS = reversing, BTRANS = already-booked. */
  type: "TRANS" | "RTRANS" | "BTRANS";
  accountNumber: string;
  objects: SieObjectRef[];
  amount: number;
  /** ISO date — set when transaction date differs from voucher date. */
  date: string | null;
  text: string | null;
  quantity: number | null;
  registeredBy: string | null;
}

export interface SieVoucher {
  series: string;
  number: string;
  /** ISO date. */
  date: string;
  text: string;
  registrationDate: string | null;
  registeredBy: string | null;
  transactions: SieTransaction[];
}

export interface ParsedSieFile {
  meta: SieMeta;
  accounts: SieAccount[];
  dimensions: SieDimension[];
  objects: SieObject[];
  accountBalances: SieAccountBalance[];
  objectBalances: SieObjectBalance[];
  periodBalances: SiePeriodBalance[];
  vouchers: SieVoucher[];
  /** Diagnostic notes — unknown directives, parse anomalies, etc. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

/**
 * Parse a raw SIE 4 file buffer into a structured object.
 *
 * Detects the encoding from the `#FORMAT` header (PC8 → CP437, ISO 8859-1 →
 * latin1, anything else falls back to CP437 which is the Fortnox default).
 */
export function parseSieFile(buffer: Buffer): ParsedSieFile {
  const { text } = decodeText(buffer);
  const result = createEmpty();
  const accountIndex = new Map<string, SieAccount>();

  const lines = text.split(/\r?\n/);

  let currentVoucher: SieVoucher | null = null;
  let inVoucherBody = false;

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const line = rawLine.trim();
    if (!line) continue;

    // Voucher body delimiters live on their own lines.
    if (line === "{") {
      inVoucherBody = true;
      continue;
    }
    if (line === "}") {
      inVoucherBody = false;
      if (currentVoucher) {
        result.vouchers.push(currentVoucher);
        currentVoucher = null;
      }
      continue;
    }

    if (!line.startsWith("#")) {
      // Stray non-directive line — note and continue.
      result.warnings.push(`L${i + 1}: skipping non-directive line`);
      continue;
    }

    const tokens = tokenize(line);
    if (tokens.length === 0) continue;
    const directive = tokens[0];
    const args = tokens.slice(1);

    switch (directive) {
      // ----- Identification / header -----
      case "#FLAGGA":
        result.meta.flagga = numOrNull(args[0]);
        break;
      case "#FORMAT":
        result.meta.format = args[0] ?? null;
        break;
      case "#SIETYP":
        result.meta.sietype = numOrNull(args[0]);
        break;
      case "#PROGRAM":
        result.meta.program = {
          name: args[0] ?? "",
          version: args[1] ?? null,
        };
        break;
      case "#GEN":
        result.meta.generatedDate = parseDate(args[0]);
        result.meta.generatedBy = args[1] ?? null;
        break;
      case "#FNR":
        result.meta.fnr = args[0] ?? null;
        break;
      case "#FNAMN":
        result.meta.companyName = args[0] ?? null;
        break;
      case "#ADRESS":
        result.meta.address = {
          contact: args[0] ?? null,
          street: args[1] ?? null,
          postal: args[2] ?? null,
          phone: args[3] ?? null,
        };
        break;
      case "#ORGNR":
        result.meta.orgNumber = args[0] ?? null;
        break;
      case "#BKOD":
        result.meta.industryCode = args[0] ?? null;
        break;
      case "#OMFATTN":
        result.meta.periodCovered = parseDate(args[0]);
        break;
      case "#KPTYP":
        result.meta.chartType = args[0] ?? null;
        break;
      case "#VALUTA":
        result.meta.currency = args[0] ?? null;
        break;
      case "#TAXAR":
        result.meta.taxYear = args[0] ?? null;
        break;

      // ----- Period definitions -----
      case "#RAR": {
        const from = parseDate(args[1]);
        const to = parseDate(args[2]);
        if (from && to) {
          result.meta.financialYears.push({
            yearIndex: numOrNull(args[0]) ?? 0,
            fromDate: from,
            toDate: to,
          });
        } else {
          result.warnings.push(`L${i + 1}: malformed #RAR (skipped)`);
        }
        break;
      }

      // ----- Accounts -----
      case "#KONTO": {
        const account: SieAccount = {
          number: args[0] ?? "",
          name: args[1] ?? "",
          type: null,
          sru: null,
          unit: null,
        };
        if (!account.number) {
          result.warnings.push(`L${i + 1}: #KONTO without number (skipped)`);
          break;
        }
        result.accounts.push(account);
        accountIndex.set(account.number, account);
        break;
      }
      case "#KTYP": {
        const acc = accountIndex.get(args[0] ?? "");
        if (!acc) {
          result.warnings.push(`L${i + 1}: #KTYP for unknown account ${args[0]}`);
          break;
        }
        const t = args[1];
        if (t === "T" || t === "S" || t === "I" || t === "K") acc.type = t;
        break;
      }
      case "#SRU": {
        const acc = accountIndex.get(args[0] ?? "");
        if (!acc) {
          // SRU on an account we haven't seen yet — record it standalone so we
          // can backfill if the #KONTO arrives later. Rare in practice; Fortnox
          // emits accounts before their SRU.
          result.warnings.push(`L${i + 1}: #SRU for unknown account ${args[0]}`);
          break;
        }
        acc.sru = args[1] ?? null;
        break;
      }
      case "#ENHET": {
        const acc = accountIndex.get(args[0] ?? "");
        if (acc) acc.unit = args[1] ?? null;
        break;
      }

      // ----- Dimensions / objects -----
      case "#DIM":
        result.dimensions.push({
          number: args[0] ?? "",
          name: args[1] ?? "",
          parent: null,
        });
        break;
      case "#UNDERDIM":
        result.dimensions.push({
          number: args[0] ?? "",
          name: args[1] ?? "",
          parent: args[2] ?? null,
        });
        break;
      case "#OBJEKT":
        result.objects.push({
          dimension: args[0] ?? "",
          id: args[1] ?? "",
          name: args[2] ?? "",
        });
        break;

      // ----- Balances -----
      case "#IB":
      case "#UB":
      case "#RES": {
        const yearIndex = numOrNull(args[0]) ?? 0;
        const accountNumber = args[1] ?? "";
        const amount = parseAmount(args[2]);
        const quantity = args[3] != null ? parseAmount(args[3]) : null;
        if (!accountNumber || amount == null) {
          result.warnings.push(`L${i + 1}: malformed ${directive} (skipped)`);
          break;
        }
        result.accountBalances.push({
          kind: directive.slice(1).toLowerCase() as "ib" | "ub" | "res",
          yearIndex,
          accountNumber,
          amount,
          quantity,
        });
        break;
      }
      case "#OIB":
      case "#OUB": {
        const yearIndex = numOrNull(args[0]) ?? 0;
        const accountNumber = args[1] ?? "";
        const objects = parseObjectList(args[2] ?? "");
        const amount = parseAmount(args[3]);
        const quantity = args[4] != null ? parseAmount(args[4]) : null;
        if (!accountNumber || amount == null) {
          result.warnings.push(`L${i + 1}: malformed ${directive} (skipped)`);
          break;
        }
        result.objectBalances.push({
          kind: directive.slice(1).toLowerCase() as "oib" | "oub",
          yearIndex,
          accountNumber,
          objects,
          amount,
          quantity,
        });
        break;
      }
      case "#PSALDO":
      case "#PBUDGET": {
        const yearIndex = numOrNull(args[0]) ?? 0;
        const period = args[1] ?? "";
        const accountNumber = args[2] ?? "";
        const objects = parseObjectList(args[3] ?? "");
        const amount = parseAmount(args[4]);
        const quantity = args[5] != null ? parseAmount(args[5]) : null;
        if (!period || !accountNumber || amount == null) {
          result.warnings.push(`L${i + 1}: malformed ${directive} (skipped)`);
          break;
        }
        result.periodBalances.push({
          kind: directive.slice(1).toLowerCase() as "psaldo" | "pbudget",
          yearIndex,
          period,
          accountNumber,
          objects,
          amount,
          quantity,
        });
        break;
      }

      // ----- Vouchers -----
      case "#VER": {
        const date = parseDate(args[2]);
        if (!date) {
          result.warnings.push(`L${i + 1}: #VER without parseable date (skipped)`);
          break;
        }
        currentVoucher = {
          series: args[0] ?? "",
          number: args[1] ?? "",
          date,
          text: args[3] ?? "",
          registrationDate: parseDate(args[4]),
          registeredBy: args[5] ?? null,
          transactions: [],
        };
        break;
      }
      case "#TRANS":
      case "#RTRANS":
      case "#BTRANS": {
        if (!currentVoucher || !inVoucherBody) {
          result.warnings.push(`L${i + 1}: ${directive} outside voucher body`);
          break;
        }
        const accountNumber = args[0] ?? "";
        const objects = parseObjectList(args[1] ?? "");
        const amount = parseAmount(args[2]);
        if (!accountNumber || amount == null) {
          result.warnings.push(`L${i + 1}: malformed ${directive} (skipped)`);
          break;
        }
        currentVoucher.transactions.push({
          type: directive.slice(1) as "TRANS" | "RTRANS" | "BTRANS",
          accountNumber,
          objects,
          amount,
          // args[3] is either a YYYYMMDD date or the text — best-effort detect.
          date: args[3] && /^\d{8}$/.test(args[3]) ? parseDate(args[3]) : null,
          text:
            args[3] && !/^\d{8}$/.test(args[3])
              ? args[3]
              : args[4] ?? null,
          quantity: args[5] != null ? parseAmount(args[5]) : null,
          registeredBy: args[6] ?? null,
        });
        break;
      }

      // ----- Misc / silently skip these well-known ones -----
      case "#PROSA":
      case "#TYP":
      case "#KSUMMA":
      case "#VALUTAKURS":
        // Known but currently uninteresting — don't warn.
        break;

      default:
        result.warnings.push(`L${i + 1}: unknown directive ${directive}`);
    }
  }

  // Edge case: voucher block left open at EOF (malformed file).
  if (currentVoucher) {
    result.warnings.push("File ended with an open voucher block.");
    result.vouchers.push(currentVoucher);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createEmpty(): ParsedSieFile {
  return {
    meta: {
      flagga: null,
      format: null,
      sietype: null,
      program: null,
      generatedDate: null,
      generatedBy: null,
      fnr: null,
      companyName: null,
      orgNumber: null,
      industryCode: null,
      periodCovered: null,
      chartType: null,
      currency: null,
      taxYear: null,
      address: null,
      financialYears: [],
    },
    accounts: [],
    dimensions: [],
    objects: [],
    accountBalances: [],
    objectBalances: [],
    periodBalances: [],
    vouchers: [],
    warnings: [],
  };
}

/**
 * Decode the file using the encoding declared on the `#FORMAT` line, falling
 * back to CP437 (Fortnox's default for PC8). Reads only the first 500 bytes
 * to find the header, then re-decodes the whole buffer once we know.
 */
function decodeText(buffer: Buffer): { text: string; encoding: string } {
  const peek = buffer.slice(0, Math.min(500, buffer.length)).toString("ascii");
  const formatMatch = peek.match(/^#FORMAT\s+(\S+)/m);
  const formatHint = formatMatch?.[1]?.toUpperCase() ?? null;

  let encoding: string;
  if (formatHint === "PC8" || formatHint === "IBM") {
    encoding = "cp437";
  } else if (formatHint && /^ISO[\s-]?8859[\s-]?1$/i.test(formatHint)) {
    encoding = "iso-8859-1";
  } else {
    encoding = "cp437";
  }

  return { text: iconv.decode(buffer, encoding), encoding };
}

/**
 * Split a single SIE directive line into tokens. Handles:
 *   - Whitespace separation
 *   - "double-quoted strings" (returned without the quotes)
 *   - {brace-grouped} object lists (returned as the inner content, without braces)
 */
function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === " " || ch === "\t") {
      i += 1;
      continue;
    }
    if (ch === '"') {
      // Quoted string — read until the matching close quote.
      let end = i + 1;
      while (end < line.length && line[end] !== '"') end += 1;
      tokens.push(line.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    if (ch === "{") {
      // Brace group — read content until matching close brace, supporting
      // nested braces defensively (rarely seen but safe).
      let depth = 1;
      let end = i + 1;
      while (end < line.length && depth > 0) {
        if (line[end] === "{") depth += 1;
        else if (line[end] === "}") depth -= 1;
        if (depth > 0) end += 1;
      }
      tokens.push(line.slice(i + 1, end).trim());
      i = end + 1;
      continue;
    }
    // Bare token until whitespace.
    let end = i;
    while (end < line.length && line[end] !== " " && line[end] !== "\t") {
      end += 1;
    }
    tokens.push(line.slice(i, end));
    i = end;
  }
  return tokens;
}

function parseObjectList(content: string): SieObjectRef[] {
  if (!content) return [];
  const parts = tokenize(content);
  const objects: SieObjectRef[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    objects.push({ dimension: parts[i], objectId: parts[i + 1] });
  }
  return objects;
}

function numOrNull(raw: string | undefined): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * SIE amounts are written like 1234.56 (period decimal) or -1234.56. Some
 * exporters emit comma decimals — we accept both. Returns null on failure
 * so callers can decide whether to skip the directive or hard-fail.
 */
function parseAmount(raw: string | undefined): number {
  if (raw == null) return Number.NaN;
  const normalised = raw.replace(",", ".");
  return Number(normalised);
}

/**
 * SIE dates are YYYYMMDD with no separators. Normalise to ISO YYYY-MM-DD
 * for consistency with the rest of the app.
 */
function parseDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(trimmed);
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}
