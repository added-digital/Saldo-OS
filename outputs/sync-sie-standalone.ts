// ---------------------------------------------------------------------------
// sync-sie Edge Function — standalone version (no _shared imports)
// Paste this into the Supabase Editor when creating the "sync-sie" function.
// ---------------------------------------------------------------------------

import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

declare const Deno: {
  serve: (handler: (req: Request) => Response | Promise<Response>) => void
  env: { get: (key: string) => string | undefined }
}

function createAdminClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  )
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
  }
}

interface SyncJobUpdate {
  status?: string
  progress?: number
  current_step?: string
  total_items?: number
  processed_items?: number
  error_message?: string | null
  payload?: Record<string, unknown>
  batch_phase?: string | null
  batch_offset?: number
  dispatch_lock?: boolean
}

async function updateSyncJob(
  supabase: ReturnType<typeof createAdminClient>,
  jobId: string,
  update: SyncJobUpdate,
) {
  const { error } = await supabase
    .from("sync_jobs")
    .update({ ...update, updated_at: new Date().toISOString() } as never)
    .eq("id", jobId as never)
  if (error) console.error("Failed to update sync job:", error)
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
    if (!jobId) throw new Error("Missing job_id")

    const appBaseUrl = Deno.env.get("APP_BASE_URL")?.trim()
    if (!appBaseUrl) throw new Error("APP_BASE_URL not set")
    const cronSecret = Deno.env.get("CRON_SECRET")?.trim()
    if (!cronSecret) throw new Error("CRON_SECRET not set")

    await updateSyncJob(supabase, jobId, {
      status: "processing",
      progress: 5,
      current_step: "Syncing SIE files from Fortnox...",
    })

    const response = await fetch(`${appBaseUrl}/api/fortnox-sie/sync-all`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cronSecret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ source: "nightly-cron", job_id: jobId }),
    })

    const payload = (await response.json().catch(() => null)) as
      | {
          ok: true
          summary: { total: number; success: number; failure: number; duration_ms: number }
        }
      | { ok: false; error: string; message?: string }
      | null

    if (!response.ok || !payload || payload.ok === false) {
      const msg =
        payload && payload.ok === false
          ? (payload.message ?? payload.error)
          : `HTTP ${response.status}`
      throw new Error(`SIE sync-all failed: ${msg}`)
    }

    const { total, success, failure, duration_ms } = payload.summary

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
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders(), "Content-Type": "application/json" },
    })
  }
})
