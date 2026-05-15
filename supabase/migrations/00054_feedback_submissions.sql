-- Feedback submissions captured from the floating widget on every dashboard
-- page. Anyone signed in can insert their own row. Admins read everything;
-- regular users can read back the rows they submitted themselves (so the UI
-- could later show "your past feedback" if we want).

CREATE TABLE IF NOT EXISTS feedback_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,

  -- Loose taxonomy. Kept as TEXT + CHECK so we can add categories later
  -- without a migration.
  category TEXT NOT NULL CHECK (category IN ('bug', 'feature', 'question', 'other')),
  message TEXT NOT NULL CHECK (length(trim(message)) > 0),

  -- Context auto-captured by the client. Useful for routing the issue
  -- without asking the submitter follow-up questions.
  page_url TEXT,
  user_agent TEXT,

  -- Admin triage state.
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'triaged', 'resolved')),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feedback_submissions_status_created
  ON feedback_submissions(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_feedback_submissions_user_id
  ON feedback_submissions(user_id);

DROP TRIGGER IF EXISTS feedback_submissions_set_updated_at ON feedback_submissions;
CREATE TRIGGER feedback_submissions_set_updated_at
  BEFORE UPDATE ON feedback_submissions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE feedback_submissions ENABLE ROW LEVEL SECURITY;

-- Any authenticated user can submit feedback for themselves only.
DROP POLICY IF EXISTS feedback_submissions_insert ON feedback_submissions;
CREATE POLICY feedback_submissions_insert
  ON feedback_submissions
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

-- Read: admins see everything, everyone else only their own rows.
DROP POLICY IF EXISTS feedback_submissions_select ON feedback_submissions;
CREATE POLICY feedback_submissions_select
  ON feedback_submissions
  FOR SELECT
  TO authenticated
  USING (
    get_user_role() = 'admin' OR user_id = auth.uid()
  );

-- Update / delete: admins only (used by the triage UI).
DROP POLICY IF EXISTS feedback_submissions_admin_write ON feedback_submissions;
CREATE POLICY feedback_submissions_admin_write
  ON feedback_submissions
  FOR UPDATE
  TO authenticated
  USING (get_user_role() = 'admin')
  WITH CHECK (get_user_role() = 'admin');

DROP POLICY IF EXISTS feedback_submissions_admin_delete ON feedback_submissions;
CREATE POLICY feedback_submissions_admin_delete
  ON feedback_submissions
  FOR DELETE
  TO authenticated
  USING (get_user_role() = 'admin');
