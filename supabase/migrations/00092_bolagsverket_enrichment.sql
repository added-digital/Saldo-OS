-- =====================================================================
-- Migration 00092: Bolagsverket enrichment — org.nr + räkenskapsår
-- =====================================================================
-- Makes Bolagsverket the primary source for a customer's räkenskapsår and
-- adds the columns the enrichment writer needs. Deliberately ADDITIVE and
-- non-destructive:
--
--   • Bolagsverket only WRITES to its own *_bv columns + the bolagsverket_*
--     status columns. It never overwrites the customer name, and only touches
--     org_number when it has CONFIRMED the company (name matches) — see the
--     enrichment writer in src/lib/bolagsverket/enrich.ts.
--   • On a name mismatch (possible wrong org.nr) it writes nothing to the
--     effective fields; it just raises a flag for a human to review.
--
-- Precedence after this migration:
--   räkenskapsår end  = COALESCE(_bv, _sie, _manual)   → Bolagsverket wins
--   räkenskapsår start= COALESCE(_bv, _sie, _manual)   → BV gives only the
--     END date, so _from_bv stays NULL and the start still falls back to SIE
--     or manual. That's intentional: BV supplies the year-END (its strength),
--     SIE/manual can still supply the start.

-- ---------------------------------------------------------------------
-- 1. Bolagsverket bookkeeping columns
-- ---------------------------------------------------------------------
ALTER TABLE customers
  -- Canonical org number exactly as Bolagsverket holds it (reference/audit;
  -- the effective org_number is only updated on a confirmed match).
  ADD COLUMN IF NOT EXISTS org_number_bv TEXT,

  -- Outcome of the last Bolagsverket lookup. Mirrors the dry-run categories:
  --   confirmed        found; name matches; org.nr + räkenskapsår available
  --   no_rakenskapsar  found; name matches; but no filed annual report
  --   name_mismatch    found; but BV's name != ours  → REVIEW (wrong org.nr?)
  --   not_found        BV has nothing for this org.nr (individual / foreign)
  --   no_orgnr         customer has no org.nr, so we can't look it up
  ADD COLUMN IF NOT EXISTS bolagsverket_match_status TEXT
    CHECK (bolagsverket_match_status IN (
      'confirmed', 'no_rakenskapsar', 'name_mismatch', 'not_found', 'no_orgnr'
    )),

  -- Convenience flag for the UI's "needs review" badge. True only when
  -- bolagsverket_match_status = 'name_mismatch'.
  ADD COLUMN IF NOT EXISTS bolagsverket_name_mismatch BOOLEAN NOT NULL DEFAULT false,

  -- Räkenskapsår sourced from Bolagsverket. _to is the latest filed annual
  -- report period end; _from stays NULL (BV doesn't provide a start).
  ADD COLUMN IF NOT EXISTS financial_year_from_bv DATE,
  ADD COLUMN IF NOT EXISTS financial_year_to_bv   DATE;

-- ---------------------------------------------------------------------
-- 2. Re-point the generated räkenskapsår columns to prefer Bolagsverket
-- ---------------------------------------------------------------------
-- Generated-column expressions can't be ALTERed in place, so drop and
-- re-add. Safe: these are STORED generated columns and nothing in the DB
-- depends on them (readers use the *_sie / *_manual source columns or the
-- SIE KPI tables, not customers.financial_year_from/to).
ALTER TABLE customers DROP COLUMN IF EXISTS financial_year_from;
ALTER TABLE customers DROP COLUMN IF EXISTS financial_year_to;

ALTER TABLE customers
  ADD COLUMN financial_year_from DATE
    GENERATED ALWAYS AS (
      COALESCE(financial_year_from_bv, financial_year_from_sie, financial_year_from_manual)
    ) STORED,
  ADD COLUMN financial_year_to DATE
    GENERATED ALWAYS AS (
      COALESCE(financial_year_to_bv, financial_year_to_sie, financial_year_to_manual)
    ) STORED;

-- ---------------------------------------------------------------------
-- 3. Index for the "needs review" work list
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_customers_bolagsverket_match_status
  ON customers(bolagsverket_match_status);
