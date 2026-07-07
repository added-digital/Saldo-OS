-- =====================================================================
-- Migration 00095: Monthly Bolagsverket enrichment sweep
-- =====================================================================
-- Enriches EVERY active customer from Bolagsverket once a month, unattended.
-- This is what keeps the bokslut board's "Registrerad hos Bolagsverket" status
-- + verified badge current without anyone clicking the browser sweep.
--
-- Reuses the existing job machinery:
--   • enqueue_bolagsverket_sync() inserts one sync_jobs row (step 'bolagsverket').
--   • The already-running per-minute dispatcher (process_sync_queue) picks it up
--     and POSTs to the sync-bolagsverket Edge Function generically — no
--     dispatcher change needed. That function walks all active customers in
--     paced chunks (resumable via batch_offset) until done.
--
-- Cadence is monthly on purpose: Bolagsverket registration data changes slowly,
-- so nightly would be wasted calls against the 60/min rate limit.

-- ---------------------------------------------------------------------
-- Enqueue function: one job, and only if none is already in flight.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enqueue_bolagsverket_sync()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Don't stack sweeps: skip if one is still pending/processing.
  IF EXISTS (
    SELECT 1 FROM sync_jobs
    WHERE step_name = 'bolagsverket'
      AND status IN ('pending', 'processing')
  ) THEN
    RETURN;
  END IF;

  INSERT INTO sync_jobs (
    status, progress, current_step, total_items, processed_items,
    step_name, batch_phase, batch_offset, dispatch_lock, payload
  ) VALUES (
    'pending', 0, 'Waiting for Bolagsverket...', 0, 0,
    'bolagsverket', 'list', 0, false,
    jsonb_build_object(
      'step_name', 'bolagsverket',
      'step_label', 'Bolagsverket',
      'triggered_by', 'cron'
    )
  );
END;
$$;

-- ---------------------------------------------------------------------
-- Schedule: 02:00 on the 1st of every month (Bolagsverket sweep).
-- unschedule-then-schedule so re-running the migration is idempotent.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  PERFORM cron.unschedule('enqueue-bolagsverket-monthly');
EXCEPTION WHEN OTHERS THEN
  NULL; -- not scheduled yet; ignore
END $$;

SELECT cron.schedule(
  'enqueue-bolagsverket-monthly',
  '0 2 1 * *',
  $$SELECT enqueue_bolagsverket_sync()$$
);
