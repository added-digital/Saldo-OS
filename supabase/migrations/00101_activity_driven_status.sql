-- Activity-driven lead status. The status dropdown is gone from the UI; the
-- activity log is the single source of truth. Outcome actions (won, lost,
-- archived, spam) become loggable activity types, and the app derives
-- website_leads.status from what gets logged:
--
--   called / emailed / meeting_booked  -> contacted   (only from 'new')
--   offer_sent                         -> offer_sent  (from 'new'/'contacted')
--   won / lost / archived / spam       -> that status  (always)
--   follow_up / note                   -> no status change
--
-- Status never moves backwards automatically. 'status_change' stays valid so
-- historical rows keep rendering, but the app no longer creates them.

ALTER TABLE lead_activities
  DROP CONSTRAINT IF EXISTS lead_activities_activity_type_check;
ALTER TABLE lead_activities
  ADD CONSTRAINT lead_activities_activity_type_check
  CHECK (activity_type IN (
    'called',
    'emailed',
    'meeting_booked',
    'offer_sent',
    'follow_up',
    'note',
    'status_change',
    'won',
    'lost',
    'archived',
    'spam'
  ));
