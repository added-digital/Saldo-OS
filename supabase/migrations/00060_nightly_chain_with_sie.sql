-- ---------------------------------------------------------------------------
-- 00060_nightly_chain_with_sie.sql
--
-- Extends the nightly sync chain to include the SIE bookkeeping pipeline.
--
-- New steps, appended after the existing Generate KPIs step:
--   index 6 → sie       (per-customer Fortnox SIE file fetch + ledger upsert)
--   index 7 → sie-kpis  (recompute the 5 financial KPIs from sie_period_balances)
--
-- Position rationale:
--   The SIE chain is per-customer (looped over sie_connections) and slower
--   than the firm-wide steps. Putting it last means a SIE timeout or partial
--   failure does NOT block the bread-and-butter sync (customers / invoices /
--   time / contracts / generate-kpis), which the rest of the app depends on.
--
-- Dispatcher integration:
--   process_sync_queue() in 00040 calls
--     ${base_url}/functions/v1/sync-${step_name}
--   so the new steps require matching Edge Functions:
--     supabase/functions/sync-sie/index.ts
--     supabase/functions/sync-sie-kpis/index.ts
--   Both are thin wrappers over the existing Next.js routes
--   (/api/fortnox-sie/sync-all and /api/fortnox-sie/generate-kpis), authed
--   via the CRON_SECRET bearer path.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION enqueue_nightly_sync_chain()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  stockholm_now TIMESTAMP;
  chain_id TEXT;
BEGIN
  stockholm_now := timezone('Europe/Stockholm', now());

  IF EXTRACT(HOUR FROM stockholm_now) < 1 THEN
    RETURN;
  END IF;

  chain_id := 'nightly-sync-' || to_char(stockholm_now::date, 'YYYY-MM-DD');

  IF EXISTS (
    SELECT 1
    FROM sync_jobs
    WHERE nightly_chain_id = chain_id
  ) THEN
    RETURN;
  END IF;

  INSERT INTO sync_jobs (
    status,
    progress,
    current_step,
    total_items,
    processed_items,
    step_name,
    batch_phase,
    batch_offset,
    dispatch_lock,
    payload,
    started_by,
    nightly_chain_id,
    nightly_step_index
  )
  VALUES
    (
      'pending', 0, 'Waiting for Customers...', 0, 0,
      'customers', 'list', 0, false,
      jsonb_build_object('step_name','customers','step_label','Customers'),
      NULL,
      chain_id, 0
    ),
    (
      'pending', 0, 'Waiting for Invoices...', 0, 0,
      'invoices', 'list', 0, false,
      jsonb_build_object('step_name','invoices','step_label','Invoices','sync_mode','skip_finalized'),
      NULL,
      chain_id, 1
    ),
    (
      'pending', 0, 'Waiting for Time Reports...', 0, 0,
      'time-reports', 'list', 0, false,
      jsonb_build_object('step_name','time-reports','step_label','Time Reports'),
      NULL,
      chain_id, 2
    ),
    (
      'pending', 0, 'Waiting for Contracts...', 0, 0,
      'contracts', 'list', 0, false,
      jsonb_build_object('step_name','contracts','step_label','Contracts'),
      NULL,
      chain_id, 3
    ),
    (
      'pending', 0, 'Waiting for Articles...', 0, 0,
      'articles', 'list', 0, false,
      jsonb_build_object('step_name','articles','step_label','Articles'),
      NULL,
      chain_id, 4
    ),
    (
      'pending', 0, 'Waiting for Generate KPIs...', 0, 0,
      'generate-kpis', 'list', 0, false,
      jsonb_build_object('step_name','generate-kpis','step_label','Generate KPIs'),
      NULL,
      chain_id, 5
    ),
    (
      'pending', 0, 'Waiting for SIE Bookkeeping...', 0, 0,
      'sie', 'list', 0, false,
      jsonb_build_object('step_name','sie','step_label','SIE Bookkeeping'),
      NULL,
      chain_id, 6
    ),
    (
      'pending', 0, 'Waiting for SIE Nyckeltal...', 0, 0,
      'sie-kpis', 'list', 0, false,
      jsonb_build_object('step_name','sie-kpis','step_label','SIE Nyckeltal'),
      NULL,
      chain_id, 7
    );
END;
$$;
