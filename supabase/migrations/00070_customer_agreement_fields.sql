-- =====================================================
-- Migration 00070: Customer agreement fields (Saldoavtal datum, Fast pris)
-- =====================================================
--
-- Two typed columns from the Excel that don't fit the Ja/Nej tag model. They're
-- durable commercial facts about the client relationship, so they live on the
-- customer (edited in the Bokslut setup panel), not per engagement.
--
--   saldoavtal_date       — when the Saldo agreement was signed.
--   fixed_monthly_price    — agreed fixed monthly fee (SEK), if any.
--
-- (Snittid per månad is intentionally omitted; a reliable average belongs to a
--  per-customer time aggregation rather than a hand-entered number.)

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS saldoavtal_date DATE,
  ADD COLUMN IF NOT EXISTS fixed_monthly_price NUMERIC(12, 2);
