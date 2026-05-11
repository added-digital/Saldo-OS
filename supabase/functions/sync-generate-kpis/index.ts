import { createAdminClient } from "../_shared/supabase.ts"
import { updateSyncJob, corsHeaders } from "../_shared/sync-helpers.ts"

declare const Deno: {
  serve: (handler: (req: Request) => Response | Promise<Response>) => void
}

const KPI_BATCH_SIZE = 20000
const MAPPING_BATCH_SIZE = 20000
const QUERY_PAGE_SIZE = 1000

type Phase = "list" | "invoices" | "time" | "contracts" | "finalize"

type CustomerRef = {
  id: string
  fortnoxCustomerNumber: string | null
  customerManagerProfileId: string | null
}

type JobState = {
  counts: {
    invoices: number
    time: number
    contracts: number
  }
  processed: {
    invoices: number
    time: number
    contracts: number
  }
}

type CustomerTotalsDelta = {
  customer_id: string
  total_turnover: number
  invoice_count: number
  total_hours: number
  contract_value: number
}

type PeriodKpiDelta = {
  customer_id: string
  fortnox_customer_number: string | null
  period_type: "year" | "month"
  period_year: number
  period_month: number
  total_turnover: number
  invoice_count: number
  total_hours: number
  customer_hours: number
  absence_hours: number
  internal_hours: number
  other_hours: number
  contract_value: number
}

type ManagerPeriodKpiDelta = {
  manager_profile_id: string
  customer_manager_profile_id: string | null
  period_year: number
  period_month: number
  total_hours: number
  customer_hours: number
  absence_hours: number
  internal_hours: number
  other_hours: number
}

function getDateParts(value: string | null): { year: number; month: number } | null {
  if (!value) return null

  const [yearValue, monthValue] = value.split("-")
  const year = Number(yearValue)
  const month = Number(monthValue)

  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return null
  }

  return { year, month }
}

function getContractBounds(input: {
  startDate: string | null
  endDate: string | null
}): {
  startYear: number
  startMonth: number
  endYear: number
  endMonth: number
} | null {
  const start = getDateParts(input.startDate)
  const end = getDateParts(input.endDate)
  const currentYear = new Date().getUTCFullYear()

  const startYear = start?.year ?? end?.year ?? currentYear
  const startMonth = start?.month ?? 1
  const endYear = end?.year ?? currentYear
  const endMonth = end?.month ?? 12

  if (startYear > endYear) return null
  if (startYear === endYear && startMonth > endMonth) return null

  return {
    startYear,
    startMonth,
    endYear,
    endMonth,
  }
}

function annualizeContractTotal(total: number | null, period: string | null): number {
  const base = Number(total ?? 0)
  const periodNumber = Number(period ?? "")

  if (periodNumber === 1) return base * 12
  if (periodNumber === 3) return base * 4
  return base
}

function getJobState(payload: Record<string, unknown> | null | undefined): JobState {
  const counts = (payload?.counts as Record<string, unknown> | undefined) ?? {}
  const processed = (payload?.processed as Record<string, unknown> | undefined) ?? {}

  return {
    counts: {
      invoices: Number(counts.invoices ?? 0),
      time: Number(counts.time ?? 0),
      contracts: Number(counts.contracts ?? 0),
    },
    processed: {
      invoices: Number(processed.invoices ?? 0),
      time: Number(processed.time ?? 0),
      contracts: Number(processed.contracts ?? 0),
    },
  }
}

function totalCount(state: JobState): number {
  return state.counts.invoices + state.counts.time + state.counts.contracts
}

function totalProcessed(state: JobState): number {
  return state.processed.invoices + state.processed.time + state.processed.contracts
}

function nextProcessingPhase(state: JobState): Phase {
  if (state.processed.invoices < state.counts.invoices) return "invoices"
  if (state.processed.time < state.counts.time) return "time"
  if (state.processed.contracts < state.counts.contracts) return "contracts"
  return "finalize"
}

function computeProgress(state: JobState, done = false): number {
  if (done) return 100

  const total = totalCount(state)
  if (total <= 0) return 99

  const ratio = Math.min(totalProcessed(state), total) / total
  return Math.max(5, Math.min(99, Math.round(5 + ratio * 94)))
}

function normalizeIdentifier(value: string | null | undefined): string {
  return (value ?? "").trim()
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase()
}

function getCustomerTotalsDelta(
  map: Map<string, CustomerTotalsDelta>,
  customerId: string,
): CustomerTotalsDelta {
  const existing = map.get(customerId)
  if (existing) return existing

  const next: CustomerTotalsDelta = {
    customer_id: customerId,
    total_turnover: 0,
    invoice_count: 0,
    total_hours: 0,
    contract_value: 0,
  }

  map.set(customerId, next)
  return next
}

function getPeriodKpiDelta(
  map: Map<string, PeriodKpiDelta>,
  customer: CustomerRef,
  periodType: "year" | "month",
  periodYear: number,
  periodMonth: number,
): PeriodKpiDelta {
  const key = `${customer.id}:${periodType}:${periodYear}:${periodMonth}`
  const existing = map.get(key)
  if (existing) return existing

  const next: PeriodKpiDelta = {
    customer_id: customer.id,
    fortnox_customer_number: customer.fortnoxCustomerNumber,
    period_type: periodType,
    period_year: periodYear,
    period_month: periodMonth,
    total_turnover: 0,
    invoice_count: 0,
    total_hours: 0,
    customer_hours: 0,
    absence_hours: 0,
    internal_hours: 0,
    other_hours: 0,
    contract_value: 0,
  }

  map.set(key, next)
  return next
}

function addDatedKpiValues(
  map: Map<string, PeriodKpiDelta>,
  customer: CustomerRef,
  date: string | null,
  values: {
    turnover?: number
    invoiceCount?: number
    hours?: number
    customerHours?: number
    absenceHours?: number
    internalHours?: number
    otherHours?: number
    contractValue?: number
  },
) {
  const parts = getDateParts(date)
  if (!parts) return

  const yearly = getPeriodKpiDelta(map, customer, "year", parts.year, 0)
  yearly.total_turnover += values.turnover ?? 0
  yearly.invoice_count += values.invoiceCount ?? 0
  yearly.total_hours += values.hours ?? 0
  yearly.customer_hours += values.customerHours ?? 0
  yearly.absence_hours += values.absenceHours ?? 0
  yearly.internal_hours += values.internalHours ?? 0
  yearly.other_hours += values.otherHours ?? 0
  yearly.contract_value += values.contractValue ?? 0

  const monthly = getPeriodKpiDelta(map, customer, "month", parts.year, parts.month)
  monthly.total_turnover += values.turnover ?? 0
  monthly.invoice_count += values.invoiceCount ?? 0
  monthly.total_hours += values.hours ?? 0
  monthly.customer_hours += values.customerHours ?? 0
  monthly.absence_hours += values.absenceHours ?? 0
  monthly.internal_hours += values.internalHours ?? 0
  monthly.other_hours += values.otherHours ?? 0
  monthly.contract_value += values.contractValue ?? 0
}

function addContractKpiValues(
  map: Map<string, PeriodKpiDelta>,
  customer: CustomerRef,
  input: {
    startDate: string | null
    endDate: string | null
    annualizedValue: number
  },
) {
  const bounds = getContractBounds({
    startDate: input.startDate,
    endDate: input.endDate,
  })

  if (!bounds || input.annualizedValue === 0) return

  const monthlyValue = input.annualizedValue / 12
  let year = bounds.startYear
  let month = bounds.startMonth

  while (year < bounds.endYear || (year === bounds.endYear && month <= bounds.endMonth)) {
    const yearly = getPeriodKpiDelta(map, customer, "year", year, 0)
    yearly.contract_value += monthlyValue

    const monthly = getPeriodKpiDelta(map, customer, "month", year, month)
    monthly.contract_value += monthlyValue

    month += 1
    if (month > 12) {
      month = 1
      year += 1
    }
  }
}

function getManagerPeriodKpiDelta(
  map: Map<string, ManagerPeriodKpiDelta>,
  input: {
    managerProfileId: string
    customerManagerProfileId: string | null
    periodYear: number
    periodMonth: number
  },
): ManagerPeriodKpiDelta {
  const key = `${input.managerProfileId}:${input.customerManagerProfileId ?? "none"}:${input.periodYear}:${input.periodMonth}`
  const existing = map.get(key)
  if (existing) return existing

  const next: ManagerPeriodKpiDelta = {
    manager_profile_id: input.managerProfileId,
    customer_manager_profile_id: input.customerManagerProfileId,
    period_year: input.periodYear,
    period_month: input.periodMonth,
    total_hours: 0,
    customer_hours: 0,
    absence_hours: 0,
    internal_hours: 0,
    other_hours: 0,
  }

  map.set(key, next)
  return next
}

async function loadCustomerMappings(supabase: ReturnType<typeof createAdminClient>) {
  const customerById = new Map<string, CustomerRef>()
  const customerByNumber = new Map<string, CustomerRef>()
  const managerByCostCenter = new Map<string, string>()

  let profileOffset = 0
  while (true) {
    const pageSize = Math.min(MAPPING_BATCH_SIZE, QUERY_PAGE_SIZE)
    const { data: profileRows, error: profileError } = await supabase
      .from("profiles")
      .select("id, fortnox_cost_center")
      .eq("is_active", true)
      .order("id", { ascending: true })
      .range(profileOffset, profileOffset + pageSize - 1)

    if (profileError) {
      throw new Error(`Failed to load profile mappings: ${profileError.message}`)
    }

    const rows = (profileRows ?? []) as Array<{
      id: string
      fortnox_cost_center: string | null
    }>

    if (rows.length === 0) break

    for (const row of rows) {
      const normalizedCostCenter = normalizeIdentifier(row.fortnox_cost_center)
      if (normalizedCostCenter && !managerByCostCenter.has(normalizedCostCenter)) {
        managerByCostCenter.set(normalizedCostCenter, row.id)
      }
    }

    if (rows.length < pageSize) break
    profileOffset += pageSize
  }

  let customerOffset = 0
  while (true) {
    const pageSize = Math.min(MAPPING_BATCH_SIZE, QUERY_PAGE_SIZE)
    const { data: customerRows, error: customerError } = await supabase
      .from("customers")
      .select("id, fortnox_customer_number, fortnox_cost_center")
      .order("id", { ascending: true })
      .range(customerOffset, customerOffset + pageSize - 1)

    if (customerError) {
      throw new Error(`Failed to load customer mappings: ${customerError.message}`)
    }

    const rows = (customerRows ?? []) as Array<{
      id: string
      fortnox_customer_number: string | null
      fortnox_cost_center: string | null
    }>

    if (rows.length === 0) break

    for (const row of rows) {
      const costCenter = normalizeIdentifier(row.fortnox_cost_center)
      const customer: CustomerRef = {
        id: row.id,
        fortnoxCustomerNumber: row.fortnox_customer_number,
        customerManagerProfileId: costCenter ? (managerByCostCenter.get(costCenter) ?? null) : null,
      }

      customerById.set(row.id, customer)

      if (row.fortnox_customer_number) {
        customerByNumber.set(row.fortnox_customer_number, customer)
      }
    }

    if (rows.length < pageSize) break
    customerOffset += pageSize
  }

  return { customerById, customerByNumber }
}

async function loadManagerMappings(supabase: ReturnType<typeof createAdminClient>) {
  const managerByFortnoxUserId = new Map<string, string>()
  const managerByFortnoxEmployeeId = new Map<string, string>()
  const managerByName = new Map<string, string>()

  let profileOffset = 0
  while (true) {
    const pageSize = Math.min(MAPPING_BATCH_SIZE, QUERY_PAGE_SIZE)
    const { data: profileRows, error: profileError } = await supabase
      .from("profiles")
      .select("id, full_name, email, fortnox_user_id, fortnox_employee_id")
      .eq("is_active", true)
      .order("id", { ascending: true })
      .range(profileOffset, profileOffset + pageSize - 1)

    if (profileError) {
      throw new Error(`Failed to load manager mappings: ${profileError.message}`)
    }

    const rows = (profileRows ?? []) as Array<{
      id: string
      full_name: string | null
      email: string
      fortnox_user_id: string | null
      fortnox_employee_id: string | null
    }>

    if (rows.length === 0) break

    for (const row of rows) {
      const normalizedUserId = normalizeIdentifier(row.fortnox_user_id)
      if (normalizedUserId) {
        managerByFortnoxUserId.set(normalizedUserId, row.id)
      }

      const normalizedEmployeeId = normalizeIdentifier(row.fortnox_employee_id)
      if (normalizedEmployeeId) {
        managerByFortnoxEmployeeId.set(normalizedEmployeeId, row.id)
      }

      const normalizedName = normalizeText(row.full_name)
      if (normalizedName && !managerByName.has(normalizedName)) {
        managerByName.set(normalizedName, row.id)
      }

      const normalizedEmail = normalizeText(row.email)
      if (normalizedEmail && !managerByName.has(normalizedEmail)) {
        managerByName.set(normalizedEmail, row.id)
      }
    }

    if (rows.length < pageSize) break
    profileOffset += pageSize
  }

  return { managerByFortnoxUserId, managerByFortnoxEmployeeId, managerByName }
}

function resolveCustomerRef(
  input: {
    customerId: string | null
    fortnoxCustomerNumber: string | null
  },
  customerById: Map<string, CustomerRef>,
  customerByNumber: Map<string, CustomerRef>,
): CustomerRef | null {
  if (input.customerId) {
    const byId = customerById.get(input.customerId)
    if (byId) return byId
  }

  if (input.fortnoxCustomerNumber) {
    return customerByNumber.get(input.fortnoxCustomerNumber) ?? null
  }

  return null
}

function resolveReporterManagerId(
  input: {
    employeeId: string | null
    employeeName: string | null
  },
  managerByFortnoxUserId: Map<string, string>,
  managerByFortnoxEmployeeId: Map<string, string>,
  managerByName: Map<string, string>,
): string | null {
  const normalizedEmployeeId = normalizeIdentifier(input.employeeId)

  if (normalizedEmployeeId) {
    const byUserId = managerByFortnoxUserId.get(normalizedEmployeeId)
    if (byUserId) return byUserId

    const byEmployeeId = managerByFortnoxEmployeeId.get(normalizedEmployeeId)
    if (byEmployeeId) return byEmployeeId
  }

  const normalizedName = normalizeText(input.employeeName)
  if (normalizedName) {
    return managerByName.get(normalizedName) ?? null
  }

  return null
}

async function fetchInvoiceBatch(
  supabase: ReturnType<typeof createAdminClient>,
  startOffset: number,
): Promise<{
  rows: Array<{
    customer_id: string | null
    fortnox_customer_number: string | null
    invoice_date: string | null
    total_ex_vat: number | null
    total: number | null
  }>
  fetched: number
}> {
  const rows: Array<{
    customer_id: string | null
    fortnox_customer_number: string | null
    invoice_date: string | null
    total_ex_vat: number | null
    total: number | null
  }> = []

  let offset = startOffset

  while (rows.length < KPI_BATCH_SIZE) {
    const remaining = KPI_BATCH_SIZE - rows.length
    const pageSize = Math.min(QUERY_PAGE_SIZE, remaining)

    const { data, error } = await supabase
      .from("invoices")
      .select("customer_id, fortnox_customer_number, invoice_date, total_ex_vat, total")
      .order("id", { ascending: true })
      .range(offset, offset + pageSize - 1)

    if (error) {
      throw new Error(`Failed to read invoices for KPI generation: ${error.message}`)
    }

    const pageRows = (data ?? []) as Array<{
      customer_id: string | null
      fortnox_customer_number: string | null
      invoice_date: string | null
      total_ex_vat: number | null
      total: number | null
    }>

    rows.push(...pageRows)
    offset += pageRows.length

    if (pageRows.length < pageSize) {
      break
    }
  }

  return { rows, fetched: rows.length }
}

async function fetchTimeBatch(
  supabase: ReturnType<typeof createAdminClient>,
  startOffset: number,
): Promise<{
  rows: Array<{
    customer_id: string | null
    fortnox_customer_number: string | null
    report_date: string | null
    employee_id: string | null
    employee_name: string | null
    entry_type: string | null
    hours: number | null
  }>
  fetched: number
}> {
  const rows: Array<{
    customer_id: string | null
    fortnox_customer_number: string | null
    report_date: string | null
    employee_id: string | null
    employee_name: string | null
    entry_type: string | null
    hours: number | null
  }> = []

  let offset = startOffset

  while (rows.length < KPI_BATCH_SIZE) {
    const remaining = KPI_BATCH_SIZE - rows.length
    const pageSize = Math.min(QUERY_PAGE_SIZE, remaining)

    const { data, error } = await supabase
      .from("time_reports")
      .select("customer_id, fortnox_customer_number, report_date, employee_id, employee_name, entry_type, hours")
      .order("id", { ascending: true })
      .range(offset, offset + pageSize - 1)

    if (error) {
      throw new Error(`Failed to read time reports for KPI generation: ${error.message}`)
    }

    const pageRows = (data ?? []) as Array<{
      customer_id: string | null
      fortnox_customer_number: string | null
      report_date: string | null
      employee_id: string | null
      employee_name: string | null
      entry_type: string | null
      hours: number | null
    }>

    rows.push(...pageRows)
    offset += pageRows.length

    if (pageRows.length < pageSize) {
      break
    }
  }

  return { rows, fetched: rows.length }
}

async function fetchContractBatch(
  supabase: ReturnType<typeof createAdminClient>,
  startOffset: number,
): Promise<{
  rows: Array<{
    fortnox_customer_number: string | null
    start_date: string | null
    end_date: string | null
    total_ex_vat: number | null
    total: number | null
    period: string | null
    is_active: boolean
  }>
  fetched: number
}> {
  const rows: Array<{
    fortnox_customer_number: string | null
    start_date: string | null
    end_date: string | null
    total_ex_vat: number | null
    total: number | null
    period: string | null
    is_active: boolean
  }> = []

  let offset = startOffset

  while (rows.length < KPI_BATCH_SIZE) {
    const remaining = KPI_BATCH_SIZE - rows.length
    const pageSize = Math.min(QUERY_PAGE_SIZE, remaining)

    const { data, error } = await supabase
      .from("contract_accruals")
      .select("fortnox_customer_number, start_date, end_date, total_ex_vat, total, period, is_active")
      .order("id", { ascending: true })
      .range(offset, offset + pageSize - 1)

    if (error) {
      throw new Error(`Failed to read contracts for KPI generation: ${error.message}`)
    }

    const pageRows = (data ?? []) as Array<{
      fortnox_customer_number: string | null
      start_date: string | null
      end_date: string | null
      total_ex_vat: number | null
      total: number | null
      period: string | null
      is_active: boolean
    }>

    rows.push(...pageRows)
    offset += pageRows.length

    if (pageRows.length < pageSize) {
      break
    }
  }

  return { rows, fetched: rows.length }
}

async function countRows(supabase: ReturnType<typeof createAdminClient>, table: "invoices" | "time_reports" | "contract_accruals") {
  const { count, error } = await supabase
    .from(table)
    .select("id", { count: "exact", head: true })

  if (error) {
    throw new Error(`Failed counting ${table}: ${error.message}`)
  }

  return Number(count ?? 0)
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
    const phase = (body.phase ?? "list") as Phase
    const offset = Number(body.offset ?? 0)

    if (!jobId) {
      throw new Error("Missing job_id")
    }

    const { data: jobRowRaw, error: jobReadError } = await supabase
      .from("sync_jobs")
      .select("payload, total_items, processed_items")
      .eq("id", jobId)
      .single()

    if (jobReadError) {
      throw new Error(`Failed to read sync job: ${jobReadError.message}`)
    }

    const jobRow = (jobRowRaw ?? {
      payload: null,
      total_items: 0,
      processed_items: 0,
    }) as {
      payload: Record<string, unknown> | null
      total_items: number | null
      processed_items: number | null
    }

    const state = getJobState(jobRow.payload)

    if (phase === "list") {
      await updateSyncJob(supabase, jobId, {
        status: "processing",
        progress: 2,
        current_step: "Preparing KPI generation...",
        dispatch_lock: false,
      })

      const invoices = await countRows(supabase, "invoices")
      const time = await countRows(supabase, "time_reports")
      const contracts = await countRows(supabase, "contract_accruals")

      const nextState: JobState = {
        counts: { invoices, time, contracts },
        processed: { invoices: 0, time: 0, contracts: 0 },
      }

      await updateSyncJob(supabase, jobId, {
        current_step: "Resetting KPI targets...",
        progress: 4,
        total_items: totalCount(nextState),
        processed_items: 0,
        dispatch_lock: false,
      })

      const { error: resetCustomerError } = await supabase
        .from("customers")
        .update({
          total_turnover: 0,
          invoice_count: 0,
          total_hours: 0,
          contract_value: 0,
        } as never)
        .neq("id", "00000000-0000-0000-0000-000000000000" as never)

      if (resetCustomerError) {
        throw new Error(`Failed resetting customer KPI columns: ${resetCustomerError.message}`)
      }

      const { error: resetPeriodError } = await supabase
        .from("customer_kpis")
        .delete()
        .gte("period_year", 0 as never)

      if (resetPeriodError) {
        throw new Error(`Failed resetting customer KPI periods: ${resetPeriodError.message}`)
      }

      const { error: resetManagerPeriodError } = await supabase
        .from("manager_time_kpis")
        .delete()
        .gte("period_year", 0 as never)

      if (resetManagerPeriodError) {
        throw new Error(`Failed resetting manager KPI periods: ${resetManagerPeriodError.message}`)
      }

      const nextPhase = nextProcessingPhase(nextState)

      await updateSyncJob(supabase, jobId, {
        progress: computeProgress(nextState, nextPhase === "finalize"),
        current_step: nextPhase === "finalize" ? "Finalizing KPI generation..." : `Processing ${nextPhase} KPIs...`,
        payload: {
          step_name: "generate-kpis",
          step_label: "Generate KPIs",
          counts: nextState.counts,
          processed: nextState.processed,
        },
        batch_phase: nextPhase,
        batch_offset: 0,
        dispatch_lock: false,
      })

      return new Response(
        JSON.stringify({
          ok: true,
          phase: "list",
          counts: nextState.counts,
          next_phase: nextPhase,
        }),
        { headers: { ...corsHeaders(), "Content-Type": "application/json" } },
      )
    }

    if (phase === "invoices") {
      const { customerById, customerByNumber } = await loadCustomerMappings(supabase)
      const { rows, fetched } = await fetchInvoiceBatch(supabase, offset)

      const customerTotals = new Map<string, CustomerTotalsDelta>()
      const periodKpis = new Map<string, PeriodKpiDelta>()

      for (const row of rows) {
        const customer = resolveCustomerRef(
          {
            customerId: row.customer_id,
            fortnoxCustomerNumber: row.fortnox_customer_number,
          },
          customerById,
          customerByNumber,
        )

        if (!customer) continue

        const amount = Number(row.total_ex_vat ?? 0)
        const totals = getCustomerTotalsDelta(customerTotals, customer.id)
        totals.total_turnover += amount
        totals.invoice_count += 1

        addDatedKpiValues(periodKpis, customer, row.invoice_date, {
          turnover: amount,
          invoiceCount: 1,
        })
      }

      const customerTotalRows = Array.from(customerTotals.values())
      if (customerTotalRows.length > 0) {
        const { error } = await supabase.rpc("accumulate_customer_totals_rows", {
          rows: customerTotalRows,
        })

        if (error) {
          throw new Error(`Failed accumulating customer totals for invoices: ${error.message}`)
        }
      }

      const periodRows = Array.from(periodKpis.values())
      if (periodRows.length > 0) {
        const { error } = await supabase.rpc("accumulate_customer_kpi_rows", {
          rows: periodRows,
        })

        if (error) {
          throw new Error(`Failed accumulating period KPIs for invoices: ${error.message}`)
        }
      }

      const nextProcessed = Math.min(state.processed.invoices + fetched, state.counts.invoices)
      const nextState: JobState = {
        counts: state.counts,
        processed: {
          invoices: nextProcessed,
          time: state.processed.time,
          contracts: state.processed.contracts,
        },
      }

      const done = fetched < KPI_BATCH_SIZE || nextProcessed >= state.counts.invoices
      const nextPhase = done ? nextProcessingPhase(nextState) : "invoices"
      const nextOffset = done ? 0 : offset + fetched

      await updateSyncJob(supabase, jobId, {
        progress: computeProgress(nextState, nextPhase === "finalize"),
        processed_items: totalProcessed(nextState),
        current_step:
          nextPhase === "invoices"
            ? `Generating invoice KPIs (${nextProcessed}/${state.counts.invoices})...`
            : nextPhase === "finalize"
              ? "Finalizing KPI generation..."
              : `Processing ${nextPhase} KPIs...`,
        payload: {
          step_name: "generate-kpis",
          step_label: "Generate KPIs",
          counts: nextState.counts,
          processed: nextState.processed,
        },
        batch_phase: nextPhase,
        batch_offset: nextOffset,
        dispatch_lock: false,
      })

      return new Response(
        JSON.stringify({
          ok: true,
          phase: "invoices",
          processed: nextProcessed,
          total: state.counts.invoices,
          next_phase: nextPhase,
          next_offset: nextOffset,
        }),
        { headers: { ...corsHeaders(), "Content-Type": "application/json" } },
      )
    }

    if (phase === "time") {
      const { customerById, customerByNumber } = await loadCustomerMappings(supabase)
      const {
        managerByFortnoxUserId,
        managerByFortnoxEmployeeId,
        managerByName,
      } = await loadManagerMappings(supabase)

      const { rows, fetched } = await fetchTimeBatch(supabase, offset)

      const customerTotals = new Map<string, CustomerTotalsDelta>()
      const periodKpis = new Map<string, PeriodKpiDelta>()
      const managerPeriodKpis = new Map<string, ManagerPeriodKpiDelta>()

      for (const row of rows) {
        const customer = resolveCustomerRef(
          {
            customerId: row.customer_id,
            fortnoxCustomerNumber: row.fortnox_customer_number,
          },
          customerById,
          customerByNumber,
        )

        const amount = Number(row.hours ?? 0)
        const entryType = normalizeText(row.entry_type)
        const isCustomerHours = entryType === "time"
        const isAbsenceHours = entryType === "absence"
        const isInternalHours = entryType === "internal"
        const isOtherHours =
          !isCustomerHours && !isAbsenceHours && !isInternalHours
        const isCustomerIdOne =
          normalizeIdentifier(row.fortnox_customer_number) === "1"

        // Customer-level rollups only run when there's a customer to roll up
        // against. Absence rows from Fortnox (sick days, vacation, parental
        // leave) usually have no customer attached, so we skip those rollups
        // for them but still let the row reach the manager rollup below.
        if (customer) {
          const totals = getCustomerTotalsDelta(customerTotals, customer.id)
          totals.total_hours += amount

          addDatedKpiValues(periodKpis, customer, row.report_date, {
            hours: amount,
            customerHours: isCustomerHours ? amount : 0,
            absenceHours: isAbsenceHours ? amount : 0,
            internalHours: isInternalHours ? amount : 0,
            otherHours: isOtherHours ? amount : 0,
          })
        }

        const dateParts = getDateParts(row.report_date)
        if (!dateParts) continue

        const managerId = resolveReporterManagerId(
          {
            employeeId: row.employee_id,
            employeeName: row.employee_name,
          },
          managerByFortnoxUserId,
          managerByFortnoxEmployeeId,
          managerByName,
        )

        if (!managerId) continue

        const managerKpi = getManagerPeriodKpiDelta(managerPeriodKpis, {
          managerProfileId: managerId,
          // Customer manager only exists when the row is tied to a customer.
          // For unattached absence rows we pass null so the rollup keys it
          // under the "none" bucket — the manager-level totals still grow.
          customerManagerProfileId: customer?.customerManagerProfileId ?? null,
          periodYear: dateParts.year,
          periodMonth: dateParts.month,
        })

        managerKpi.total_hours += amount
        managerKpi.customer_hours += isCustomerHours && !isCustomerIdOne ? amount : 0
        managerKpi.absence_hours += isAbsenceHours ? amount : 0
        managerKpi.internal_hours += isCustomerIdOne ? amount : 0
        managerKpi.other_hours += isOtherHours ? amount : 0
      }

      const customerTotalRows = Array.from(customerTotals.values())
      if (customerTotalRows.length > 0) {
        const { error } = await supabase.rpc("accumulate_customer_totals_rows", {
          rows: customerTotalRows,
        })

        if (error) {
          throw new Error(`Failed accumulating customer totals for time: ${error.message}`)
        }
      }

      const periodRows = Array.from(periodKpis.values())
      if (periodRows.length > 0) {
        const { error } = await supabase.rpc("accumulate_customer_kpi_rows", {
          rows: periodRows,
        })

        if (error) {
          throw new Error(`Failed accumulating period KPIs for time: ${error.message}`)
        }
      }

      const managerRows = Array.from(managerPeriodKpis.values())
      if (managerRows.length > 0) {
        const { error } = await supabase.rpc("accumulate_manager_time_kpi_rows", {
          rows: managerRows,
        })

        if (error) {
          throw new Error(`Failed accumulating manager KPIs for time: ${error.message}`)
        }
      }

      const nextProcessed = Math.min(state.processed.time + fetched, state.counts.time)
      const nextState: JobState = {
        counts: state.counts,
        processed: {
          invoices: state.processed.invoices,
          time: nextProcessed,
          contracts: state.processed.contracts,
        },
      }

      const done = fetched < KPI_BATCH_SIZE || nextProcessed >= state.counts.time
      const nextPhase = done ? nextProcessingPhase(nextState) : "time"
      const nextOffset = done ? 0 : offset + fetched

      await updateSyncJob(supabase, jobId, {
        progress: computeProgress(nextState, nextPhase === "finalize"),
        processed_items: totalProcessed(nextState),
        current_step:
          nextPhase === "time"
            ? `Generating time KPIs (${nextProcessed}/${state.counts.time})...`
            : nextPhase === "finalize"
              ? "Finalizing KPI generation..."
              : `Processing ${nextPhase} KPIs...`,
        payload: {
          step_name: "generate-kpis",
          step_label: "Generate KPIs",
          counts: nextState.counts,
          processed: nextState.processed,
        },
        batch_phase: nextPhase,
        batch_offset: nextOffset,
        dispatch_lock: false,
      })

      return new Response(
        JSON.stringify({
          ok: true,
          phase: "time",
          processed: nextProcessed,
          total: state.counts.time,
          next_phase: nextPhase,
          next_offset: nextOffset,
        }),
        { headers: { ...corsHeaders(), "Content-Type": "application/json" } },
      )
    }

    if (phase === "contracts") {
      const { customerById, customerByNumber } = await loadCustomerMappings(supabase)
      const { rows, fetched } = await fetchContractBatch(supabase, offset)

      const customerTotals = new Map<string, CustomerTotalsDelta>()
      const periodKpis = new Map<string, PeriodKpiDelta>()

      for (const row of rows) {
        if (!row.is_active || !row.fortnox_customer_number) continue

        const customer = resolveCustomerRef(
          {
            customerId: null,
            fortnoxCustomerNumber: row.fortnox_customer_number,
          },
          customerById,
          customerByNumber,
        )

        if (!customer) continue

        const annualizedValue = annualizeContractTotal(row.total_ex_vat, row.period)
        if (annualizedValue === 0) continue

        const totals = getCustomerTotalsDelta(customerTotals, customer.id)
        totals.contract_value += annualizedValue

        addContractKpiValues(periodKpis, customer, {
          startDate: row.start_date,
          endDate: row.end_date,
          annualizedValue,
        })
      }

      const customerTotalRows = Array.from(customerTotals.values())
      if (customerTotalRows.length > 0) {
        const { error } = await supabase.rpc("accumulate_customer_totals_rows", {
          rows: customerTotalRows,
        })

        if (error) {
          throw new Error(`Failed accumulating customer totals for contracts: ${error.message}`)
        }
      }

      const periodRows = Array.from(periodKpis.values())
      if (periodRows.length > 0) {
        const { error } = await supabase.rpc("accumulate_customer_kpi_rows", {
          rows: periodRows,
        })

        if (error) {
          throw new Error(`Failed accumulating period KPIs for contracts: ${error.message}`)
        }
      }

      const nextProcessed = Math.min(state.processed.contracts + fetched, state.counts.contracts)
      const nextState: JobState = {
        counts: state.counts,
        processed: {
          invoices: state.processed.invoices,
          time: state.processed.time,
          contracts: nextProcessed,
        },
      }

      const done = fetched < KPI_BATCH_SIZE || nextProcessed >= state.counts.contracts
      const nextPhase = done ? nextProcessingPhase(nextState) : "contracts"
      const nextOffset = done ? 0 : offset + fetched

      await updateSyncJob(supabase, jobId, {
        progress: computeProgress(nextState, nextPhase === "finalize"),
        processed_items: totalProcessed(nextState),
        current_step:
          nextPhase === "contracts"
            ? `Generating contract KPIs (${nextProcessed}/${state.counts.contracts})...`
            : "Finalizing KPI generation...",
        payload: {
          step_name: "generate-kpis",
          step_label: "Generate KPIs",
          counts: nextState.counts,
          processed: nextState.processed,
        },
        batch_phase: nextPhase,
        batch_offset: nextOffset,
        dispatch_lock: false,
      })

      return new Response(
        JSON.stringify({
          ok: true,
          phase: "contracts",
          processed: nextProcessed,
          total: state.counts.contracts,
          next_phase: nextPhase,
          next_offset: nextOffset,
        }),
        { headers: { ...corsHeaders(), "Content-Type": "application/json" } },
      )
    }

    if (phase === "finalize") {
      const finalState: JobState = {
        counts: state.counts,
        processed: {
          invoices: state.counts.invoices,
          time: state.counts.time,
          contracts: state.counts.contracts,
        },
      }

      await updateSyncJob(supabase, jobId, {
        status: "completed",
        progress: 100,
        current_step: "Done",
        processed_items: totalProcessed(finalState),
        payload: {
          step_name: "generate-kpis",
          step_label: "Generate KPIs",
          generated: true,
          counts: finalState.counts,
          processed: finalState.processed,
        },
        batch_phase: null,
        batch_offset: 0,
        dispatch_lock: false,
      })

      return new Response(
        JSON.stringify({ ok: true, done: true, counts: finalState.counts }),
        { headers: { ...corsHeaders(), "Content-Type": "application/json" } },
      )
    }

    return new Response(
      JSON.stringify({ error: `Unknown phase: ${phase}` }),
      { status: 400, headers: { ...corsHeaders(), "Content-Type": "application/json" } },
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
      { status: 500, headers: { ...corsHeaders(), "Content-Type": "application/json" } },
    )
  }
})
