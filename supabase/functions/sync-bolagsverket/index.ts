import { createAdminClient } from "../_shared/supabase.ts"
import { updateSyncJob, delay, corsHeaders } from "../_shared/sync-helpers.ts"

/**
 * sync-bolagsverket — monthly Bolagsverket enrichment sweep.
 *
 * Runs the SAME per-customer enrichment the admin UI uses, but for every active
 * customer, on a schedule, without anyone keeping a browser tab open. It's a
 * thin driver on purpose: instead of re-implementing the Bolagsverket client +
 * name matching + annual-report/board sync in Deno (and risking drift), it
 * calls the app's already-tested /api/bolagsverket/refresh route once per
 * customer, authenticated with CRON_SECRET.
 *
 * Chunked + resumable via sync_jobs, exactly like the sync-* Fortnox steps:
 *   • phase "list"    — collect all active customer ids into the job payload.
 *   • phase "process" — enrich BATCH_SIZE customers, paced under Bolagsverket's
 *                       60-calls/min limit (2 calls per customer), then advance
 *                       the offset. The pg_cron dispatcher re-invokes us each
 *                       minute until the offset reaches the end.
 *
 * Required Edge Function secrets (already set for the sync-sie functions):
 *   • APP_BASE_URL — public base URL of the Next.js app (e.g. https://app.example.com)
 *   • CRON_SECRET  — shared secret the refresh route checks (same one the
 *                    nightly chain already uses).
 */

declare const Deno: {
  serve: (handler: (req: Request) => Response | Promise<Response>) => void
  env: { get: (key: string) => string | undefined }
}

// 20 customers × 2 Bolagsverket calls ≈ 40 calls in ~44s ≈ 54/min, under the
// 60/min cap. Small enough that one invocation stays well within the Edge
// Function wall-clock budget.
const BATCH_SIZE = 20
const PACING_MS = 2200

type Tally = {
  confirmed: number
  no_rakenskapsar: number
  name_mismatch: number
  not_found: number
  no_orgnr: number
  error: number
  cards: number
}

const EMPTY_TALLY: Tally = {
  confirmed: 0,
  no_rakenskapsar: 0,
  name_mismatch: 0,
  not_found: 0,
  no_orgnr: 0,
  error: 0,
  cards: 0,
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

    const appUrl = Deno.env.get("APP_BASE_URL")?.trim()
    const cronSecret = Deno.env.get("CRON_SECRET")?.trim()
    if (!appUrl || !cronSecret) {
      throw new Error("APP_BASE_URL and CRON_SECRET must be set as function secrets")
    }

    // ---- phase: list -------------------------------------------------
    if (phase === "list") {
      if (jobId) {
        await updateSyncJob(supabase, jobId, {
          status: "processing",
          current_step: "Listing active customers...",
        })
      }

      const ids: string[] = []
      let scanOffset = 0
      const pageSize = 1000
      while (true) {
        const { data, error } = await supabase
          .from("customers")
          .select("id")
          .eq("status", "active")
          .order("id", { ascending: true })
          .range(scanOffset, scanOffset + pageSize - 1)
        if (error) throw new Error(error.message)
        const rows = (data ?? []) as Array<{ id: string }>
        for (const r of rows) ids.push(r.id)
        if (rows.length < pageSize) break
        scanOffset += pageSize
      }

      if (jobId) {
        await updateSyncJob(supabase, jobId, {
          current_step: `Enriching ${ids.length} customers from Bolagsverket...`,
          total_items: ids.length,
          processed_items: 0,
          payload: {
            step_name: "bolagsverket",
            step_label: "Bolagsverket",
            customer_ids: ids,
            tally: EMPTY_TALLY,
          },
          batch_phase: ids.length > 0 ? "process" : "done",
          batch_offset: 0,
          dispatch_lock: false,
          ...(ids.length === 0 ? { status: "completed", progress: 100 } : {}),
        })
      }

      return new Response(
        JSON.stringify({ ok: true, phase: "list", total: ids.length }),
        { headers: { ...corsHeaders(), "Content-Type": "application/json" } },
      )
    }

    // ---- phase: process ---------------------------------------------
    if (phase === "process") {
      let customerIds: string[] = []
      let tally: Tally = { ...EMPTY_TALLY }

      if (jobId) {
        const { data: jobRow } = await supabase
          .from("sync_jobs")
          .select("payload")
          .eq("id", jobId)
          .single()
        const payload = (jobRow as unknown as { payload: Record<string, unknown> } | null)?.payload
        customerIds = (payload?.customer_ids as string[]) ?? []
        tally = { ...EMPTY_TALLY, ...((payload?.tally as Partial<Tally>) ?? {}) }
      }

      const total = customerIds.length
      const batch = customerIds.slice(offset, offset + BATCH_SIZE)

      for (const customerId of batch) {
        try {
          const res = await fetch(`${appUrl}/api/bolagsverket/refresh`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${cronSecret}`,
            },
            body: JSON.stringify({ customerId }),
          })
          const payload = (await res.json().catch(() => ({}))) as {
            ok?: boolean
            result?: { status?: keyof Tally; cardsMarkedRegistered?: number }
          }
          if (res.ok && payload.ok && payload.result?.status) {
            const status = payload.result.status
            if (status in tally) tally[status] += 1
            tally.cards += payload.result.cardsMarkedRegistered ?? 0
          } else {
            tally.error += 1
          }
        } catch {
          tally.error += 1
        }
        await delay(PACING_MS)
      }

      const nextOffset = offset + BATCH_SIZE
      const isDone = nextOffset >= total
      const processed = Math.min(nextOffset, total)
      const progress = total > 0 ? Math.round((processed / total) * 100) : 100

      if (jobId) {
        await updateSyncJob(supabase, jobId, {
          status: isDone ? "completed" : "processing",
          progress,
          processed_items: processed,
          current_step: isDone
            ? `Done — ${tally.confirmed} confirmed, ${tally.cards} card(s) registered, ${tally.name_mismatch} to review`
            : `Enriching customers (${processed}/${total})...`,
          payload: {
            step_name: "bolagsverket",
            step_label: "Bolagsverket",
            customer_ids: customerIds,
            tally,
          },
          batch_phase: isDone ? "done" : "process",
          batch_offset: isDone ? 0 : nextOffset,
          dispatch_lock: false,
        })
      }

      return new Response(
        JSON.stringify({ ok: true, phase: "process", processed, total }),
        { headers: { ...corsHeaders(), "Content-Type": "application/json" } },
      )
    }

    // Unknown/terminal phase — nothing to do.
    return new Response(
      JSON.stringify({ ok: true, phase }),
      { headers: { ...corsHeaders(), "Content-Type": "application/json" } },
    )
  } catch (error) {
    if (jobId) {
      await updateSyncJob(supabase, jobId, {
        status: "failed",
        error_message: error instanceof Error ? error.message : "Unknown error",
        dispatch_lock: false,
      })
    }
    return new Response(
      JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      }),
      { status: 500, headers: { ...corsHeaders(), "Content-Type": "application/json" } },
    )
  }
})
