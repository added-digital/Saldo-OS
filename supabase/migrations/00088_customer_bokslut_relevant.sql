-- =====================================================
-- Migration 00088: Flag whether Bokslut applies to a customer
-- =====================================================
--
-- Not every active customer should ever have a year-end close. The "saknar
-- bokslut" (Without bokslut) list previously surfaced every active aktiebolag
-- without an engagement card, including ones the office will never do a bokslut
-- for. This adds an opt-out, set during onboarding on the customer card.
--
-- Three-state, intentionally NULLABLE (no DEFAULT):
--   NULL  — not reviewed yet. Still appears in the gap list (the default state
--           for every existing and newly-imported customer).
--   true  — confirmed relevant / "should have a bokslut". Appears in the list.
--   false — not relevant. Hidden from the gap list and the bokslutsuppgifter
--           section on the customer card is collapsed.
--
-- The gap list keeps a row whenever bokslut_relevant IS DISTINCT FROM false, so
-- both NULL and true show; only an explicit false hides it. New Fortnox imports
-- (which don't set this column) come in as NULL and therefore still show up.

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS bokslut_relevant BOOLEAN;

-- Seed: a customer that already has an engagement on the board clearly should
-- have a bokslut, so mark those explicitly relevant. Everyone else is left
-- untouched (NULL) — no assumption is made about customers nobody has reviewed.
UPDATE customers c
SET bokslut_relevant = true
WHERE c.bokslut_relevant IS NULL
  AND EXISTS (SELECT 1 FROM engagements e WHERE e.customer_id = c.id);

-- Partial index for the cheap "exclude the irrelevant ones" filter (only the
-- explicit false rows are worth indexing).
CREATE INDEX IF NOT EXISTS idx_customers_bokslut_not_relevant
  ON customers(bokslut_relevant)
  WHERE bokslut_relevant = false;
