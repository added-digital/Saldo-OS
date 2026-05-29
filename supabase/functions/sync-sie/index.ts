// ---------------------------------------------------------------------------
// sync-sie Edge Function
//
// Dispatcher-facing handler for the nightly chain's "sie" step.
//
// Unlike the firm-wide sync edge functions (sync-customers, sync-invoices, …)
// the SIE pipeline lives in Node-only code: the parser, the per-customer
// orchestrator, and the ledger upserter all import @-aliased Next.js modules
// that can't be loaded from Deno. Porting them to Deno would more than double
// the SIE code surface for no functional gain.
//
// So this function is a thin proxy: it POSTs to the existing Next.js endpoint
// `/api/fortnox-sie/sync-all` (auth'd via CRON_SECRET), then mirrors the
// outcome into sync_jobs so the run shows up in the sync history exactly like
// every other step.
//
// Required env / secrets (set via supabase secrets set):
//   - APP_BASE_URL  → fully-qualified URL of the Vercel deployment
//                     (e.g. https://saldo-crm.vercel.app). No trailing slash.
//   - CRON_SECRET   → matches process.env.CRON_SECRET on the Next.js side.
//                     The Next.js routes accept it as bearer auth.
// ---------------------------------------------------------------------------

import { createAdminClient } from "../_shared/supabase.ts"
import { updateSyncJob, corsHeaders } from "../_shared/sync-helpers.ts"

declare const Deno: {
  serve: (handler: (req: Request) => Response | Promise<Response>) => void
  env: { get: (key: string) => string | undefined }
}

interface PerCustomerResult {
  customer_id: string
  status: string
  error_message: string | null
  counts?: {
    accounts: number
    vouchers: number
    transactions: number
    warnings: number
  }
}

interface SyncAllResponse {
  ok: true
  summary: {
    total: number
    success: number
    failure: number
    duration_ms: number
  }
  results: PerCustomerResult[]
}

interface SyncAllError {
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

    // -------------------------------------------------------------------
    // Mark the job as processing right away so the UI shows a live state
    // while the long-running Next.js call is in flight.
    // -------------------------------------------------------------------
    await updateSyncJob(supabase, jobId, {
      status: "processing",
      progress: 5,
      current_step: "Syncing SIE files from Fortnox...",
      // Leave dispatch_lock TRUE so process_sync_queue() doesn't re-fire us
      // while the inner call is still running. The 3-minute stale check
      // there is the only safety net if the inner call hangs.
    })

    // -------------------------------------------------------------------
    // Proxy to the Node-side orchestrator. It loops every active
    // sie_connection sequentially with a 350ms inter-customer delay; the
    // route has maxDuration=300s configured in Next.js.
    // -------------------------------------------------------------------
    const response = await fetch(`${appBaseUrl}/api/fortnox-sie/sync-all`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cronSecret}`,
        "Content-Type": "application/json",
      },
      // Body is ignored by the route but Vercel requires a payload for POSTs.
      body: JSON.stringify({ source: "nightly-cron", job_id: jobId }),
    })

    const payload = (await response.json().catch(() => null)) as
      | SyncAllResponse
      | SyncAllError
      | null

    if (!response.ok || !payload || payload.ok === false) {
      const msg =
        payload && payload.ok === false
          ? (payload.message ?? payload.error)
          : `HTTP ${response.status}`
      throw new Error(`SIE sync-all failed: ${msg}`)
    }

    const { total, success, failure, duration_ms } = payload.summary

    // -------------------------------------------------------------------
    // Mark the job complete and persist a small summary in payload so the
    // history row shows useful numbers ("Synced 12/14, 2 failed").
    // -------------------------------------------------------------------
    await updateSyncJob(supabase, jobId, {
      status: "completed",
      progress: 100,
      current_step:
        failure === 0
          ? `Synced ${success}/${total} customers`
          : `Synced ${success}/${total} customers (${failure} failed)`,
      total_items: total,
      processed_items: success,
      payload: {
        step_name: "sie",
        step_label: "SIE Bookkeeping",
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
