import { createAdminClient } from "../_shared/supabase.ts"
import { getFortnoxClient, updateSyncJob, delay, corsHeaders } from "../_shared/sync-helpers.ts"

declare const Deno: {
  serve: (handler: (req: Request) => Response | Promise<Response>) => void
}

const RATE_LIMIT_DELAY_MS = 350
const BATCH_SIZE = 80
const KPI_BATCH_SIZE = 3000
const MAX_INVOCATION_MS = 110_000

function readNumberField(
  record: Record<string, unknown>,
  keys: string[],
): number | null {
  for (const key of keys) {
    const value = record[key]
    if (value == null) continue
    const numeric = Number(value)
    if (!Number.isNaN(numeric)) {
      return numeric
    }
  }

  return null
}

function resolveExVatTotal(record: Record<string, unknown>): number | null {
  return readNumberField(record, [
    "TotalExcludingVAT",
    "TotalExcludingVat",
    "TotalExVAT",
    "TotalExVat",
    "Net",
    "NetAmount",
    "TotalNet",
  ])
}

function isFortnoxActive(value: unknown): boolean {
  if (value === true) return true
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase()
    return normalized === "true" || normalized === "1"
  }
  if (typeof value === "number") {
    return value === 1
  }

  return false
}

function annualizeContractTotal(total: number | null, period: string | null): number {
  const base = Number(total ?? 0)
  const periodNumber = Number(period ?? "")

  if (periodNumber === 1) return base * 12
  if (periodNumber === 3) return base * 4
  return base
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
    const phase: string = body.phase ?? "list"
    const offset: number = body.offset ?? 0

    const client = await getFortnoxClient(supabase)

    if (phase === "list") {
      if (jobId) {
        await updateSyncJob(supabase, jobId, {
          status: "processing",
          current_step: "Fetching contracts from Fortnox...",
        })
      }

      const allContractNumbers: string[] = []
      let currentPage = 1
      let totalPages = 1

      do {
        const response = await client.getContracts(currentPage, "active")
        totalPages = response.MetaInformation?.["@TotalPages"] ?? 1
        const contracts = response.Contracts ?? []

        for (const c of contracts) {
          const num = c.DocumentNumber as string | undefined
          if (num) allContractNumbers.push(num)
        }

        currentPage++
        if (currentPage <= totalPages) await delay(RATE_LIMIT_DELAY_MS)
      } while (currentPage <= totalPages)

      const total = allContractNumbers.length

      if (jobId) {
        await updateSyncJob(supabase, jobId, {
          current_step: total === 0 ? "No contracts found. Finalizing..." : "Fetching contract details...",
          total_items: total,
          processed_items: 0,
          payload: { step_name: "contracts", step_label: "Contracts", contract_numbers: allContractNumbers, synced: 0, errors: 0 },
          batch_phase: total === 0 ? "finalize" : "process",
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
      let contractNumbers: string[] = []
      let prevSynced = 0
      let prevErrors = 0

      if (jobId) {
        const { data: jobRow } = await supabase
          .from("sync_jobs")
          .select("payload, total_items")
          .eq("id", jobId)
          .single()

        const payload = (jobRow as unknown as { payload: Record<string, unknown> } | null)?.payload
        contractNumbers = (payload?.contract_numbers as string[]) ?? []
        prevSynced = (payload?.synced as number) ?? 0
        prevErrors = (payload?.errors as number) ?? 0
      }

      const total = contractNumbers.length
      const batch = contractNumbers.slice(offset, offset + BATCH_SIZE)

      let synced = prevSynced
      let errors = prevErrors
      let processedInBatch = 0
      const startedAt = Date.now()

      for (const contractNumber of batch) {
        if (Date.now() - startedAt > MAX_INVOCATION_MS) {
          console.log(`[sync-contracts] time budget reached at offset ${offset + processedInBatch}/${total}`)
          break
        }
        try {
          const detail = await client.getContract(contractNumber)
          const c = detail.Contract as Record<string, unknown>
          const startDate = (c.PeriodStart as string) ?? null
          const endDate = (c.PeriodEnd as string) ?? null
          const isActive = isFortnoxActive(c.Active)

          if (!isActive) {
            const { error: deleteError } = await supabase
              .from("contract_accruals")
              .delete()
              .eq("fortnox_customer_number", ((c.CustomerNumber as string) ?? "") as never)
              .eq("contract_number", contractNumber as never)

            if (deleteError) {
              console.error("Contract delete error:", deleteError.message, deleteError.details)
              errors++
            }

            continue
          }

          const mapped = {
            fortnox_customer_number: (c.CustomerNumber as string) ?? "",
            contract_number: contractNumber,
            customer_name: (c.CustomerName as string) ?? null,
            description: (c.Remarks as string) ?? null,
            start_date: startDate,
            end_date: endDate,
            status: "Active",
            accrual_type: (c.ContractLength as string) ?? null,
            period: (c.InvoiceInterval as string) ?? null,
            is_active: true,
            total_ex_vat: resolveExVatTotal(c),
            total: c.Total != null ? Number(c.Total) : null,
            currency_code: (c.Currency as string) ?? "SEK",
            raw_data: c,
          }

          const { error: upsertError } = await supabase
            .from("contract_accruals")
            .upsert(mapped as never, {
              onConflict: "fortnox_customer_number,contract_number",
            })

          if (upsertError) {
            console.error("Contract upsert error:", upsertError.message, upsertError.details)
            errors++
          } else {
            synced++
          }
        } catch {
          errors++
        }

        processedInBatch++
        await delay(RATE_LIMIT_DELAY_MS)
      }

      const nextOffset = offset + processedInBatch
      const isDone = nextOffset >= total
      const progress = total > 0 ? Math.round((Math.min(nextOffset, total) / total) * (isDone ? 95 : 90)) : 95

      if (jobId) {
        await updateSyncJob(supabase, jobId, {
          progress,
          processed_items: Math.min(nextOffset, total),
          current_step: isDone ? "Computing contract KPIs..." : `Syncing contracts (${Math.min(nextOffset, total)}/${total})...`,
          payload: { step_name: "contracts", step_label: "Contracts", contract_numbers: contractNumbers, synced, errors },
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
          current_step: "Computing contract value KPI...",
          progress: 96,
        })
      }

      const valueByCustomer = new Map<string, number>()
      let offset = 0

      while (true) {
        const { data: contractRows, error: contractError } = await supabase
          .from("contract_accruals")
          .select("fortnox_customer_number, total_ex_vat, period, is_active")
          .order("id", { ascending: true })
          .range(offset, offset + KPI_BATCH_SIZE - 1)

        if (contractError) {
          throw new Error(`Failed to fetch contract KPIs: ${contractError.message}`)
        }

        const rows = (contractRows ?? []) as Array<{
          fortnox_customer_number: string | null
          total_ex_vat: number | null
          period: string | null
          is_active: boolean
        }>
        if (rows.length === 0) break

        for (const row of rows) {
          if (!row.fortnox_customer_number) continue
          if (!row.is_active) continue
          const existing = valueByCustomer.get(row.fortnox_customer_number) ?? 0
          valueByCustomer.set(
            row.fortnox_customer_number,
            existing + annualizeContractTotal(row.total_ex_vat, row.period)
          )
        }

        if (rows.length < KPI_BATCH_SIZE) break
        offset += KPI_BATCH_SIZE
      }

      await supabase
        .from("customers")
        .update({ contract_value: 0 } as never)
        .neq("id", "00000000-0000-0000-0000-000000000000" as never)

      const updates = Array.from(valueByCustomer.entries())
      const UPDATE_CONCURRENCY = 20

      for (let i = 0; i < updates.length; i += UPDATE_CONCURRENCY) {
        const slice = updates.slice(i, i + UPDATE_CONCURRENCY)
        await Promise.all(
          slice.map(([customerNumber, contractValue]) =>
            supabase
              .from("customers")
              .update({ contract_value: contractValue } as never)
              .eq("fortnox_customer_number", customerNumber as never)
          )
        )
      }

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
          payload: { step_name: "contracts", step_label: "Contracts", synced: finalSynced, errors: finalErrors, total: finalTotal },
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
