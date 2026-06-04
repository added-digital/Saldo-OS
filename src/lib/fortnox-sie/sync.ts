import type { SupabaseClient } from "@supabase/supabase-js";

import { createAdminClient } from "@/lib/supabase/admin";

import {
  fetchSieFile,
  type SieType,
} from "./client";
import { orgNumbersMatch, normalizeOrgNumber } from "./org-number";
import { parseSieFile, type ParsedSieFile } from "./parser";

/**
 * SIE sync orchestrator.
 *
 * Single entry point: `syncSieForCustomer({ customerId, year? })`.
 *
 * Flow (per call):
 *   1. Resolve customer's sie_connection, refresh tokens if needed.
 *   2. Fetch the SIE export for the requested year.
 *   3. Parse the file into the typed shape.
 *   4. Persist into the ledger tables (see "Upsert strategy" below).
 *   5. Update sie_imports with status + counts + warnings.
 *   6. Touch sie_connections.last_synced_at.
 *
 * Upsert strategy:
 *   - Accounts / dimensions / objects → additive UPSERT on natural key
 *     (chart entries persist across years; we add new ones and update
 *     names, but never delete — keeps historical references intact).
 *   - Balances + vouchers + transactions → "delete-then-insert" scoped to
 *     (customer_id, financial_year_from). These are point-in-time
 *     snapshots; if Fortnox no longer reports a row in the current export,
 *     it should disappear from our copy too. Cascade FK on transactions
 *     means deleting vouchers wipes their transactions.
 *
 * Year handling:
 *   - The parser produces balances/vouchers tagged with `yearIndex`
 *     (0 = current year of the file, -1 = previous, …).
 *   - We only persist rows with `yearIndex === 0` (the year we asked for).
 *     Previous-year data from one file would conflict with that year's
 *     own file when we sync IT later. Always trust the file dedicated to
 *     a given year.
 */

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SyncSieResult {
  importId: string | null;
  status: "success" | "parse_error" | "fetch_error" | "org_mismatch";
  financialYearFrom: string | null;
  counts: {
    accounts: number;
    dimensions: number;
    objects: number;
    account_balances: number;
    period_balances: number;
    object_balances: number;
    vouchers: number;
    transactions: number;
    warnings: number;
  };
  warnings: string[];
  errorMessage: string | null;
  durationMs: number;
}

export interface SyncSieOptions {
  customerId: string;
  /** Calendar year to sync (e.g. 2026). Defaults to current Stockholm year. */
  year?: number;
  /** SIE export type. Default 4 (full transactional). */
  sieType?: SieType;
  /** Pre-built admin client; optional, defaults to `createAdminClient()`. */
  admin?: SupabaseClient;
}

export async function syncSieForCustomer(
  opts: SyncSieOptions,
): Promise<SyncSieResult> {
  const started = Date.now();
  const admin = opts.admin ?? createAdminClient();
  const sieType: SieType = opts.sieType ?? 4;
  const year = opts.year ?? new Date().getFullYear();

  // ---------------------------------------------------------------------
  // Stage 1 — fetch
  // ---------------------------------------------------------------------
  let fetched;
  try {
    fetched = await fetchSieFile({
      customerId: opts.customerId,
      type: sieType,
      year,
      admin,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Fetch failed.";
    console.error("[SIE sync] fetch failed:", error);
    const importId = await recordFailedImport(admin, {
      customerId: opts.customerId,
      sieType,
      // Best-effort: we don't yet know the financial_year_from boundaries.
      financialYearFrom: `${year}-01-01`,
      financialYearTo: `${year}-12-31`,
      byteSize: null,
      status: "fetch_error",
      errorMessage: message,
    });
    return failureResult({
      importId,
      status: "fetch_error",
      errorMessage: message,
      durationMs: Date.now() - started,
    });
  }

  // ---------------------------------------------------------------------
  // Stage 2 — parse
  // ---------------------------------------------------------------------
  let parsed: ParsedSieFile;
  try {
    parsed = parseSieFile(fetched.buffer);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Parse failed.";
    console.error("[SIE sync] parse failed:", error);
    const importId = await recordFailedImport(admin, {
      customerId: opts.customerId,
      sieType,
      financialYearFrom: `${year}-01-01`,
      financialYearTo: `${year}-12-31`,
      byteSize: fetched.byteLength,
      status: "parse_error",
      errorMessage: message,
    });
    return failureResult({
      importId,
      status: "parse_error",
      errorMessage: message,
      durationMs: Date.now() - started,
    });
  }

  // Find the current-year boundaries (yearIndex=0) from the parsed file.
  // We persist data tagged with yearIndex=0 only.
  const currentYear = parsed.meta.financialYears.find((y) => y.yearIndex === 0);
  if (!currentYear) {
    const message =
      "Parsed file has no current-year (#RAR 0) entry; refusing to persist.";
    console.error("[SIE sync]", message);
    const importId = await recordFailedImport(admin, {
      customerId: opts.customerId,
      sieType,
      financialYearFrom: `${year}-01-01`,
      financialYearTo: `${year}-12-31`,
      byteSize: fetched.byteLength,
      status: "parse_error",
      errorMessage: message,
    });
    return failureResult({
      importId,
      status: "parse_error",
      errorMessage: message,
      durationMs: Date.now() - started,
    });
  }
  const financialYearFrom = currentYear.fromDate;
  const financialYearTo = currentYear.toDate;

  // ---------------------------------------------------------------------
  // Stage 2b — identity backstop
  //
  // Confirm the org number inside the SIE file matches the Saldo customer
  // we're syncing for. This catches a connection that was bound to the
  // wrong Fortnox company (e.g. the connect-time guard was bypassed, the
  // customer had no org_number on file then, or the company was later
  // re-pointed). We only block on a DEFINITE mismatch — both numbers
  // present and different — so a customer with no org_number on file still
  // syncs. On mismatch we refuse to persist and flag the connection.
  // ---------------------------------------------------------------------
  const fileOrgNumber = parsed.meta.orgNumber;
  const { data: customerRow } = await admin
    .from("customers")
    .select("org_number")
    .eq("id", opts.customerId)
    .maybeSingle();
  const customerOrgNumber =
    (customerRow as { org_number?: string | null } | null)?.org_number ?? null;

  if (
    customerOrgNumber &&
    fileOrgNumber &&
    !orgNumbersMatch(customerOrgNumber, fileOrgNumber)
  ) {
    const message =
      `SIE file org number ${normalizeOrgNumber(fileOrgNumber)} does not match ` +
      `customer org number ${normalizeOrgNumber(customerOrgNumber)}. ` +
      `Connection is likely bound to the wrong Fortnox company; refusing to persist.`;
    console.error("[SIE sync]", message);

    // Flag the connection so the UI surfaces it and the nightly batch stops
    // re-pulling the wrong company's ledger every night.
    await admin
      .from("sie_connections")
      .update({
        connection_status: "error",
        last_error: message.slice(0, 2000),
      } as never)
      .eq("customer_id", opts.customerId);

    const importId = await recordFailedImport(admin, {
      customerId: opts.customerId,
      sieType,
      financialYearFrom,
      financialYearTo,
      byteSize: fetched.byteLength,
      status: "org_mismatch",
      errorMessage: message,
    });
    return failureResult({
      importId,
      status: "org_mismatch",
      errorMessage: message,
      durationMs: Date.now() - started,
    });
  }

  // ---------------------------------------------------------------------
  // Stage 3 — persist (best-effort, partial state is acceptable)
  // ---------------------------------------------------------------------
  try {
    await upsertAccounts(admin, opts.customerId, parsed);
    await upsertDimensions(admin, opts.customerId, parsed);
    await upsertObjects(admin, opts.customerId, parsed);

    await replaceAccountBalances(admin, opts.customerId, financialYearFrom, parsed);
    await replacePeriodBalances(admin, opts.customerId, financialYearFrom, parsed);
    await replaceObjectBalances(admin, opts.customerId, financialYearFrom, parsed);

    const { vouchers, transactions } = await replaceVouchersAndTransactions(
      admin,
      opts.customerId,
      financialYearFrom,
      parsed,
    );

    const counts = {
      accounts: parsed.accounts.length,
      dimensions: parsed.dimensions.length,
      objects: parsed.objects.length,
      account_balances: parsed.accountBalances.filter((b) => b.yearIndex === 0)
        .length,
      period_balances: parsed.periodBalances.filter((b) => b.yearIndex === 0)
        .length,
      object_balances: parsed.objectBalances.filter((b) => b.yearIndex === 0)
        .length,
      vouchers,
      transactions,
      warnings: parsed.warnings.length,
    };

    const importId = await recordSuccessImport(admin, {
      customerId: opts.customerId,
      sieType,
      financialYearFrom,
      financialYearTo,
      byteSize: fetched.byteLength,
      asOfDate: parsed.meta.periodCovered,
      fortnoxFnr: parsed.meta.fnr,
      companyName: parsed.meta.companyName,
      orgNumber: parsed.meta.orgNumber,
      chartType: parsed.meta.chartType,
      fortnoxFinancialYearId: fetched.financialYearId,
      parseWarnings: parsed.warnings,
    });

    // Touch sie_connections so the UI shows a recent last_synced_at.
    await admin
      .from("sie_connections")
      .update({ last_synced_at: new Date().toISOString() } as never)
      .eq("customer_id", opts.customerId);

    return {
      importId,
      status: "success",
      financialYearFrom,
      counts,
      warnings: parsed.warnings,
      errorMessage: null,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Persist failed.";
    console.error("[SIE sync] persist failed:", error);
    const importId = await recordFailedImport(admin, {
      customerId: opts.customerId,
      sieType,
      financialYearFrom,
      financialYearTo,
      byteSize: fetched.byteLength,
      status: "parse_error",
      errorMessage: message,
    });
    return failureResult({
      importId,
      status: "parse_error",
      errorMessage: message,
      durationMs: Date.now() - started,
    });
  }
}

// ---------------------------------------------------------------------------
// Persistence helpers — each handles ONE table group
// ---------------------------------------------------------------------------

async function upsertAccounts(
  admin: SupabaseClient,
  customerId: string,
  parsed: ParsedSieFile,
): Promise<void> {
  if (parsed.accounts.length === 0) return;
  const rows = parsed.accounts.map((a) => ({
    customer_id: customerId,
    account_number: a.number,
    account_name: a.name,
    account_type: a.type,
    sru_code: a.sru,
    unit: a.unit,
  }));
  const { error } = await admin
    .from("sie_accounts")
    .upsert(rows as never, { onConflict: "customer_id,account_number" } as never);
  if (error) throw new Error(`upsert sie_accounts: ${error.message}`);
}

async function upsertDimensions(
  admin: SupabaseClient,
  customerId: string,
  parsed: ParsedSieFile,
): Promise<void> {
  if (parsed.dimensions.length === 0) return;
  const rows = parsed.dimensions.map((d) => ({
    customer_id: customerId,
    dimension_number: d.number,
    dimension_name: d.name,
    parent_dimension_number: d.parent,
  }));
  const { error } = await admin
    .from("sie_dimensions")
    .upsert(rows as never, {
      onConflict: "customer_id,dimension_number",
    } as never);
  if (error) throw new Error(`upsert sie_dimensions: ${error.message}`);
}

async function upsertObjects(
  admin: SupabaseClient,
  customerId: string,
  parsed: ParsedSieFile,
): Promise<void> {
  if (parsed.objects.length === 0) return;
  const rows = parsed.objects.map((o) => ({
    customer_id: customerId,
    dimension_number: o.dimension,
    object_id: o.id,
    object_name: o.name,
  }));
  const { error } = await admin
    .from("sie_objects")
    .upsert(rows as never, {
      onConflict: "customer_id,dimension_number,object_id",
    } as never);
  if (error) throw new Error(`upsert sie_objects: ${error.message}`);
}

async function replaceAccountBalances(
  admin: SupabaseClient,
  customerId: string,
  financialYearFrom: string,
  parsed: ParsedSieFile,
): Promise<void> {
  // Wipe this year's balances, then re-insert. Idempotent under retry.
  const { error: delError } = await admin
    .from("sie_account_balances")
    .delete()
    .eq("customer_id", customerId)
    .eq("financial_year_from", financialYearFrom);
  if (delError) {
    throw new Error(`delete sie_account_balances: ${delError.message}`);
  }

  const rows = parsed.accountBalances
    .filter((b) => b.yearIndex === 0)
    .map((b) => ({
      customer_id: customerId,
      financial_year_from: financialYearFrom,
      kind: b.kind,
      account_number: b.accountNumber,
      amount: b.amount,
      quantity: b.quantity,
    }));
  if (rows.length === 0) return;
  // Insert in chunks of 1000 to stay well under Supabase's per-request size.
  for (const chunk of chunked(rows, 1000)) {
    const { error } = await admin
      .from("sie_account_balances")
      .insert(chunk as never);
    if (error) throw new Error(`insert sie_account_balances: ${error.message}`);
  }
}

async function replacePeriodBalances(
  admin: SupabaseClient,
  customerId: string,
  financialYearFrom: string,
  parsed: ParsedSieFile,
): Promise<void> {
  const { error: delError } = await admin
    .from("sie_period_balances")
    .delete()
    .eq("customer_id", customerId)
    .eq("financial_year_from", financialYearFrom);
  if (delError) {
    throw new Error(`delete sie_period_balances: ${delError.message}`);
  }

  const rows = parsed.periodBalances
    .filter((b) => b.yearIndex === 0)
    .map((b) => ({
      customer_id: customerId,
      financial_year_from: financialYearFrom,
      period: b.period,
      kind: b.kind,
      account_number: b.accountNumber,
      objects: b.objects,
      amount: b.amount,
      quantity: b.quantity,
    }));
  if (rows.length === 0) return;
  for (const chunk of chunked(rows, 1000)) {
    const { error } = await admin
      .from("sie_period_balances")
      .insert(chunk as never);
    if (error) throw new Error(`insert sie_period_balances: ${error.message}`);
  }
}

async function replaceObjectBalances(
  admin: SupabaseClient,
  customerId: string,
  financialYearFrom: string,
  parsed: ParsedSieFile,
): Promise<void> {
  const { error: delError } = await admin
    .from("sie_object_balances")
    .delete()
    .eq("customer_id", customerId)
    .eq("financial_year_from", financialYearFrom);
  if (delError) {
    throw new Error(`delete sie_object_balances: ${delError.message}`);
  }

  const rows = parsed.objectBalances
    .filter((b) => b.yearIndex === 0)
    .map((b) => ({
      customer_id: customerId,
      financial_year_from: financialYearFrom,
      kind: b.kind,
      account_number: b.accountNumber,
      objects: b.objects,
      amount: b.amount,
      quantity: b.quantity,
    }));
  if (rows.length === 0) return;
  for (const chunk of chunked(rows, 1000)) {
    const { error } = await admin
      .from("sie_object_balances")
      .insert(chunk as never);
    if (error) throw new Error(`insert sie_object_balances: ${error.message}`);
  }
}

async function replaceVouchersAndTransactions(
  admin: SupabaseClient,
  customerId: string,
  financialYearFrom: string,
  parsed: ParsedSieFile,
): Promise<{ vouchers: number; transactions: number }> {
  // Wipe this year's vouchers first; CASCADE on the FK in sie_transactions
  // takes care of their transactions automatically.
  const { error: delError } = await admin
    .from("sie_vouchers")
    .delete()
    .eq("customer_id", customerId)
    .eq("financial_year_from", financialYearFrom);
  if (delError) throw new Error(`delete sie_vouchers: ${delError.message}`);

  if (parsed.vouchers.length === 0) {
    return { vouchers: 0, transactions: 0 };
  }

  // Bulk-insert voucher headers, capturing IDs so we can wire the
  // transactions to them by (series, number) lookup.
  const voucherRows = parsed.vouchers.map((v) => ({
    customer_id: customerId,
    financial_year_from: financialYearFrom,
    series: v.series,
    voucher_number: v.number,
    voucher_date: v.date,
    voucher_text: v.text,
    registration_date: v.registrationDate,
    registered_by: v.registeredBy,
  }));

  const insertedVoucherIds = new Map<string, string>(); // key: "series|number"
  for (const chunk of chunked(voucherRows, 1000)) {
    const { data, error } = await admin
      .from("sie_vouchers")
      .insert(chunk as never)
      .select("id, series, voucher_number");
    if (error) throw new Error(`insert sie_vouchers: ${error.message}`);
    for (const row of (data ?? []) as Array<{
      id: string;
      series: string;
      voucher_number: string;
    }>) {
      insertedVoucherIds.set(`${row.series}|${row.voucher_number}`, row.id);
    }
  }

  // Flatten the parsed voucher transactions into a single insert payload,
  // resolving each to its newly-created voucher_id.
  const transRows: Array<Record<string, unknown>> = [];
  for (const voucher of parsed.vouchers) {
    const voucherId = insertedVoucherIds.get(
      `${voucher.series}|${voucher.number}`,
    );
    if (!voucherId) {
      // Shouldn't happen — every voucher we just inserted should be in the
      // map. Skip with a console warning rather than aborting the whole sync.
      console.warn(
        `[SIE sync] voucher ${voucher.series}/${voucher.number} missing after insert`,
      );
      continue;
    }
    voucher.transactions.forEach((t, idx) => {
      transRows.push({
        customer_id: customerId,
        voucher_id: voucherId,
        ordinal: idx,
        trans_type: t.type,
        account_number: t.accountNumber,
        objects: t.objects,
        amount: t.amount,
        quantity: t.quantity,
        transaction_date: t.date,
        transaction_text: t.text,
        registered_by: t.registeredBy,
      });
    });
  }

  for (const chunk of chunked(transRows, 1000)) {
    const { error } = await admin
      .from("sie_transactions")
      .insert(chunk as never);
    if (error) throw new Error(`insert sie_transactions: ${error.message}`);
  }

  return { vouchers: voucherRows.length, transactions: transRows.length };
}

// ---------------------------------------------------------------------------
// Import-row helpers (one place to write the audit row, success or failure)
// ---------------------------------------------------------------------------

interface SuccessImportInput {
  customerId: string;
  sieType: SieType;
  financialYearFrom: string;
  financialYearTo: string;
  byteSize: number | null;
  asOfDate: string | null;
  fortnoxFnr: string | null;
  companyName: string | null;
  orgNumber: string | null;
  chartType: string | null;
  fortnoxFinancialYearId: number | null;
  parseWarnings: string[];
}

async function recordSuccessImport(
  admin: SupabaseClient,
  input: SuccessImportInput,
): Promise<string | null> {
  const now = new Date().toISOString();
  const row = {
    customer_id: input.customerId,
    financial_year_from: input.financialYearFrom,
    financial_year_to: input.financialYearTo,
    fortnox_financial_year_id: input.fortnoxFinancialYearId,
    sie_type: input.sieType,
    as_of_date: input.asOfDate,
    fortnox_fnr: input.fortnoxFnr,
    company_name: input.companyName,
    org_number: input.orgNumber,
    chart_type: input.chartType,
    byte_size: input.byteSize,
    fetched_at: now,
    parsed_at: now,
    parse_warnings: input.parseWarnings,
    import_status: "success",
    error_message: null,
  };
  const { data, error } = await admin
    .from("sie_imports")
    .upsert(row as never, {
      onConflict: "customer_id,financial_year_from,sie_type",
    } as never)
    .select("id")
    .single();
  if (error) {
    console.error("[SIE sync] failed to record success import:", error);
    return null;
  }
  return (data as { id: string } | null)?.id ?? null;
}

interface FailedImportInput {
  customerId: string;
  sieType: SieType;
  financialYearFrom: string;
  financialYearTo: string;
  byteSize: number | null;
  status: "parse_error" | "fetch_error" | "org_mismatch";
  errorMessage: string;
}

async function recordFailedImport(
  admin: SupabaseClient,
  input: FailedImportInput,
): Promise<string | null> {
  const now = new Date().toISOString();
  const row = {
    customer_id: input.customerId,
    financial_year_from: input.financialYearFrom,
    financial_year_to: input.financialYearTo,
    sie_type: input.sieType,
    byte_size: input.byteSize,
    fetched_at: now,
    import_status: input.status,
    error_message: input.errorMessage.slice(0, 2000),
  };
  const { data, error } = await admin
    .from("sie_imports")
    .upsert(row as never, {
      onConflict: "customer_id,financial_year_from,sie_type",
    } as never)
    .select("id")
    .single();
  if (error) {
    console.error("[SIE sync] failed to record failed import:", error);
    return null;
  }
  return (data as { id: string } | null)?.id ?? null;
}

function failureResult(opts: {
  importId: string | null;
  status: "parse_error" | "fetch_error" | "org_mismatch";
  errorMessage: string;
  durationMs: number;
}): SyncSieResult {
  return {
    importId: opts.importId,
    status: opts.status,
    financialYearFrom: null,
    counts: {
      accounts: 0,
      dimensions: 0,
      objects: 0,
      account_balances: 0,
      period_balances: 0,
      object_balances: 0,
      vouchers: 0,
      transactions: 0,
      warnings: 0,
    },
    warnings: [],
    errorMessage: opts.errorMessage,
    durationMs: opts.durationMs,
  };
}

function* chunked<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) {
    yield items.slice(i, i + size);
  }
}
