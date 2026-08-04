-- ---------------------------------------------------------------------------
-- 00111_sie_steps_survive_chain_failure.sql
--
-- advance_nightly_chain() cancelled every remaining step as soon as any step
-- in the chain failed ("Cancelled: previous step failed"). In practice that
-- meant a flaky Generate KPIs run — it times out on the first invoice batch
-- every other night — also took out SIE Bookkeeping and SIE Nyckeltal, which
-- are the last two steps but depend on none of its output.
--
-- 00060 put the SIE steps last precisely so their failures could not block the
-- firm-wide steps. This makes the guarantee symmetric: the SIE steps read
-- Fortnox per customer and write sie_* tables of their own, so an earlier
-- failure is no reason to skip them.
--
-- The dependencies they do have are still enforced:
--   sie       needs customers (it loops over customers/sie_connections)
--   sie-kpis  needs sie       (it derives KPIs from the ledger sie just wrote)
--
-- Every other step keeps the old behaviour: a failure cancels what is left.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION advance_nightly_chain()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  active_chain TEXT;
  current_index INT;
  current_step TEXT;
  prev_status TEXT;
  prerequisite_step TEXT;
  prerequisite_status TEXT;
  has_failure BOOLEAN;
BEGIN
  SELECT nightly_chain_id INTO active_chain
  FROM sync_jobs
  WHERE nightly_chain_id IS NOT NULL
    AND status = 'pending'
  ORDER BY nightly_step_index ASC
  LIMIT 1;

  IF active_chain IS NULL THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM sync_jobs
    WHERE nightly_chain_id = active_chain
      AND status = 'processing'
  ) THEN
    RETURN;
  END IF;

  SELECT nightly_step_index, step_name
  INTO current_index, current_step
  FROM sync_jobs
  WHERE nightly_chain_id = active_chain
    AND status = 'pending'
  ORDER BY nightly_step_index ASC
  LIMIT 1;

  IF current_index IS NULL THEN
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM sync_jobs
    WHERE nightly_chain_id = active_chain
      AND status = 'failed'
  ) INTO has_failure;

  IF has_failure THEN
    prerequisite_step := CASE current_step
      WHEN 'sie' THEN 'customers'
      WHEN 'sie-kpis' THEN 'sie'
      ELSE NULL
    END;

    IF prerequisite_step IS NULL THEN
      UPDATE sync_jobs
      SET status = 'failed',
          error_message = 'Cancelled: previous step failed'
      WHERE nightly_chain_id = active_chain
        AND status = 'pending';
      RETURN;
    END IF;

    SELECT status INTO prerequisite_status
    FROM sync_jobs
    WHERE nightly_chain_id = active_chain
      AND step_name = prerequisite_step;

    IF prerequisite_status IS DISTINCT FROM 'completed' THEN
      UPDATE sync_jobs
      SET status = 'failed',
          error_message = 'Cancelled: ' || prerequisite_step || ' did not complete'
      WHERE nightly_chain_id = active_chain
        AND nightly_step_index = current_index
        AND status = 'pending';
      RETURN;
    END IF;

    UPDATE sync_jobs
    SET status = 'processing'
    WHERE nightly_chain_id = active_chain
      AND nightly_step_index = current_index
      AND status = 'pending';
    RETURN;
  END IF;

  IF current_index = 0 THEN
    UPDATE sync_jobs
    SET status = 'processing'
    WHERE nightly_chain_id = active_chain
      AND nightly_step_index = 0
      AND status = 'pending';
    RETURN;
  END IF;

  SELECT status INTO prev_status
  FROM sync_jobs
  WHERE nightly_chain_id = active_chain
    AND nightly_step_index = current_index - 1;

  IF prev_status = 'completed' THEN
    UPDATE sync_jobs
    SET status = 'processing'
    WHERE nightly_chain_id = active_chain
      AND nightly_step_index = current_index
      AND status = 'pending';
  END IF;
END;
$$;
