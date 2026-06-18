-- =====================================================================
-- Migration 00078: Mirror Bokslut "Ej aktuell" onto INK2
-- =====================================================================
-- A company parked as "Ej aktuell" in the Bokslut workflow isn't part of this
-- cycle at all, so it should show in INK2's parked column too. This backfills
-- the INK2 status for every engagement currently parked in Bokslut.
-- Requires migration 00077 (the INK2 'ej_aktuell' status). Idempotent.

UPDATE engagements e
SET ink2_status_id = ink2_parked.id,
    updated_at = now()
FROM engagement_statuses bok_parked, engagement_statuses ink2_parked
WHERE bok_parked.workflow = 'bokslut' AND bok_parked.key = 'ej_aktuell'
  AND ink2_parked.workflow = 'ink2'   AND ink2_parked.key = 'ej_aktuell'
  AND e.bokslut_status_id = bok_parked.id
  AND e.ink2_status_id IS DISTINCT FROM ink2_parked.id;
