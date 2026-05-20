import { createAdminClient } from "../_shared/supabase.ts"
import { corsHeaders, getFortnoxClient, updateSyncJob } from "../_shared/sync-helpers.ts"

declare const Deno: {
  serve: (handler: (req: Request) => Response | Promise<Response>) => void
}

const SOURCE_ENDPOINT = "/api/time/registrations-v2"
const KPI_BATCH_SIZE = 3000
const DEBUG_EMPLOYEE_ID = "458"

/**
 * BACKFILL MODE — set to a fixed date (e.g. "2025-01-01") to force a full
 * historical resync. Set to `null` to use the rolling 2-month window
 * (current + previous calendar month, the normal day-to-day behaviour).
 *
 * Right now this is in backfill mode because we discovered customer
 * mis-mapping from the cost-center fallback bug and need to rebuild
 * historical `time_reports` rows from Fortnox. After the resync completes,
 * flip this back to `null` and redeploy.
 */
const BACKFILL_FROM_DATE: string | null = "2025-01-01"

function getRollingFromDate(today: Date = new Date()): string {
  if (BACKFILL_FROM_DATE) return BACKFILL_FROM_DATE
  const d = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1),
  )
  return d.toISOString().slice(0, 10)
}

interface DateWindow {
  fromDate: string
  toDate: string
}

function normalizeText(value: unknown): string {
  if (value == null) return ""
  return String(value).trim()
}

function normalizeDate(value: unknown): string | null {
  const normalized = normalizeText(value)
  if (!normalized) return null
  return normalized.slice(0, 10)
}

function isOnOrAfter(dateValue: string | null, minDate: string): boolean {
  if (!dateValue) return false
  return dateValue >= minDate
}

function toHours(value: unknown): number {
  const parsed = Number.parseFloat(normalizeText(value))
  return Number.isFinite(parsed) ? parsed : 0
}

function readSourceEmployeeId(row: Record<string, unknown>): string {
  return normalizeText(row.EmployeeId ?? row.EmployeeNumber ?? row.UserId ?? row.userId ?? row.StaffId)
}

function buildPath(fromDate?: string, toDate?: string): string {
  const params = new URLSearchParams()
  if (fromDate) {
    params.set("fromDate", fromDate)
  }
  if (toDate) {
    params.set("toDate", toDate)
  }
  return `${SOURCE_ENDPOINT}${params.toString() ? `?${params.toString()}` : ""}`
}

function createMonthlyWindows(fromDate: string, today: Date = new Date()): DateWindow[] {
  const windows: DateWindow[] = []
  const current = new Date(`${fromDate}T00:00:00.000Z`)
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()))

  while (current <= end) {
    const year = current.getUTCFullYear()
    const month = current.getUTCMonth()
    const windowStart = new Date(Date.UTC(year, month, 1))
    const windowEnd = new Date(Date.UTC(year, month + 1, 0))
    const actualStart = current > windowStart ? current : windowStart
    const actualEnd = windowEnd > end ? end : windowEnd

    windows.push({
      fromDate: actualStart.toISOString().slice(0, 10),
      toDate: actualEnd.toISOString().slice(0, 10),
    })

    current.setUTCMonth(current.getUTCMonth() + 1)
    current.setUTCDate(1)
  }

  return windows
}

async function fetchRows(
  client: Awaited<ReturnType<typeof getFortnoxClient>>,
  window: DateWindow
): Promise<Array<Record<string, unknown>>> {
  try {
    const response = await client.requestPath<Record<string, unknown> | Array<Record<string, unknown>>>(
      buildPath(window.fromDate, window.toDate)
    )
    if (Array.isArray(response)) return response
    if (Array.isArray(response.rows)) return response.rows as Array<Record<string, unknown>>
    return []
  } catch (error) {
    const message = error instanceof Error ? error.message : ""
    const isInvalidParameter = message.includes('"code":2000588') || message.includes("Ogiltig parameter")

    if (isInvalidParameter) {
      const response = await client.requestPath<Record<string, unknown> | Array<Record<string, unknown>>>(buildPath(window.fromDate))
      const rows = Array.isArray(response)
        ? response
        : Array.isArray(response.rows)
          ? (response.rows as Array<Record<string, unknown>>)
          : []

      return rows.filter((row) =>
        isOnOrAfter(
          normalizeDate(row.Date ?? row.ReportDate ?? row.TimeReportDate ?? row.WorkDate ?? row.TransactionDate ?? row.EntryDate),
          window.fromDate
        )
      )
    }

    throw error
  }
}

function mapRow(
  row: Record<string, unknown>,
  index: number,
  customerByNumber: Map<string, { id: string; name: string; fortnox_customer_number: string | null }>,
  userIdByEmployeeId: Map<string, string>
): Record<string, unknown> | null {
  const registrationCodeField = (row.registrationCode ?? row.RegistrationCode) as Record<string, unknown> | undefined
  const customerField = row.customer as Record<string, unknown> | undefined
  const serviceField = row.service as Record<string, unknown> | undefined

  const registrationCode = normalizeText(
    registrationCodeField?.code ?? registrationCodeField?.Code ?? row.RegistrationCode ?? row.RegistrationCodeCode ?? row.CauseCode
  )
  const registrationType = normalizeText(
    registrationCodeField?.type ?? registrationCodeField?.Type ?? row.RegistrationType ?? "WORK"
  )
  const reportId = normalizeText(row.id ?? row.TimeReportId ?? row.Id ?? row.TimeReportNumber ?? row.TimeSheetRowId ?? row.Number)
  const reportDate = normalizeDate(
    row.Date ?? row.ReportDate ?? row.TimeReportDate ?? row.WorkDate ?? row.workedDate ?? row.TransactionDate ?? row.EntryDate
  )
  const employeeId = readSourceEmployeeId(row)
  const employeeName = normalizeText(row.EmployeeName ?? row.Name ?? row.StaffName ?? row.UserName)
  const customerNumber = normalizeText(row.CustomerNumber ?? row.CustomerNo ?? row.CustomerId ?? customerField?.number ?? customerField?.id)
  const customerName = normalizeText(row.CustomerName ?? row.Customer ?? row.CustomerFullName ?? customerField?.name)
  const projectNumber = normalizeText(row.Project ?? row.ProjectNumber ?? row.ProjectNo ?? row.ProjectId)
  const projectName = normalizeText(row.ProjectName ?? row.ProjectDescription)
  const hours = toHours(
    row.Hours ?? row.Time ?? row.Quantity ?? row.Qty ?? row.NumberOfHours ?? row.HoursWorked ?? row.RegisteredHours ?? row.workedHours
  )
  const activity = normalizeText(
    row.Activity ??
      row.ActivityName ??
      row.Task ??
      row.WorkType ??
      serviceField?.description ??
      (registrationCode.toUpperCase() === "SEM" ? "Semester" : registrationType === "WORK" ? registrationCode : "Frånvaro")
  )
  const articleNumber = normalizeText(row.ArticleNumber ?? row.ArticleNo ?? row.ArticleId ?? serviceField?.id)
  const description = normalizeText(
    row.note ?? row.invoiceText ?? row.Description ?? row.Text ?? row.Comment ?? row.Notes ?? row.Note ?? row.ReferenceText
  )

  const isDebugEmployee = employeeId === DEBUG_EMPLOYEE_ID

  if (!reportDate || !isOnOrAfter(reportDate, getRollingFromDate())) {
    if (isDebugEmployee) {
      console.info("sync-time-reports: skipped debug employee row", {
        debug_employee_id: DEBUG_EMPLOYEE_ID,
        reason: "date_out_of_range_or_missing",
        report_id: reportId || null,
        report_date: reportDate,
      })
    }
    return null
  }

  if (registrationCode.toUpperCase() === "FRX") {
    if (isDebugEmployee) {
      console.info("sync-time-reports: skipped debug employee row", {
        debug_employee_id: DEBUG_EMPLOYEE_ID,
        reason: "registration_code_frx",
        report_id: reportId || null,
        report_date: reportDate,
      })
    }
    return null
  }

  if (hours === 0) {
    if (isDebugEmployee) {
      console.info("sync-time-reports: skipped debug employee row", {
        debug_employee_id: DEBUG_EMPLOYEE_ID,
        reason: "hours_zero",
        report_id: reportId || null,
        report_date: reportDate,
      })
    }
    return null
  }

  const entryType = registrationType && registrationType !== "WORK" ? "absence" : "time"
  // IMPORTANT: only match by fortnox_customer_number. We previously fell back
  // to matching by cost center, but on v2 time rows `costCenter` is the
  // *employee's* cost center, not the customer's. Customers that happened to
  // share a cost center with an employee (e.g. archived Beyond Us AB sharing
  // Hanna Dahl's cost center 59) ended up collecting every unmatched time
  // entry that employee logged. Don't bring that fallback back without
  // changing the data model.
  const matchedCustomer = customerByNumber.get(customerNumber) ?? null
  const uniqueKey = normalizeText(
    reportId || `${entryType}|${reportDate}|${employeeId}|${customerNumber}|${projectNumber}|${articleNumber}|${hours}|${description}|${index}`
  )

  const mappedUserId = employeeId ? (userIdByEmployeeId.get(employeeId) ?? employeeId) : ""

  if (!uniqueKey) {
    if (isDebugEmployee) {
      console.info("sync-time-reports: skipped debug employee row", {
        debug_employee_id: DEBUG_EMPLOYEE_ID,
        reason: "missing_unique_key",
        report_id: reportId || null,
        report_date: reportDate,
      })
    }
    return null
  }

  if (isDebugEmployee) {
    console.info("sync-time-reports: mapped debug employee row", {
      debug_employee_id: DEBUG_EMPLOYEE_ID,
      report_id: reportId || null,
      report_date: reportDate,
      mapped_employee_id: mappedUserId || null,
      unique_key: uniqueKey,
      entry_type: entryType,
      hours,
    })
  }

  return {
    unique_key: uniqueKey,
    customer_id: matchedCustomer?.id ?? null,
    entry_type: entryType,
    registration_code: registrationCode || null,
    registration_type: registrationType || null,
    source_endpoint: SOURCE_ENDPOINT,
    report_id: reportId || null,
    report_date: reportDate,
    employee_id: mappedUserId || null,
    employee_name: employeeName || null,
    fortnox_customer_number: (matchedCustomer?.fortnox_customer_number ?? customerNumber) || null,
    customer_name: (matchedCustomer?.name ?? customerName) || null,
    project_number: projectNumber || null,
    project_name: projectName || null,
    activity: activity || null,
    article_number: articleNumber || null,
    hours,
    description: description || null,
  }
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
    const client = await getFortnoxClient(supabase)
    const rollingFromDate = getRollingFromDate()
    const windows = createMonthlyWindows(rollingFromDate)

    if (phase === "list") {
      if (jobId) {
        await updateSyncJob(supabase, jobId, {
          status: "processing",
          current_step: `Fetching registrations from ${rollingFromDate}...`,
        })
      }

      const { data: customers } = await supabase
        .from("customers")
        .select("id, name, fortnox_customer_number")

      const { data: profileRows } = await supabase
        .from("profiles")
        .select("fortnox_employee_id, fortnox_user_id")
        .not("fortnox_employee_id", "is", null)
        .not("fortnox_user_id", "is", null)

      const customerByNumber = new Map<string, { id: string; name: string; fortnox_customer_number: string | null }>()
      const userIdByEmployeeId = new Map<string, string>()

      for (const customer of (customers ?? []) as Array<{
        id: string
        name: string
        fortnox_customer_number: string | null
      }>) {
        if (customer.fortnox_customer_number) {
          customerByNumber.set(customer.fortnox_customer_number, {
            id: customer.id,
            name: customer.name,
            fortnox_customer_number: customer.fortnox_customer_number,
          })
        }
      }

      for (const profileRow of (profileRows ?? []) as Array<{
        fortnox_employee_id: string | null
        fortnox_user_id: string | null
      }>) {
        const employeeId = normalizeText(profileRow.fortnox_employee_id)
        const userId = normalizeText(profileRow.fortnox_user_id)

        if (!employeeId || !userId) continue
        userIdByEmployeeId.set(employeeId, userId)
      }

      const windowIndex = Number(body.offset ?? 0)
      let previousSynced = 0
      let previousErrors = 0
      let previousSkipped = 0
      let previousTotal = 0

      if (jobId && windowIndex > 0) {
        const { data: jobRow } = await supabase
          .from("sync_jobs")
          .select("payload")
          .eq("id", jobId)
          .single()

        const payload = (jobRow as { payload?: Record<string, unknown> } | null)?.payload
        previousSynced = Number(payload?.synced ?? 0)
        previousErrors = Number(payload?.errors ?? 0)
        previousSkipped = Number(payload?.skipped ?? 0)
        previousTotal = Number(payload?.total ?? 0)
      }

      const window = windows[windowIndex]

      if (!window) {
        throw new Error(`No time-report batch window found for index ${windowIndex}`)
      }

      const rows = await fetchRows(client, window)

      const debugFetchedRows = rows.filter((row) => readSourceEmployeeId(row) === DEBUG_EMPLOYEE_ID)
      if (debugFetchedRows.length > 0) {
        console.info("sync-time-reports: fetched rows for debug employee", {
          debug_employee_id: DEBUG_EMPLOYEE_ID,
          window,
          fetched_count: debugFetchedRows.length,
          report_ids: debugFetchedRows.map((row) => normalizeText(row.id ?? row.TimeReportId ?? row.Id ?? row.TimeReportNumber ?? row.TimeSheetRowId ?? row.Number)),
        })
      }

      const mapped = rows
        .map((row, index) => mapRow(row, index, customerByNumber, userIdByEmployeeId))
        .filter((row): row is Record<string, unknown> => row !== null)

      const debugMappedRows = mapped.filter((row) => normalizeText(row.employee_id) === DEBUG_EMPLOYEE_ID)
      if (debugFetchedRows.length > 0 || debugMappedRows.length > 0) {
        console.info("sync-time-reports: debug employee mapping summary", {
          debug_employee_id: DEBUG_EMPLOYEE_ID,
          fetched_count: debugFetchedRows.length,
          mapped_count: debugMappedRows.length,
          skipped_count: debugFetchedRows.length - debugMappedRows.length,
        })
      }

      const skipped = previousSkipped + (rows.length - mapped.length)
      let errors = previousErrors
      let synced = previousSynced

      if (mapped.length > 0) {
        if (debugMappedRows.length > 0) {
          console.info("sync-time-reports: debug employee rows included in upsert", {
            debug_employee_id: DEBUG_EMPLOYEE_ID,
            count: debugMappedRows.length,
            unique_keys: debugMappedRows.map((row) => normalizeText(row.unique_key)),
          })
        }

        // Chunked upsert: large monthly windows produce ~5000+ mapped rows,
        // which can blow Postgres's per-statement timeout for the service
        // role when upserted in one go ("canceling statement due to statement
        // timeout"). The whole batch then rolls back and every row is lost.
        // Splitting into smaller chunks keeps each upsert well under the
        // timeout and means a failure costs us at most one chunk's worth of
        // rows instead of the entire window.
        const UPSERT_CHUNK_SIZE = 500
        let chunkSynced = 0
        let chunkErrors = 0

        for (let i = 0; i < mapped.length; i += UPSERT_CHUNK_SIZE) {
          const chunk = mapped.slice(i, i + UPSERT_CHUNK_SIZE)
          const { error } = await supabase
            .from("time_reports")
            .upsert(chunk as never, { onConflict: "unique_key" })

          if (error) {
            console.error(
              "Time report upsert error:",
              error.message,
              error.details,
              `(chunk ${i}-${i + chunk.length}, ${chunk.length} rows)`,
            )
            chunkErrors += chunk.length
          } else {
            chunkSynced += chunk.length
          }
        }

        if (debugMappedRows.length > 0) {
          if (chunkErrors > 0) {
            console.error("sync-time-reports: debug employee upsert had errors", {
              debug_employee_id: DEBUG_EMPLOYEE_ID,
              count: debugMappedRows.length,
              chunk_synced: chunkSynced,
              chunk_errors: chunkErrors,
            })
          } else {
            console.info("sync-time-reports: debug employee upsert succeeded", {
              debug_employee_id: DEBUG_EMPLOYEE_ID,
              count: debugMappedRows.length,
            })
          }
        }

        synced += chunkSynced
        errors += chunkErrors
      }

      const total = previousTotal + rows.length

      const morePages = windowIndex < windows.length - 1

      if (jobId) {
        await updateSyncJob(supabase, jobId, {
          total_items: windows.length,
          processed_items: windowIndex + 1,
          progress: morePages ? Math.round(((windowIndex + 1) / windows.length) * 80) : 90,
          current_step: morePages
            ? `Synced registrations ${window.fromDate} to ${window.toDate} (${synced} saved, ${skipped} skipped)`
            : `${synced} registrations saved (${skipped} skipped), computing KPIs...`,
          payload: {
            step_name: "time-reports",
            step_label: "Time Reports",
            synced,
            errors,
            skipped,
            total,
            source_endpoint: SOURCE_ENDPOINT,
            current_window: window,
          },
          batch_phase: morePages ? "list" : "finalize",
          batch_offset: morePages ? windowIndex + 1 : 0,
          dispatch_lock: false,
        })
      }

      return new Response(
        JSON.stringify({ ok: true, phase: "list", morePages, synced, errors, skipped, window }),
        { headers: { ...corsHeaders(), "Content-Type": "application/json" } }
      )
    }

    if (phase === "finalize") {
      if (jobId) {
        await updateSyncJob(supabase, jobId, {
          current_step: "Computing hours KPI...",
          progress: 92,
        })
      }

      // All aggregation + updates happen inside Postgres in a single RPC.
      // The earlier approach (JS-side loop over ~700 UPDATEs) blew the edge
      // function's CPU budget; the one before that (in-memory aggregation
      // over every row) blew its memory. This pushes both concerns down to
      // the database where they're cheap.
      const { error: kpiError } = await supabase.rpc(
        "sync_customer_total_hours" as never,
      )
      if (kpiError) {
        throw new Error(
          `Failed to update customer total_hours: ${kpiError.message}`,
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

        const payload = (jobRow as { payload?: Record<string, unknown>; total_items?: number } | null)?.payload
        finalSynced = Number(payload?.synced ?? 0)
        finalErrors = Number(payload?.errors ?? 0)
        finalTotal = Number((jobRow as { total_items?: number } | null)?.total_items ?? 0)

        await updateSyncJob(supabase, jobId, {
          status: "completed",
          progress: 100,
          current_step: "Done",
          processed_items: finalTotal,
          payload: {
            step_name: "time-reports",
            step_label: "Time Reports",
            synced: finalSynced,
            errors: finalErrors,
            total: finalTotal,
            source_endpoint: SOURCE_ENDPOINT,
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

    return new Response(JSON.stringify({ error: `Unknown phase: ${phase}` }), {
      status: 400,
      headers: { ...corsHeaders(), "Content-Type": "application/json" },
    })
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

    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders(), "Content-Type": "application/json" },
    })
  }
})
