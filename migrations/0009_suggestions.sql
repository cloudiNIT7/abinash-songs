-- "Listen to this" suggestion notifications.
--
-- Per-account state for the nudges the cron sender pushes out: when we last
-- sent one (so we can rate-limit), and whether the account has turned them off.
-- Kept in its own table so `users` is untouched.
--
-- Applied with:
--   npx wrangler d1 execute cloud-songs-auth --remote --file migrations/0009_suggestions.sql

CREATE TABLE IF NOT EXISTS suggest_state (
	user_id     TEXT PRIMARY KEY,
	last_at     INTEGER NOT NULL DEFAULT 0,   -- unix seconds of the last nudge
	sent_today  INTEGER NOT NULL DEFAULT 0,   -- counter, reset when the day rolls over
	day         TEXT,                          -- YYYY-MM-DD the counter belongs to
	optout      INTEGER NOT NULL DEFAULT 0,   -- 1 = never send suggestions
	last_song   TEXT                           -- avoid suggesting the same thing twice
);

-- Where the device is, so a suggestion can mention the weather. Cloudflare gives
-- these on every request (request.cf); they are recorded when a session is
-- created. Nullable: an older session simply gets no weather flavour.
ALTER TABLE sessions ADD COLUMN lat REAL;
ALTER TABLE sessions ADD COLUMN lon REAL;
ALTER TABLE sessions ADD COLUMN tz TEXT;
