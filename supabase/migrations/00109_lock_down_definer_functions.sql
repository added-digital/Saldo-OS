-- =====================================================
-- Migration 00109: Lock down SECURITY DEFINER functions
-- =====================================================
-- SECURITY FIX. Two SECURITY DEFINER functions owned by `postgres` were
-- executable by the `anon` role. The anon key ships in every browser bundle, so
-- "anon can execute" means "anyone on the internet can execute":
--
--   • run_generated_sql(text) — runs an arbitrary SELECT as the function owner,
--     which bypasses RLS entirely. Verified from outside the app with nothing
--     but the public anon key: customers, invoices, profiles, auth.users and
--     auth.refresh_tokens were all readable. Session tokens and the stored
--     Fortnox OAuth credentials sat inside that reach.
--   • process_sync_queue() — kicks off sync orchestration, so an anonymous
--     caller could drive Fortnox traffic and job churn at will.
--
-- Why the original grants didn't hold: 00024/00025 did
--   REVOKE ALL ... FROM PUBLIC;  GRANT EXECUTE ... TO service_role;
-- but Supabase ships ALTER DEFAULT PRIVILEGES granting EXECUTE on new public
-- functions to `anon` and `authenticated`. Revoking from PUBLIC does not touch
-- a grant held by a named role, so those two grants survived unnoticed.
--
-- Both functions are only ever called server-side with the service key
-- (/api/questions/ask-sql, /api/chat, the sync Edge Functions), so removing the
-- client-side grants changes nothing about how the app works.

REVOKE EXECUTE ON FUNCTION public.run_generated_sql(text) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.run_generated_sql(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.run_generated_sql(text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.process_sync_queue() FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.process_sync_queue() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.process_sync_queue() TO service_role;

-- sync_customer_total_hours is called by the sync-time-reports Edge Function,
-- which holds the service key; sync_customer_financial_year_from_sie likewise
-- runs server-side. Neither has any business being reachable from a browser.
REVOKE EXECUTE ON FUNCTION public.sync_customer_total_hours() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_customer_total_hours() TO service_role;

REVOKE EXECUTE ON FUNCTION public.sync_customer_financial_year_from_sie() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_customer_financial_year_from_sie() TO service_role;

-- Verification (expect f | f for every row):
--   SELECT p.proname,
--          has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
--          has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public'
--     AND p.proname IN ('run_generated_sql','process_sync_queue',
--                       'sync_customer_total_hours','sync_customer_financial_year_from_sie');
