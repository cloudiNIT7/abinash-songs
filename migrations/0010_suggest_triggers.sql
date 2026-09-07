-- Weather- and event-triggered nudges.
--
-- Until now the weather only coloured the wording of a scheduled nudge. These
-- columns let the sender notice a *change* (it started raining) and a calendar
-- occasion (New Year, Valentine's, Diwali...) and send off the back of it,
-- rather than only when the clock says so.
--
--   last_weather  the condition bucket last seen for this account, so a change
--                 can be detected: clear -> rain is worth a message, rain ->
--                 rain is not.
--   event_day     the YYYY-MM-DD of the last event nudge, so an occasion is
--                 mentioned once and not on every check that day.
--
-- Applied with:
--   npx wrangler d1 execute cloud-songs-auth --remote --file migrations/0010_suggest_triggers.sql

ALTER TABLE suggest_state ADD COLUMN last_weather TEXT;
ALTER TABLE suggest_state ADD COLUMN event_day TEXT;
