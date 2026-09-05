-- Migration: profile picture + user-created playlists.
-- Apply with:
--   npx wrangler d1 execute cloud-songs-auth --remote --file migrations/0003_playlists.sql

-- Small, client-resized avatar stored as a data URL on the account.
ALTER TABLE users ADD COLUMN avatar_url TEXT;

CREATE TABLE IF NOT EXISTS playlists (
	id         TEXT PRIMARY KEY,
	user_id    TEXT NOT NULL,
	name       TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pl_user ON playlists (user_id, created_at);

CREATE TABLE IF NOT EXISTS playlist_tracks (
	playlist_id TEXT NOT NULL,
	track_id    TEXT NOT NULL,
	track_json  TEXT NOT NULL,
	added_at    INTEGER NOT NULL,
	PRIMARY KEY (playlist_id, track_id)
);
CREATE INDEX IF NOT EXISTS pt_pl ON playlist_tracks (playlist_id, added_at);
