-- =====================================================================
-- Migration 00104: Assign a customer manager to a lead (+ notify them)
-- =====================================================================
-- Adds a single "customer manager" (owner) to a website/manual lead, and wires
-- the assignment into the existing header notification bell (migration 00073).
--
-- Design (deliberately additive — never rewrites existing rows):
--   • website_leads.customer_manager_id: one nullable owner per lead. NULL =
--     unassigned. ON DELETE SET NULL so removing a profile just clears the link.
--   • notifications gains a new source type 'lead_assignment' and a nullable
--     lead_id, so a notification can point at either an engagement or a lead.
--     The bell already denormalizes display text into customer_name, which we
--     reuse to carry the lead's company/name (no bell join needed).
--   • Rows are still created only via a SECURITY DEFINER function (the actor is
--     writing a row for someone else). Gated on the actor being a known profile
--     — leads are visible/updatable by any authenticated staff member, so no
--     extra scope is required beyond that.

-- ---------------------------------------------------------------------
-- 1. Lead owner column
-- ---------------------------------------------------------------------
ALTER TABLE website_leads
  ADD COLUMN IF NOT EXISTS customer_manager_id UUID
    REFERENCES profiles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_website_leads_customer_manager
  ON website_leads(customer_manager_id) WHERE customer_manager_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- 2. Extend notifications for the new source
-- ---------------------------------------------------------------------
-- Relax the single-value CHECK to also allow 'lead_assignment'.
ALTER TABLE notifications
  DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_check
    CHECK (type IN ('engagement_mention', 'lead_assignment'));

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS lead_id UUID
    REFERENCES website_leads(id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------
-- 3. Lead-assignment notification creator
-- ---------------------------------------------------------------------
-- Called by the client after assigning a customer manager to a lead. SECURITY
-- DEFINER so it can write a row for the assignee; the CHECK/RLS on notifications
-- otherwise blocks direct client inserts. Skips self-assignment and unknown
-- recipients. Denormalizes actor_name + the lead's display name (company, else
-- contact name) into customer_name so the bell needs no joins.
CREATE OR REPLACE FUNCTION create_lead_assignment_notification(
  p_lead_id UUID,
  p_recipient_id UUID
)
RETURNS INTEGER AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_actor_name TEXT;
  v_lead_name TEXT;
BEGIN
  -- Only known staff profiles may trigger this.
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor) THEN
    RAISE EXCEPTION 'insufficient_privilege';
  END IF;

  -- Nothing to do when unassigning, self-assigning, or targeting a non-profile.
  IF p_recipient_id IS NULL OR p_recipient_id = v_actor THEN
    RETURN 0;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_recipient_id) THEN
    RETURN 0;
  END IF;

  SELECT COALESCE(NULLIF(TRIM(company), ''), name) INTO v_lead_name
  FROM website_leads WHERE id = p_lead_id;

  IF v_lead_name IS NULL THEN
    RAISE EXCEPTION 'lead_not_found';
  END IF;

  SELECT full_name INTO v_actor_name FROM profiles WHERE id = v_actor;

  INSERT INTO notifications
    (recipient_id, actor_id, actor_name, type, lead_id, customer_name)
    VALUES
    (p_recipient_id, v_actor, v_actor_name, 'lead_assignment', p_lead_id, v_lead_name);

  RETURN 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION create_lead_assignment_notification(UUID, UUID) FROM public;
GRANT EXECUTE ON FUNCTION create_lead_assignment_notification(UUID, UUID) TO authenticated;
