-- Capture "missing tool / capability" requests from the chat assistant in the
-- existing feedback_submissions table.
--
-- The chat UI emits a hidden <missing_tool> block whenever the assistant says
-- it lacks a tool or data access; the frontend offers a one-click "submit as
-- feature request" CTA that writes a row here.
--
-- The original table (migration 00054) was shaped for the manual feedback
-- widget: a constrained `category`, a NOT NULL `message`, and no place for the
-- structured (query, capability) pair the assistant produces. This migration
-- extends it minimally rather than introducing a separate table, so the admin
-- triage UI sees these requests alongside everything else:
--   • adds 'missing_tool' to the category CHECK (this is the request `type`).
--   • adds nullable `query` (the user's verbatim question) and `capability`
--     (one-line description of the tool/access needed) columns.
--
-- `message` stays NOT NULL — the client sets message = query for these rows so
-- the existing triage views keep showing human-readable content with no schema
-- gymnastics. `created_at` keeps its DEFAULT now().

ALTER TABLE feedback_submissions
  ADD COLUMN IF NOT EXISTS query TEXT,
  ADD COLUMN IF NOT EXISTS capability TEXT;

ALTER TABLE feedback_submissions
  DROP CONSTRAINT IF EXISTS feedback_submissions_category_check;

ALTER TABLE feedback_submissions
  ADD CONSTRAINT feedback_submissions_category_check
  CHECK (category IN ('bug', 'feature', 'question', 'other', 'missing_tool'));

COMMENT ON COLUMN feedback_submissions.query IS
  'For category=missing_tool: the user''s original chat question, verbatim.';
COMMENT ON COLUMN feedback_submissions.capability IS
  'For category=missing_tool: one-line description of the tool or data access that would be needed.';
