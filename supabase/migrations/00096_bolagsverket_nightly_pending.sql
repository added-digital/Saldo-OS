-- =====================================================================
-- Migration 00096: Nightly targeted Bolagsverket sync (pending cards)
-- =====================================================================
-- The monthly full sweep (00095) is a safety net, but during filing season a
-- card can sit "not registered" for up to 30 days after Bolagsverket actually
-- registered it. Full-sweeping nightly would be wasteful — 90% of customers
-- can't change (already confirmed, or bokslut not sent yet).
--
-- So we add a CHEAP nightly run that only touches customers with a bokslut card
-- awaiting registration (status granskad..skickad, not yet BV-confirmed).
-- Usually a few dozen customers, not ~800. The edge function picks the customer
-- set from payload.sync_mode ('full' | 'pending').

-- ---------------------------------------------------------------------
-- Mode-aware enqueue. Replaces the no-arg version from 00095 (the monthly
-- schedule calls it with no args, which resolves to the 'full' default).
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS enqueue_bolagsverket_sync();

CREATE OR REPLACE FUNCTION enqueue_bolagsverket_sync(p_mode text DEFAULT 'full')
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Don't stack sweeps of the same mode: skip if one is still in flight.
  IF EXISTS (
    SELECT 1 FROM sync_jobs
    WHERE step_name = 'bolagsverket'
      AND status IN ('pending', 'processing')
      AND COALESCE(payload->>'sync_mode', 'full') = p_mode
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
      'step_label', CASE WHEN p_mode = 'pending'
                         THEN 'Bolagsverket (pending)'
                         ELSE 'Bolagsverket' END,
      'sync_mode', p_mode,
      'triggered_by', 'cron'
    )
  );
END;
$$;

-- ---------------------------------------------------------------------
-- Nightly targeted run at 03:00 (after the Fortnox nightly chain).
-- ---------------------------------------------------------------------
DO $$
BEGIN
  PERFORM cron.unschedule('enqueue-bolagsverket-nightly-pending');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'enqueue-bolagsverket-nightly-pending',
  '0 3 * * *',
  $$SELECT enqueue_bolagsverket_sync('pending')$$
);
