-- =====================================================
-- Migration 00073: Notifications (engagement @-mentions)
-- =====================================================
-- Backs the header notification bell. The first (and currently only) source is
-- an @-mention in an engagement comment: when a consultant types "@Name" in a
-- Bokslut uppdrag comment, the mentioned person gets a notification.
--
-- Notifications are private to the recipient (own-row RLS). Inserts are NOT
-- allowed directly from the client — the actor is creating a row for *someone
-- else*, so we expose a SECURITY DEFINER function that is gated by
-- has_scope('customers') and only ever creates 'engagement_mention' rows.
-- Display fields (actor_name, customer_name) are denormalized at creation time
-- so the bell needs no joins.

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  actor_name TEXT,
  type TEXT NOT NULL CHECK (type IN ('engagement_mention')),
  engagement_id UUID REFERENCES engagements(id) ON DELETE CASCADE,
  customer_name TEXT,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_recipient
  ON notifications(recipient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread
  ON notifications(recipient_id) WHERE read_at IS NULL;

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- Recipients see, update (mark read), and delete only their own notifications.
DROP POLICY IF EXISTS notifications_select_own ON notifications;
CREATE POLICY notifications_select_own ON notifications
  FOR SELECT USING (recipient_id = auth.uid());

DROP POLICY IF EXISTS notifications_update_own ON notifications;
CREATE POLICY notifications_update_own ON notifications
  FOR UPDATE USING (recipient_id = auth.uid())
  WITH CHECK (recipient_id = auth.uid());

DROP POLICY IF EXISTS notifications_delete_own ON notifications;
CREATE POLICY notifications_delete_own ON notifications
  FOR DELETE USING (recipient_id = auth.uid());

-- No INSERT policy: rows are created exclusively via the function below.

-- -----------------------------------------------------------------------------
-- Mention notification creator
-- -----------------------------------------------------------------------------
-- Called by the client after saving an engagement comment with new mentions.
-- SECURITY DEFINER so it can write rows for other users; gated by scope so only
-- consultants can trigger it. Skips self-mentions and unknown recipients.

CREATE OR REPLACE FUNCTION create_engagement_mention_notifications(
  p_engagement_id UUID,
  p_recipient_ids UUID[]
)
RETURNS INTEGER AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_actor_name TEXT;
  v_customer_name TEXT;
  v_recipient UUID;
  v_count INTEGER := 0;
BEGIN
  IF NOT has_scope('customers') THEN
    RAISE EXCEPTION 'insufficient_privilege';
  END IF;

  SELECT c.name INTO v_customer_name
  FROM engagements e
  JOIN customers c ON c.id = e.customer_id
  WHERE e.id = p_engagement_id;

  IF v_customer_name IS NULL THEN
    RAISE EXCEPTION 'engagement_not_found';
  END IF;

  SELECT full_name INTO v_actor_name FROM profiles WHERE id = v_actor;

  FOREACH v_recipient IN ARRAY p_recipient_ids LOOP
    CONTINUE WHEN v_recipient IS NULL OR v_recipient = v_actor;
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_recipient);

    INSERT INTO notifications
      (recipient_id, actor_id, actor_name, type, engagement_id, customer_name)
      VALUES
      (v_recipient, v_actor, v_actor_name, 'engagement_mention', p_engagement_id, v_customer_name);
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION create_engagement_mention_notifications(UUID, UUID[]) FROM public;
GRANT EXECUTE ON FUNCTION create_engagement_mention_notifications(UUID, UUID[]) TO authenticated;
