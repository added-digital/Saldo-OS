import { createAdminClient } from "../_shared/supabase.ts";
import {
  getFortnoxClient,
  updateSyncJob,
  delay,
  corsHeaders,
} from "../_shared/sync-helpers.ts";
import { FortnoxApiError } from "../_shared/fortnox-client.ts";

declare const Deno: {
  serve: (handler: (req: Request) => Response | Promise<Response>) => void;
};

const LIST_PAGE_SIZE = 500;
const INVOICE_FROM_DATE = "2025-01-01";
const DETAIL_BATCH_SIZE = 25;
const DETAIL_DELAY_MS = 200;
const MAX_DETAILS_PER_INVOCATION = 150;
const KPI_BATCH_SIZE = 3000;
const CUSTOMER_DB_PAGE_SIZE = 1000;

type InvoiceRowInsert = {
  invoice_number: string;
  article_number: string | null;
  article_name: string | null;
  description: string | null;
  quantity: number | null;
  unit_price: number | null;
  total_ex_vat: number | null;
  total: number | null;
};

type InvoiceInsert = {
  document_number: string;
  customer_id: string | null;
  fortnox_customer_number: string;
  customer_name: string | null;
  invoice_date: string | null;
  due_date: string | null;
  final_pay_date: string | null;
  booked: boolean;
  total_vat: number | null;
  total_ex_vat: number | null;
  total: number | null;
  balance: number | null;
  currency_code: string;
};

function logSyncEvent(event: string, context: Record<string, unknown>) {
  console.log(
    JSON.stringify({
      scope: "sync-invoices",
      event,
      ...context,
    }),
  );
}

function readNumberField(
  record: Record<string, unknown>,
  keys: string[],
): number | null {
  for (const key of keys) {
    const value = record[key];
    if (value == null) continue;
    const numeric = Number(value);
    if (!Number.isNaN(numeric)) {
      return numeric;
    }
  }

  return null;
}

function resolveInvoiceTotals(record: Record<string, unknown>): {
  total: number | null;
  totalVat: number | null;
  totalExVat: number | null;
} {
  const total = readNumberField(record, ["Total", "TotalToPay", "TotalAmount"]);
  const totalVat = readNumberField(record, [
    "TotalVAT",
    "TotalVat",
    "VatTotal",
    "VATTotal",
  ]);

  const totalExVat =
    total != null && totalVat != null ? total - totalVat : null;

  return {
    total,
    totalVat,
    totalExVat,
  };
}

function resolveInvoiceRowQuantity(
  record: Record<string, unknown>,
): number | null {
  return readNumberField(record, ["DeliveredQuantity", "Quantity"]);
}

function resolveInvoiceRowExVatTotal(
  record: Record<string, unknown>,
  quantity: number | null,
): number | null {
  const explicitLineExVat = readNumberField(record, [
    "RowAmountExcludingVAT",
    "RowAmountExcludingVat",
    "TotalExcludingVAT",
    "TotalExcludingVat",
    "TotalExVAT",
    "TotalExVat",
    "Net",
    "NetAmount",
    "TotalNet",
  ]);

  if (explicitLineExVat != null) {
    return explicitLineExVat;
  }

  const unitExVat = readNumberField(record, [
    "PriceExcludingVAT",
    "PriceExcludingVat",
    "Price",
    "UnitPrice",
  ]);

  if (unitExVat == null) {
    return null;
  }

  if (quantity != null) {
    return unitExVat * quantity;
  }

  return unitExVat;
}

function toInvoiceRows(
  invoiceNumber: string,
  invoicePayload: Record<string, unknown> | null | undefined,
): InvoiceRowInsert[] {
  const rawRows = (invoicePayload?.InvoiceRows ??
    invoicePayload?.Rows ??
    []) as unknown[];
  if (!Array.isArray(rawRows)) return [];

  return rawRows
    .filter(
      (row): row is Record<string, unknown> =>
        Boolean(row && typeof row === "object"),
    )
    .map((row) => {
      const price = readNumberField(row, ["Price", "UnitPrice"]);
      const quantity = resolveInvoiceRowQuantity(row);
      if (price === 0) {
        return null;
      }

      return {
        invoice_number: invoiceNumber,
        article_number:
          row.ArticleNumber != null
            ? String(row.ArticleNumber)
            : row.ArticleNo != null
              ? String(row.ArticleNo)
              : null,
        article_name:
          row.ArticleName != null ? String(row.ArticleName) : null,
        description: row.Description != null ? String(row.Description) : null,
        quantity,
        unit_price: price,
        total_ex_vat: resolveInvoiceRowExVatTotal(row, quantity),
        total: row.Total != null ? Number(row.Total) : null,
      };
    })
    .filter((row): row is InvoiceRowInsert => row !== null);
}

async function loadCustomerMap(
  supabase: ReturnType<typeof createAdminClient>,
): Promise<Map<string, string>> {
  const customerMap = new Map<string, string>();
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from("customers")
      .select("id, fortnox_customer_number")
      .order("id", { ascending: true })
      .range(offset, offset + CUSTOMER_DB_PAGE_SIZE - 1);

    if (error) {
      throw new Error(`Failed to read customers: ${error.message}`);
    }

    const rows = (data ?? []) as Array<{
      id: string;
      fortnox_customer_number: string | null;
    }>;

    if (rows.length === 0) break;

    for (const c of rows) {
      if (c.fortnox_customer_number) {
        customerMap.set(c.fortnox_customer_number, c.id);
      }
    }

    if (rows.length < CUSTOMER_DB_PAGE_SIZE) break;
    offset += CUSTOMER_DB_PAGE_SIZE;
  }

  return customerMap;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders() });
  }

  const supabase = createAdminClient();
  let jobId: string | null = null;

  try {
    const body = await req.json().catch(() => ({}));
    jobId = body.job_id ?? null;
    const phase: string = body.phase ?? "list";
    const offset: number = body.offset ?? 0;
    let detailOffset: number = body.detail_offset ?? 0;

    let syncMode = "enrich_all";

    if (detailOffset === 0 && jobId) {
      const { data: jobPayloadRow } = await supabase
        .from("sync_jobs")
        .select("payload")
        .eq("id", jobId)
        .maybeSingle();

      const jobPayload = (
        jobPayloadRow as unknown as { payload: Record<string, unknown> } | null
      )?.payload;
      detailOffset = (jobPayload?.detail_offset as number) ?? 0;
      if (typeof jobPayload?.sync_mode === "string") {
        syncMode = jobPayload.sync_mode;
      }
    }

    logSyncEvent("request_received", {
      job_id: jobId,
      phase,
      offset,
      detail_offset: detailOffset,
      sync_mode: syncMode,
    });

    const client = await getFortnoxClient(supabase);

    if (phase === "list") {
      const listFromDate = INVOICE_FROM_DATE;

      let prevSynced = 0;
      let prevErrors = 0;
      let prevSkipped = 0;
      let prevDetailFetched = 0;
      let prevDetailSkipped = 0;
      let totalPages = 1;
      let savedDetailDocNumbers: string[] | null = null;

      if (jobId) {
        const { data: jobRow } = await supabase
          .from("sync_jobs")
          .select("payload")
          .eq("id", jobId)
          .maybeSingle();

        const payload = (
          jobRow as unknown as { payload: Record<string, unknown> } | null
        )?.payload;
        prevSynced = (payload?.synced as number) ?? 0;
        prevErrors = (payload?.errors as number) ?? 0;
        prevSkipped = (payload?.skipped as number) ?? 0;
        prevDetailFetched = (payload?.detail_fetched as number) ?? 0;
        prevDetailSkipped = (payload?.detail_skipped as number) ?? 0;
        totalPages = (payload?.total_pages as number) ?? 1;
        if (typeof payload?.sync_mode === "string") {
          syncMode = payload.sync_mode;
        }

        if (detailOffset > 0 && Array.isArray(payload?.detail_doc_numbers)) {
          savedDetailDocNumbers = payload.detail_doc_numbers as string[];
        }
      }

      const skipFinalized = syncMode === "skip_finalized";

      let synced = prevSynced;
      let errors = prevErrors;
      let skipped = prevSkipped;
      let detailFetched = prevDetailFetched;
      let detailSkippedFinalized = prevDetailSkipped;
      let firstError: string | null = null;

      const currentPage = offset > 0 ? offset : 1;

      let detailDocNumbersAll: string[] = [];

      if (savedDetailDocNumbers) {
        detailDocNumbersAll = savedDetailDocNumbers;

        logSyncEvent("detail_continuation", {
          job_id: jobId,
          page: currentPage,
          detail_offset: detailOffset,
          total_detail_docs: detailDocNumbersAll.length,
        });
      } else {
        if (jobId) {
          await updateSyncJob(supabase, jobId, {
            status: "processing",
            current_step: `Loading customers and fetching invoices from ${listFromDate}...`,
          });
        }

        const customerMap = await loadCustomerMap(supabase);

        logSyncEvent("customer_map_loaded", {
          job_id: jobId,
          customer_count: customerMap.size,
        });

        const response = await client.getInvoices(currentPage, LIST_PAGE_SIZE, {
          fromDate: listFromDate,
          sortBy: "documentnumber",
        });

        totalPages = response.MetaInformation["@TotalPages"];
        const rawInvoices = response.Invoices ?? [];

        logSyncEvent("invoice_page_fetched", {
          job_id: jobId,
          page: currentPage,
          total_pages: totalPages,
          invoice_count: rawInvoices.length,
        });

        const allDocumentNumbers: string[] = [];
        const parsedInvoices: Array<{
          insert: InvoiceInsert;
          documentNumber: string;
        }> = [];

        for (const inv of rawInvoices as Array<Record<string, unknown>>) {
          const documentNumber =
            inv.DocumentNumber != null ? String(inv.DocumentNumber) : null;
          if (!documentNumber) {
            skipped++;
            continue;
          }

          const customerNumber =
            inv.CustomerNumber != null ? String(inv.CustomerNumber) : null;
          if (!customerNumber || !customerMap.has(customerNumber)) {
            skipped++;
            continue;
          }

          const totals = resolveInvoiceTotals(inv);

          parsedInvoices.push({
            documentNumber,
            insert: {
              document_number: documentNumber,
              customer_id: customerMap.get(customerNumber) ?? null,
              fortnox_customer_number: customerNumber,
              customer_name:
                inv.CustomerName != null ? String(inv.CustomerName) : null,
              invoice_date:
                inv.InvoiceDate != null ? String(inv.InvoiceDate) : null,
              due_date: inv.DueDate != null ? String(inv.DueDate) : null,
              final_pay_date:
                inv.FinalPayDate != null ? String(inv.FinalPayDate) : null,
              booked: inv.Booked != null ? Boolean(inv.Booked) : false,
              total_vat: totals.totalVat,
              total_ex_vat: totals.totalExVat,
              total: totals.total,
              balance: inv.Balance != null ? Number(inv.Balance) : null,
              currency_code: inv.Currency != null ? String(inv.Currency) : "SEK",
            },
          });

          allDocumentNumbers.push(documentNumber);
        }

        const finalizedDocNumbers = new Set<string>();
        if (skipFinalized && allDocumentNumbers.length > 0) {
          const FINALIZED_QUERY_BATCH = 500;
          for (
            let fi = 0;
            fi < allDocumentNumbers.length;
            fi += FINALIZED_QUERY_BATCH
          ) {
            const slice = allDocumentNumbers.slice(
              fi,
              fi + FINALIZED_QUERY_BATCH,
            );
            const { data: finalizedRows } = await supabase
              .from("invoices")
              .select("document_number")
              .in("document_number", slice as never)
              .not("final_pay_date", "is", null)
              .eq("booked", true as never);

            for (const r of (finalizedRows ?? []) as Array<{
              document_number: string;
            }>) {
              finalizedDocNumbers.add(r.document_number);
            }
          }
        }

        const invoicesToUpsert = parsedInvoices
          .filter((p) => !finalizedDocNumbers.has(p.documentNumber))
          .map((p) => p.insert);

        const documentNumbersForDetail = allDocumentNumbers.filter(
          (dn) => !finalizedDocNumbers.has(dn),
        );

        detailSkippedFinalized += finalizedDocNumbers.size;

        if (finalizedDocNumbers.size > 0) {
          logSyncEvent("skipped_finalized", {
            job_id: jobId,
            page: currentPage,
            skipped_upsert: finalizedDocNumbers.size,
            skipped_total: detailSkippedFinalized,
            remaining_upsert: invoicesToUpsert.length,
            remaining_detail: documentNumbersForDetail.length,
          });
        }

        if (invoicesToUpsert.length > 0) {
          const { error: upsertError } = await supabase
            .from("invoices")
            .upsert(invoicesToUpsert as never, {
              onConflict: "document_number",
            });

          if (upsertError) {
            if (!firstError) firstError = upsertError.message;
            errors += invoicesToUpsert.length;
            logSyncEvent("invoice_upsert_error", {
              job_id: jobId,
              page: currentPage,
              count: invoicesToUpsert.length,
              error: upsertError.message,
            });
          } else {
            synced += invoicesToUpsert.length;
            logSyncEvent("invoice_upsert_success", {
              job_id: jobId,
              page: currentPage,
              count: invoicesToUpsert.length,
            });
          }
        }

        detailDocNumbersAll = documentNumbersForDetail;
      }

      const detailDocNumbers = detailDocNumbersAll.slice(detailOffset);
      const detailChunk = detailDocNumbers.slice(0, MAX_DETAILS_PER_INVOCATION);
      const hasMoreDetails = detailDocNumbers.length > MAX_DETAILS_PER_INVOCATION;
      const nextDetailOffset = hasMoreDetails ? detailOffset + MAX_DETAILS_PER_INVOCATION : 0;

      const allRowInserts: InvoiceRowInsert[] = [];
      const detailFetchedNumbers: string[] = [];
      const detailTotalsUpdates: Array<{
        document_number: string;
        total: number | null;
        total_vat: number | null;
        total_ex_vat: number | null;
      }> = [];

      for (let i = 0; i < detailChunk.length; i += DETAIL_BATCH_SIZE) {
        const batch = detailChunk.slice(i, i + DETAIL_BATCH_SIZE);

        for (const docNum of batch) {
          try {
            const invoiceResponse = await client.getInvoice(docNum);
            const detail = (invoiceResponse.Invoice ?? null) as Record<
              string,
              unknown
            > | null;

            if (detail) {
              detailFetchedNumbers.push(docNum);
              allRowInserts.push(...toInvoiceRows(docNum, detail));
              detailFetched++;

              const enrichedTotals = resolveInvoiceTotals(detail);
              detailTotalsUpdates.push({
                document_number: docNum,
                total: enrichedTotals.total,
                total_vat: enrichedTotals.totalVat,
                total_ex_vat: enrichedTotals.totalExVat,
              });
            }
          } catch (detailError) {
            const is404 =
              detailError instanceof FortnoxApiError &&
              detailError.status === 404;

            if (is404) {
              logSyncEvent("invoice_detail_not_found", {
                job_id: jobId,
                document_number: docNum,
              });
            } else {
              if (!firstError) {
                firstError =
                  detailError instanceof Error
                    ? detailError.message
                    : "Invoice detail fetch failed";
              }
              errors++;
              logSyncEvent("invoice_detail_fetch_error", {
                job_id: jobId,
                document_number: docNum,
                error:
                  detailError instanceof Error
                    ? detailError.message
                    : "Invoice detail fetch failed",
              });
            }
          }

          await delay(DETAIL_DELAY_MS);
        }
      }

      if (detailFetchedNumbers.length > 0) {
        const { error: deleteRowsError } = await supabase
          .from("invoice_rows")
          .delete()
          .in("invoice_number", detailFetchedNumbers as never);

        if (deleteRowsError) {
          if (!firstError) firstError = deleteRowsError.message;
          errors += detailFetchedNumbers.length;
          logSyncEvent("invoice_rows_delete_error", {
            job_id: jobId,
            count: detailFetchedNumbers.length,
            error: deleteRowsError.message,
          });
        } else if (allRowInserts.length > 0) {
          const { error: insertRowsError } = await supabase
            .from("invoice_rows")
            .insert(allRowInserts as never);

          if (insertRowsError) {
            if (!firstError) firstError = insertRowsError.message;
            errors += allRowInserts.length;
            logSyncEvent("invoice_rows_insert_error", {
              job_id: jobId,
              count: allRowInserts.length,
              error: insertRowsError.message,
            });
          } else {
            logSyncEvent("invoice_rows_insert_success", {
              job_id: jobId,
              count: allRowInserts.length,
            });
          }
        }
      }

      if (detailTotalsUpdates.length > 0) {
        for (const upd of detailTotalsUpdates) {
          const { error: updError } = await supabase
            .from("invoices")
            .update({
              total: upd.total,
              total_vat: upd.total_vat,
              total_ex_vat: upd.total_ex_vat,
            } as never)
            .eq("document_number", upd.document_number as never);

          if (updError) {
            logSyncEvent("invoice_totals_update_error", {
              job_id: jobId,
              document_number: upd.document_number,
              error: updError.message,
            });
          }
        }

        logSyncEvent("invoice_totals_enriched", {
          job_id: jobId,
          count: detailTotalsUpdates.length,
        });
      }

      const morePages = currentPage < totalPages;
      const nextPage = currentPage + 1;
      const needsContinuation = hasMoreDetails || morePages;

      if (jobId) {
        const progress = totalPages > 0
          ? Math.round((currentPage / totalPages) * (needsContinuation ? 85 : 90))
          : 90;

        const updatePayload: Record<string, unknown> = {
          step_name: "invoices",
          step_label: "Invoices",
          sync_mode: syncMode,
          synced,
          errors,
          skipped,
          detail_fetched: detailFetched,
          detail_skipped: detailSkippedFinalized,
          total_pages: totalPages,
        };
        if (firstError) updatePayload.first_error = firstError;

        if (hasMoreDetails) {
          updatePayload.detail_offset = nextDetailOffset;
          updatePayload.detail_doc_numbers = detailDocNumbersAll;
          await updateSyncJob(supabase, jobId, {
            current_step: `Syncing invoice details (page ${currentPage}/${totalPages}, batch ${detailOffset / MAX_DETAILS_PER_INVOCATION + 1}, ${synced} saved)...`,
            total_items: totalPages,
            processed_items: currentPage,
            progress,
            payload: updatePayload,
            batch_phase: "list",
            batch_offset: currentPage,
            dispatch_lock: false,
          });
        } else if (morePages) {
          await updateSyncJob(supabase, jobId, {
            current_step: `Syncing invoices (page ${currentPage}/${totalPages}, ${synced} saved)...`,
            total_items: totalPages,
            processed_items: currentPage,
            progress,
            payload: updatePayload,
            batch_phase: "list",
            batch_offset: nextPage,
            dispatch_lock: false,
          });
        } else {
          await updateSyncJob(supabase, jobId, {
            total_items: synced + skipped + errors,
            processed_items: synced + skipped + errors,
            progress: 90,
            current_step:
              errors > 0
                ? `Synced with ${errors} errors, computing KPIs...`
                : `${synced} invoices saved (${skipped} skipped), computing KPIs...`,
            payload: updatePayload,
            batch_phase: "finalize",
            batch_offset: 0,
            dispatch_lock: false,
          });
        }
      }

      logSyncEvent("list_phase_completed", {
        job_id: jobId,
        page: currentPage,
        total_pages: totalPages,
        synced,
        errors,
        skipped,
        detail_fetched: detailFetched,
        detail_skipped: detailSkippedFinalized,
        detail_chunk_size: detailChunk.length,
        has_more_details: hasMoreDetails,
        more_pages: morePages,
      });

      return new Response(
        JSON.stringify({
          ok: true,
          phase: "list",
          page: currentPage,
          totalPages,
          morePages,
          hasMoreDetails,
          synced,
          errors,
          skipped,
          detailFetched,
          detailSkipped: detailSkippedFinalized,
        }),
        { headers: { ...corsHeaders(), "Content-Type": "application/json" } },
      );
    }

    if (phase === "finalize") {
      if (jobId) {
        await updateSyncJob(supabase, jobId, {
          current_step: "Computing invoice KPIs...",
          progress: 92,
        });
      }

      const turnoverByCustomer = new Map<
        string,
        { turnover: number; count: number }
      >();
      let kpiOffset = 0;

      while (true) {
        const { data: kpiRows, error: kpiError } = await supabase
          .from("invoices")
          .select("fortnox_customer_number, total_ex_vat")
          .range(kpiOffset, kpiOffset + KPI_BATCH_SIZE - 1);

        if (kpiError) {
          throw new Error(`Failed to fetch invoice KPIs: ${kpiError.message}`);
        }

        const rows = (kpiRows ?? []) as Array<{
          fortnox_customer_number: string | null;
          total_ex_vat: number | null;
        }>;
        if (rows.length === 0) break;

        for (const row of rows) {
          if (!row.fortnox_customer_number) continue;
          const existing = turnoverByCustomer.get(
            row.fortnox_customer_number,
          ) ?? { turnover: 0, count: 0 };
          existing.turnover += Number(row.total_ex_vat ?? 0);
          existing.count += 1;
          turnoverByCustomer.set(row.fortnox_customer_number, existing);
        }

        if (rows.length < KPI_BATCH_SIZE) break;
        kpiOffset += KPI_BATCH_SIZE;
      }

      for (const [customerNumber, kpi] of turnoverByCustomer) {
        await supabase
          .from("customers")
          .update({
            total_turnover: kpi.turnover,
            invoice_count: kpi.count,
          } as never)
          .eq("fortnox_customer_number", customerNumber as never);
      }

      let finalSynced = 0;
      let finalErrors = 0;
      let finalTotal = 0;

      if (jobId) {
        const { data: jobRow } = await supabase
          .from("sync_jobs")
          .select("payload, total_items")
          .eq("id", jobId)
          .single();

        const payload = (
          jobRow as unknown as { payload: Record<string, unknown> } | null
        )?.payload;
        finalSynced = (payload?.synced as number) ?? 0;
        finalErrors = (payload?.errors as number) ?? 0;
        finalTotal =
          (jobRow as unknown as { total_items: number } | null)?.total_items ??
          0;

        await updateSyncJob(supabase, jobId, {
          status: "completed",
          progress: 100,
          current_step: "Done",
          processed_items: finalTotal,
          payload: {
            step_name: "invoices",
            step_label: "Invoices",
            synced: finalSynced,
            errors: finalErrors,
            total: finalTotal,
          },
          batch_phase: null,
          dispatch_lock: false,
        });
      }

      logSyncEvent("finalize_phase_completed", {
        job_id: jobId,
        synced: finalSynced,
        errors: finalErrors,
        total: finalTotal,
      });

      return new Response(
        JSON.stringify({
          ok: true,
          done: true,
          synced: finalSynced,
          errors: finalErrors,
          total: finalTotal,
        }),
        { headers: { ...corsHeaders(), "Content-Type": "application/json" } },
      );
    }

    return new Response(JSON.stringify({ error: `Unknown phase: ${phase}` }), {
      status: 400,
      headers: { ...corsHeaders(), "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logSyncEvent("sync_error", {
      job_id: jobId,
      error: message,
    });

    if (jobId) {
      await updateSyncJob(supabase, jobId, {
        status: "failed",
        error_message: message,
        dispatch_lock: false,
        batch_phase: null,
      });
    }

    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders(), "Content-Type": "application/json" },
    });
  }
});
