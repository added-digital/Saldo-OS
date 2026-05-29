// ---------------------------------------------------------------------------
// sync-sie-kpis Edge Function
//
// Dispatcher-facing handler for the nightly chain's "sie-kpis" step. Recomputes
// revenue, gross margin, EBIT, kassalikviditet and soliditet for every
// (customer, financial_year_from) pair with a successful SIE import.
//
// Same architecture as sync-sie/index.ts — thin proxy to the Node-side
// `/api/fortnox-sie/generate-kpis` endpoint, because the KPI engine imports
// @-aliased Next.js modules that can't load in Deno.
//
// Required env / secrets (set via supabase secrets set):
//   - APP_BASE_URL  → fully-qualified URL of the Vercel deployment
//   - CRON_SECRET   → matches process.env.CRON_SECRET on the Next.js side
// ---------------------------------------------------------------------------

import { createAdminClient } from "../_shared/supabase.ts"
import { updateSyncJob, corsHeaders } from "../_shared/sync-helpers.ts"

declare const Deno: {
  serve: (handler: (req: Request) => Response | Promise<Response>) => void
  env: { get: (key: string) => string | undefined }
}

interface PerCustomerResult {
  customer_id: string
  financial_year_from: string
  status: "success" | "error"
  kpis_written: number
  months_covered: number
  error_message: string | null
}

interface GenerateKpisResponse {
  ok: true
  summary: {
    total: number
    success: number
    failure: number
    duration_ms: number
  }
  results: PerCustomerResult[]
}

interface GenerateKpisError {
  ok: false
  error: string
  message?: string
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

    if (!jobId) {
      throw new Error("Missing job_id")
    }

    const appBaseUrl = Deno.env.get("APP_BASE_URL")?.trim()
    if (!appBaseUrl) {
      throw new Error(
        "APP_BASE_URL not set. Configure via: supabase secrets set APP_BASE_URL=https://<your-vercel-url>",
      )
    }
    const cronSecret = Deno.env.get("CRON_SECRET")?.trim()
    if (!cronSecret) {
      throw new Error(
        "CRON_SECRET not set in Edge Function environment. It must match the Vercel-side CRON_SECRET.",
      )
    }

    await updateSyncJob(supabase, jobId, {
      status: "processing",
      progress: 5,
      current_step: "Generating SIE KPIs...",
    })

    const response = await fetch(
      `${appBaseUrl}/api/fortnox-sie/generate-kpis`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cronSecret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ source: "nightly-cron", job_id: jobId }),
      },
    )

    const payload = (await response.json().catch(() => null)) as
      | GenerateKpisResponse
      | GenerateKpisError
      | null

    if (!response.ok || !payload || payload.ok === false) {
      const msg =
        payload && payload.ok === false
          ? (payload.message ?? payload.error)
          : `HTTP ${response.status}`
      throw new Error(`SIE KPI generation failed: ${msg}`)
    }

    const { total, success, failure, duration_ms } = payload.summary

    await updateSyncJob(supabase, jobId, {
      status: "completed",
      progress: 100,
      current_step:
        failure === 0
          ? `Computed KPIs for ${success}/${total} customer-years`
          : `Computed KPIs for ${success}/${total} customer-years (${failure} failed)`,
      total_items: total,
      processed_items: success,
      payload: {
        step_name: "sie-kpis",
        step_label: "SIE Nyckeltal",
        summary: { total, success, failure, duration_ms },
      },
      batch_phase: null,
      batch_offset: 0,
      dispatch_lock: false,
    })

    return new Response(
      JSON.stringify({ ok: true, done: true, summary: payload.summary }),
      { headers: { ...corsHeaders(), "Content-Type": "application/json" } },
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
      {
        status: 500,
        headers: { ...corsHeaders(), "Content-Type": "application/json" },
      },
    )
  }
})
