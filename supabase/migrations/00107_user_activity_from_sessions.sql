-- =====================================================
-- Migration 00107: Real user activity from auth.sessions
-- =====================================================
-- Settings > Usage counted "active users" from auth.users.last_sign_in_at.
-- That column only moves on a genuine authentication — the whole OAuth round
-- trip to Azure. Our middleware refreshes the session silently on every page
-- load, and a refresh does not touch last_sign_in_at, so someone can work in
-- the app daily for two months while the field sits still. The page was
-- therefore reporting "who was forced to log in again recently", not usage:
-- measured against auth.sessions it under-counted the last 7 days by ~5x.
--
-- auth.sessions.updated_at DOES move as a session is used, so the recency we
-- want is already recorded — no new event tracking, and the history is there
-- from day one. A session row disappears on sign-out or expiry, so this
-- measures activity within a session's lifetime, which is exactly what
-- DAU/WAU/MAU mean.
--
-- auth.* is not exposed through the API, so this SECURITY DEFINER function is
-- the seam. It returns one row per user and nothing else — no tokens, no IPs,
-- no session ids — and EXECUTE is granted to service_role only, so it is
-- reachable exclusively from server-side code holding the service key
-- (/api/usage/summary, which independently verifies the caller is an admin).

CREATE OR REPLACE FUNCTION public.admin_user_activity()
RETURNS TABLE (
  user_id UUID,
  last_active_at TIMESTAMPTZ,
  active_sessions INTEGER
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    s.user_id,
    max(s.updated_at) AS last_active_at,
    count(*)::INTEGER AS active_sessions
  FROM auth.sessions s
  GROUP BY s.user_id;
$$;

REVOKE ALL ON FUNCTION public.admin_user_activity() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_user_activity() FROM authenticated;
REVOKE ALL ON FUNCTION public.admin_user_activity() FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_user_activity() TO service_role;

COMMENT ON FUNCTION public.admin_user_activity() IS
  'Per-user session recency for the admin Usage page. Service-role only; the calling route gates on profile role = admin.';
