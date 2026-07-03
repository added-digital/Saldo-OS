-- =====================================================
-- Migration 00091: Engagement comments
-- =====================================================
-- Adds a threaded comment feed to each engagement (uppdrag), shown as a column
-- beside the detail sheet. Unlike the single free-text fields on `engagements`
-- (bokslut_comment, next_year_note, general_comment), these are discrete posts:
-- each row records its author and creation time so the UI can show "by whom and
-- when". Comments support the same @-mentions as the other comment fields.
--
-- RLS mirrors engagements for read/insert (has_scope('customers')). Editing and
-- deleting are restricted to the comment's author; admins may also delete any
-- comment (moderation). `body` is plain text; @-mentions are resolved app-side
-- against the consultant list, same as the existing comment fields.

-- -----------------------------------------------------------------------------
-- 1. Table
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS engagement_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id UUID NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  -- Author of the comment. Kept even if the comment is later edited; NULL only
  -- if the authoring profile is removed.
  author_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_engagement_comments_engagement
  ON engagement_comments(engagement_id, created_at DESC);

-- Reuse the shared audit trigger so edits bump updated_at.
DROP TRIGGER IF EXISTS engagement_comments_updated_at ON engagement_comments;
CREATE TRIGGER engagement_comments_updated_at
  BEFORE UPDATE ON engagement_comments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- -----------------------------------------------------------------------------
-- 2. RLS
-- -----------------------------------------------------------------------------

ALTER TABLE engagement_comments ENABLE ROW LEVEL SECURITY;

-- Anyone who can see engagements can read the comments.
DROP POLICY IF EXISTS engagement_comments_select ON engagement_comments;
CREATE POLICY engagement_comments_select ON engagement_comments
  FOR SELECT USING (has_scope('customers'));

-- Scope holders may post, but only as themselves.
DROP POLICY IF EXISTS engagement_comments_insert ON engagement_comments;
CREATE POLICY engagement_comments_insert ON engagement_comments
  FOR INSERT WITH CHECK (has_scope('customers') AND author_id = auth.uid());

-- Only the author may edit their own comment (and it must stay theirs).
DROP POLICY IF EXISTS engagement_comments_update ON engagement_comments;
CREATE POLICY engagement_comments_update ON engagement_comments
  FOR UPDATE USING (author_id = auth.uid())
  WITH CHECK (author_id = auth.uid());

-- The author may delete their own comment; admins may delete any (moderation).
DROP POLICY IF EXISTS engagement_comments_delete ON engagement_comments;
CREATE POLICY engagement_comments_delete ON engagement_comments
  FOR DELETE USING (author_id = auth.uid() OR get_user_role() = 'admin');
