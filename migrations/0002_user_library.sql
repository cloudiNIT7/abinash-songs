-- Migration: per-account library (history, play counts, likes, searches).
-- Apply with:
--   npx wrangler d1 execute cloud-songs-auth --remote --file migrations/0002_user_library.sql

-- One row per (user, track): covers recently-played (last_played_at),
-- most-played (play_count) and likes (liked/liked_at) in a single table.
CREATE TABLE IF NOT EXISTS user_tracks (
	user_id        TEXT NOT NULL,
	track_id       TEXT NOT NULL,
	track_json     TEXT NOT NULL,
	play_count     INTEGER NOT NULL DEFAULT 0,
	last_played_at INTEGER,
	liked          INTEGER NOT NULL DEFAULT 0,
	liked_at       INTEGER,
	PRIMARY KEY (user_id, track_id)
);
CREATE INDEX IF NOT EXISTS ut_recent ON user_tracks (user_id, last_played_at);
CREATE INDEX IF NOT EXISTS ut_top    ON user_tracks (user_id, play_count);
CREATE INDEX IF NOT EXISTS ut_liked  ON user_tracks (user_id, liked, liked_at);

-- Recent search terms per user (one row per distinct term).
CREATE TABLE IF NOT EXISTS user_searches (
	user_id TEXT NOT NULL,
	term    TEXT NOT NULL,
	at      INTEGER NOT NULL,
	PRIMARY KEY (user_id, term)
);
CREATE INDEX IF NOT EXISTS us_at ON user_searches (user_id, at);
