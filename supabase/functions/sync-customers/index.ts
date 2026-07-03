import { createAdminClient } from "../_shared/supabase.ts"
import { getFortnoxClient, updateSyncJob, delay, corsHeaders } from "../_shared/sync-helpers.ts"

declare const Deno: {
  serve: (handler: (req: Request) => Response | Promise<Response>) => void
}

const RATE_LIMIT_DELAY_MS = 350
const BATCH_SIZE = 75
const LIST_PAGE_SIZE = 500
const CLEANUP_BATCH_SIZE = 200

function chunkArray<T>(items: T[], size: number): T[][] {
  if (items.length === 0) return []
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders() })
  }

  const supabase = createAdminClient()
  let jobId: string | null = null

  try {
    const body = await req.json().catch(() => ({}))
    jobId = body.job_id ?? null
    const offset: number = body.offset ?? 0
    const phase: string = body.phase ?? "list"

    const client = await getFortnoxClient(supabase)

    if (phase === "list") {
      if (jobId) {
        await updateSyncJob(supabase, jobId, {
          status: "processing",
          current_step: "Syncing cost centers...",
        })
      }

      const costCenterResponse = await client.getCostCenters()
      const costCenters = (costCenterResponse.CostCenters ?? []) as Array<{
        Code: string
        Description: string
        Active: boolean
      }>

      if (costCenters.length > 0) {
        const mapped = costCenters.map((cc) => ({
          code: cc.Code,
          name: cc.Description ?? null,
          active: cc.Active ?? true,
        }))

        await supabase
          .from("cost_centers")
          .upsert(mapped as never, { onConflict: "code" })
      }

      if (jobId) {
        await updateSyncJob(supabase, jobId, {
          current_step: "Fetching customer list...",
        })
      }

      const allCustomerNumbers: string[] = []
      let currentPage = 1
      let totalPages = 1

      do {
        const response = await client.getCustomers(currentPage, LIST_PAGE_SIZE)
        totalPages = response.MetaInformation["@TotalPages"]
        const customers = response.Customers ?? []

        for (const c of customers) {
          const num = c.CustomerNumber as string | undefined
          if (num) allCustomerNumbers.push(num)
        }

        currentPage++
        if (currentPage <= totalPages) await delay(RATE_LIMIT_DELAY_MS)
      } while (currentPage <= totalPages)

      const total = allCustomerNumbers.length

      if (jobId) {
        await updateSyncJob(supabase, jobId, {
          current_step: "Syncing customers...",
          total_items: total,
          processed_items: 0,
          payload: { step_name: "customers", step_label: "Customers", customer_numbers: allCustomerNumbers, synced: 0, errors: 0 },
          batch_phase: "process",
          batch_offset: 0,
          dispatch_lock: false,
        })
      }

      return new Response(
        JSON.stringify({ ok: true, phase: "list", total }),
        { headers: { ...corsHeaders(), "Content-Type": "application/json" } }
      )
    }

    if (phase === "process") {
      let customerNumbers: string[] = []
      let prevSynced = 0
      let prevErrors = 0

      if (jobId) {
        const { data: jobRow } = await supabase
          .from("sync_jobs")
          .select("payload, total_items")
          .eq("id", jobId)
          .single()

        const payload = (jobRow as unknown as { payload: Record<string, unknown> } | null)?.payload
        customerNumbers = (payload?.customer_numbers as string[]) ?? []
        prevSynced = (payload?.synced as number) ?? 0
        prevErrors = (payload?.errors as number) ?? 0
      }

      const total = customerNumbers.length
      const batch = customerNumbers.slice(offset, offset + BATCH_SIZE)

      let synced = prevSynced
      let errors = prevErrors

      for (const customerNumber of batch) {
        try {
          const response = await client.getCustomer(customerNumber)
          const fc = response.Customer as Record<string, unknown>

          const mapped = {
            fortnox_customer_number: fc.CustomerNumber as string,
            name: fc.Name as string,
            org_number: (fc.OrganisationNumber as string) ?? null,
            email: (fc.Email as string) ?? null,
            phone: (fc.Phone1 as string) ?? null,
            contact_name: (fc.YourReference as string) ?? null,
            address_line1: (fc.Address1 as string) ?? null,
            address_line2: (fc.Address2 as string) ?? null,
            zip_code: (fc.ZipCode as string) ?? null,
            city: (fc.City as string) ?? null,
            country: (fc.Country as string) ?? "SE",
            status: fc.Active ? "active" : "archived",
            fortnox_cost_center: (fc.CostCenter as string) ?? null,
            fortnox_active: (fc.Active as boolean) ?? null,
            fortnox_raw: fc,
            last_synced_at: new Date().toISOString(),
          }

          const { error: upsertError } = await supabase
            .from("customers")
            .upsert(mapped as never, {
              onConflict: "fortnox_customer_number",
              ignoreDuplicates: false,
            })

          if (upsertError) {
            console.error("Customer upsert error:", upsertError.message, upsertError.details)
            errors++
          } else {
            synced++
          }
        } catch {
          errors++
        }

        await delay(RATE_LIMIT_DELAY_MS)
      }

      const nextOffset = offset + BATCH_SIZE
      const isDone = nextOffset >= total
      const progress = Math.round((Math.min(nextOffset, total) / total) * (isDone ? 100 : 95))

      if (jobId) {
        await updateSyncJob(supabase, jobId, {
          progress,
          processed_items: Math.min(nextOffset, total),
          payload: { step_name: "customers", step_label: "Customers", customer_numbers: customerNumbers, synced, errors },
          current_step: isDone ? "Linking cost centers..." : `Syncing customers (${Math.min(nextOffset, total)}/${total})...`,
          batch_phase: isDone ? "finalize" : "process",
          batch_offset: isDone ? 0 : nextOffset,
          dispatch_lock: false,
        })
      }

      return new Response(
        JSON.stringify({ ok: true, phase: "process", processed: Math.min(nextOffset, total), total }),
        { headers: { ...corsHeaders(), "Content-Type": "application/json" } }
      )
    }

    if (phase === "finalize") {
      if (jobId) {
        await updateSyncJob(supabase, jobId, {
          current_step: "Cleaning up stale customers...",
          progress: 96,
        })
      }

      let syncedCustomerNumbers: string[] = []
      if (jobId) {
        const { data: jobRow } = await supabase
          .from("sync_jobs")
          .select("payload")
          .eq("id", jobId)
          .single()

        const payload = (jobRow as unknown as { payload: Record<string, unknown> } | null)?.payload
        syncedCustomerNumbers = ((payload?.customer_numbers as string[]) ?? []).filter(
          (value): value is string => typeof value === "string" && value.length > 0,
        )
      }

      const syncedNumberSet = new Set(syncedCustomerNumbers)
      const staleCustomerIds: string[] = []
      const staleCustomerNumbers: string[] = []
      let customerScanOffset = 0
      const customerScanPageSize = 1000

      while (true) {
        const { data: customerRows, error: customerScanError } = await supabase
          .from("customers")
          .select("id, fortnox_customer_number")
          .not("fortnox_customer_number", "is", null)
          .order("id", { ascending: true })
          .range(customerScanOffset, customerScanOffset + customerScanPageSize - 1)

        if (customerScanError) {
          throw new Error(`Failed to scan customers for cleanup: ${customerScanError.message}`)
        }

        const rows = (customerRows ?? []) as Array<{ id: string; fortnox_customer_number: string | null }>
        if (rows.length === 0) break

        for (const row of rows) {
          if (!row.fortnox_customer_number) continue
          if (!syncedNumberSet.has(row.fortnox_customer_number)) {
            staleCustomerIds.push(row.id)
            staleCustomerNumbers.push(row.fortnox_customer_number)
          }
        }

        if (rows.length < customerScanPageSize) break
        customerScanOffset += customerScanPageSize
      }

      let removedInvoiceRows = 0
      let removedInvoices = 0
      let removedTimeReports = 0
      let removedContractAccruals = 0
      let removedCustomers = 0

      if (staleCustomerIds.length > 0) {
        if (jobId) {
          await updateSyncJob(supabase, jobId, {
            current_step: `Removing stale data for ${staleCustomerIds.length} customers...`,
            progress: 97,
          })
        }

        const staleInvoiceNumbers: string[] = []
        for (const customerNumberChunk of chunkArray(staleCustomerNumbers, CLEANUP_BATCH_SIZE)) {
          const { data: invoiceRows, error: invoiceScanError } = await supabase
            .from("invoices")
            .select("document_number")
            .in("fortnox_customer_number", customerNumberChunk as never)

          if (invoiceScanError) {
            throw new Error(`Failed to scan stale invoices: ${invoiceScanError.message}`)
          }

          for (const invoice of (invoiceRows ?? []) as Array<{ document_number: string }>) {
            if (invoice.document_number) staleInvoiceNumbers.push(invoice.document_number)
          }
        }

        for (const invoiceNumberChunk of chunkArray(staleInvoiceNumbers, CLEANUP_BATCH_SIZE)) {
          const { count, error } = await supabase
            .from("invoice_rows")
            .delete({ count: "exact" })
            .in("invoice_number", invoiceNumberChunk as never)

          if (error) {
            throw new Error(`Failed to delete stale invoice rows: ${error.message}`)
          }
          removedInvoiceRows += count ?? 0
        }

        for (const customerNumberChunk of chunkArray(staleCustomerNumbers, CLEANUP_BATCH_SIZE)) {
          const { count, error } = await supabase
            .from("invoices")
            .delete({ count: "exact" })
            .in("fortnox_customer_number", customerNumberChunk as never)

          if (error) {
            throw new Error(`Failed to delete stale invoices by customer number: ${error.message}`)
          }
          removedInvoices += count ?? 0
        }

        for (const customerIdChunk of chunkArray(staleCustomerIds, CLEANUP_BATCH_SIZE)) {
          const { count, error } = await supabase
            .from("invoices")
            .delete({ count: "exact" })
            .in("customer_id", customerIdChunk as never)

          if (error) {
            throw new Error(`Failed to delete stale invoices by customer id: ${error.message}`)
          }
          removedInvoices += count ?? 0
        }

        for (const customerNumberChunk of chunkArray(staleCustomerNumbers, CLEANUP_BATCH_SIZE)) {
          const { count, error } = await supabase
            .from("time_reports")
            .delete({ count: "exact" })
            .in("fortnox_customer_number", customerNumberChunk as never)

          if (error) {
            throw new Error(`Failed to delete stale time reports by customer number: ${error.message}`)
          }
          removedTimeReports += count ?? 0
        }

        for (const customerIdChunk of chunkArray(staleCustomerIds, CLEANUP_BATCH_SIZE)) {
          const { count, error } = await supabase
            .from("time_reports")
            .delete({ count: "exact" })
            .in("customer_id", customerIdChunk as never)

          if (error) {
            throw new Error(`Failed to delete stale time reports by customer id: ${error.message}`)
          }
          removedTimeReports += count ?? 0
        }

        for (const customerNumberChunk of chunkArray(staleCustomerNumbers, CLEANUP_BATCH_SIZE)) {
          const { count, error } = await supabase
            .from("contract_accruals")
            .delete({ count: "exact" })
            .in("fortnox_customer_number", customerNumberChunk as never)

          if (error) {
            throw new Error(`Failed to delete stale contract accruals: ${error.message}`)
          }
          removedContractAccruals += count ?? 0
        }

        for (const customerIdChunk of chunkArray(staleCustomerIds, CLEANUP_BATCH_SIZE)) {
          const { count, error } = await supabase
            .from("customers")
            .delete({ count: "exact" })
            .in("id", customerIdChunk as never)

          if (error) {
            throw new Error(`Failed to delete stale customers: ${error.message}`)
          }
          removedCustomers += count ?? 0
        }
      }

      if (jobId) {
        await updateSyncJob(supabase, jobId, {
          current_step: "Linking cost centers to profiles...",
          progress: 98,
        })
      }

      const { data: activeCostCenters } = await supabase
        .from("cost_centers")
        .select("code, name")
        .eq("active", true)

      const { data: profiles } = await supabase
        .from("profiles")
        .select("id, full_name")
        .eq("is_active", true)

      if (activeCostCenters && profiles) {
        const nameToProfileId = new Map<string, string>()
        for (const p of profiles as Array<{ id: string; full_name: string | null }>) {
          if (p.full_name) {
            nameToProfileId.set(p.full_name.replace(/\s+/g, " ").trim().toLowerCase(), p.id)
          }
        }

        for (const cc of activeCostCenters as Array<{ code: string; name: string | null }>) {
          if (!cc.name) continue
          const profileId = nameToProfileId.get(cc.name.replace(/\s+/g, " ").trim().toLowerCase())
          if (profileId) {
            await supabase
              .from("profiles")
              .update({ fortnox_cost_center: cc.code } as never)
              .eq("id", profileId as never)
          }
        }
      }

      // Duplicate detection: two Fortnox customers with the same org number
      // (e.g. the company was set up twice in Fortnox) become two separate CRM
      // customers, splitting invoices/contracts/turnover across them — which
      // makes reports look empty for the "wrong" twin. We only WARN here: the
      // durable fix is in Fortnox (merge/remove the duplicate), and the next
      // sync would recreate anything we deleted, so we never auto-merge.
      if (jobId) {
        await updateSyncJob(supabase, jobId, {
          current_step: "Checking for duplicate customers...",
          progress: 99,
        })
      }

      const customersByOrg = new Map<
        string,
        Array<{ id: string; name: string; fortnox_customer_number: string | null }>
      >()
      let dupScanOffset = 0
      const dupScanPageSize = 1000
      while (true) {
        const { data: orgRows, error: orgScanError } = await supabase
          .from("customers")
          .select("id, name, org_number, fortnox_customer_number")
          .not("org_number", "is", null)
          .neq("org_number", "")
          .order("id", { ascending: true })
          .range(dupScanOffset, dupScanOffset + dupScanPageSize - 1)

        if (orgScanError) {
          console.error("Duplicate scan failed:", orgScanError.message)
          break
        }

        const rows = (orgRows ?? []) as Array<{
          id: string
          name: string
          org_number: string | null
          fortnox_customer_number: string | null
        }>
        if (rows.length === 0) break

        for (const row of rows) {
          // Normalise to digits only so "556123-4567" and "5561234567" match.
          const key = (row.org_number ?? "").replace(/\D/g, "")
          if (!key) continue
          const list = customersByOrg.get(key) ?? []
          list.push({
            id: row.id,
            name: row.name,
            fortnox_customer_number: row.fortnox_customer_number,
          })
          customersByOrg.set(key, list)
        }

        if (rows.length < dupScanPageSize) break
        dupScanOffset += dupScanPageSize
      }

      const duplicateCustomers: Array<{
        org_number: string
        customers: Array<{ id: string; name: string; fortnox_customer_number: string | null }>
      }> = []
      for (const [org, list] of customersByOrg) {
        if (list.length > 1) {
          duplicateCustomers.push({ org_number: org, customers: list })
          console.warn(
            `Duplicate customers for org ${org}: ${list
              .map((c) => `${c.name} (#${c.fortnox_customer_number ?? "—"})`)
              .join(", ")} — merge in Fortnox.`,
          )
        }
      }

      await supabase
        .from("fortnox_connection")
        .update({
          sync_status: "idle",
          sync_error: null,
          last_sync_at: new Date().toISOString(),
        } as never)
        .neq("id", "" as never)

      let finalSynced = 0
      let finalErrors = 0
      let finalTotal = 0

      if (jobId) {
        const { data: jobRow } = await supabase
          .from("sync_jobs")
          .select("payload, total_items")
          .eq("id", jobId)
          .single()

        const payload = (jobRow as unknown as { payload: Record<string, unknown> } | null)?.payload
        finalSynced = (payload?.synced as number) ?? 0
        finalErrors = (payload?.errors as number) ?? 0
        finalTotal = (jobRow as unknown as { total_items: number } | null)?.total_items ?? 0

        await updateSyncJob(supabase, jobId, {
          status: "completed",
          progress: 100,
          current_step: "Done",
          processed_items: finalTotal,
          payload: {
            step_name: "customers",
            step_label: "Customers",
            synced: finalSynced,
            errors: finalErrors,
            total: finalTotal,
            stale_customers_removed: removedCustomers,
            stale_invoice_rows_removed: removedInvoiceRows,
            stale_invoices_removed: removedInvoices,
            stale_time_reports_removed: removedTimeReports,
            stale_contract_accruals_removed: removedContractAccruals,
            duplicate_customers: duplicateCustomers,
          },
          batch_phase: null,
          dispatch_lock: false,
        })
      }

      return new Response(
        JSON.stringify({ ok: true, done: true, synced: finalSynced, errors: finalErrors, total: finalTotal }),
        { headers: { ...corsHeaders(), "Content-Type": "application/json" } }
      )
    }

    return new Response(
      JSON.stringify({ error: `Unknown phase: ${phase}` }),
      { status: 400, headers: { ...corsHeaders(), "Content-Type": "application/json" } }
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error"
    console.error("sync-customers error:", message)

    if (jobId) {
      await updateSyncJob(supabase, jobId, {
        status: "failed",
        error_message: message,
        dispatch_lock: false,
        batch_phase: null,
      })
    }

    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders(), "Content-Type": "application/json" } }
    )
  }
})
