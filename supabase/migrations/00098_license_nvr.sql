-- NVR (aktiebok) billing.
-- Adds a per-client flat-price override for the aktiebok/NVR service and a
-- one-time start-fee flag. The 3000 kr startavgift is billed exactly once, the
-- month a client first has aktiebok; nvr_start_fee_charged_at records when it
-- was invoiced (NULL = not yet charged). The recurring monthly charge is
-- 15 kr × antal aktieägare unless fixed_price_nvr is set.

ALTER TABLE license_customer_config
  ADD COLUMN IF NOT EXISTS fixed_price_nvr NUMERIC(12, 2),
  ADD COLUMN IF NOT EXISTS nvr_start_fee_charged_at TIMESTAMPTZ;
