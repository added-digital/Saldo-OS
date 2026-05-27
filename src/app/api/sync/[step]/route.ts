import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import type { Profile } from "@/types/database"

const VALID_STEPS = new Set([
  "customers",
  "employees",
  "invoices",
  "invoice-rows",
  "articles",
  "time-reports",
  "contracts",
  "generate-kpis",
  // sie-kpis: derives financial KPIs (revenue, EBIT, kassalikviditet,
  // soliditet, gross margin) from sie_period_balances + sie_account_balances
  // into sie_kpis. Reserved here so the dispatcher accepts it once a
  // sync-sie-kpis Edge Function exists. Until then the UI triggers the
  // computation directly via /api/fortnox-sie/generate-kpis instead.
  "sie-kpis",
])

const STEP_LABELS: Record<string, string> = {
  customers: "Customers",
  employees: "Employees",
  invoices: "Invoices",
  "invoice-rows": "Invoice Rows",
  articles: "Articles",
  "time-reports": "Time Reports",
  contracts: "Contracts",
  "generate-kpis": "Generate KPIs",
  "sie-kpis": "SIE Nyckeltal",
}

async function authorize() {
  const supabase = await createClient()

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError || !user) return null

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single<Pick<Profile, "role">>()

  return profile?.role === "admin" ? user : null
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ step: string }> }
) {
  try {
    const user = await authorize()
    if (!user) {
      return NextResponse.json(
        { error: "Forbidden: Admin access required" },
        { status: 403 }
      )
    }

    const { step } = await params
    const body = (await request.json().catch(() => ({}))) as {
      start_customer_number?: string
    }
    const startCustomerNumber =
      typeof body.start_customer_number === "string" &&
      body.start_customer_number.trim().length > 0
        ? body.start_customer_number.trim()
        : undefined

    if (!VALID_STEPS.has(step)) {
      return NextResponse.json(
        { error: `Invalid sync step: ${step}` },
        { status: 400 }
      )
    }

    const supabase = await createClient()
    const label = STEP_LABELS[step] ?? step
    const payload: Record<string, unknown> = { step_name: step, step_label: label }
    if (step === "invoices" && startCustomerNumber) {
      payload.start_customer_number = startCustomerNumber
    }

    const { data: jobRow, error: insertError } = await supabase
      .from("sync_jobs")
      .insert({
        status: "pending",
        progress: 0,
        current_step: `Waiting for ${label}...`,
        total_items: 0,
        processed_items: 0,
        step_name: step,
        batch_phase: "list",
        batch_offset: 0,
        dispatch_lock: false,
        started_by: user.id,
        payload,
      } as never)
      .select("id")
      .single()

    if (insertError || !jobRow) {
      return NextResponse.json(
        { error: "Failed to create sync job", detail: insertError?.message },
        { status: 500 }
      )
    }

    return NextResponse.json({
      job_id: (jobRow as unknown as { id: string }).id,
      step,
      message: `Sync job queued for ${label}. pg_cron will process it automatically.`,
    })
  } catch (error) {
    return NextResponse.json(
      {
        error: "Sync trigger failed",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    )
  }
}
