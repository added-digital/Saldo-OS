-- =====================================================
-- Migration 00106: Deal value on leads
-- =====================================================
-- Staff need to weigh a lead by what it is worth, not just by how old it is.
-- `deal_value` is the estimated annual value of the deal in SEK, entered by
-- hand in the lead's edit dialog and shown on the board card.
--
-- NUMERIC(12, 2) matches the money columns elsewhere in the schema: exact
-- decimal arithmetic (never float), with room for values far beyond anything a
-- single engagement would carry. NULL = not estimated yet, which is different
-- from a deal genuinely worth 0.

ALTER TABLE website_leads
  ADD COLUMN IF NOT EXISTS deal_value NUMERIC(12, 2);

COMMENT ON COLUMN website_leads.deal_value IS
  'Estimated annual deal value in SEK. NULL = not estimated.';

-- A negative deal is not a thing; guard it at the column so no client can
-- write one. Added NOT VALID first would need a second statement — the table
-- has no negative values to begin with, so validate immediately.
ALTER TABLE website_leads
  DROP CONSTRAINT IF EXISTS website_leads_deal_value_non_negative;
ALTER TABLE website_leads
  ADD CONSTRAINT website_leads_deal_value_non_negative
    CHECK (deal_value IS NULL OR deal_value >= 0);

-- Partial index: only estimated leads are interesting to rank by value.
CREATE INDEX IF NOT EXISTS idx_website_leads_deal_value
  ON website_leads(deal_value DESC) WHERE deal_value IS NOT NULL;
