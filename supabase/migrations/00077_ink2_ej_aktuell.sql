-- =====================================================================
-- Migration 00077: Add "Ej aktuell" parked status to the INK2 workflow
-- =====================================================================
-- The Bokslut workflow has a parked "Ej aktuell" status (00066); INK2 didn't.
-- The board renders parked columns generically per workflow, so adding this
-- row makes the same far-right "Ej aktuell" bucket appear on the INK2 tab too.
-- Idempotent: re-running keeps the label/order/flags in sync.

INSERT INTO engagement_statuses (workflow, key, label, sort_order, is_done, is_parked) VALUES
  ('ink2', 'ej_aktuell', 'Ej aktuell', 99, false, true)
ON CONFLICT (workflow, key)
  DO UPDATE SET
    label = EXCLUDED.label,
    sort_order = EXCLUDED.sort_order,
    is_done = EXCLUDED.is_done,
    is_parked = EXCLUDED.is_parked;
