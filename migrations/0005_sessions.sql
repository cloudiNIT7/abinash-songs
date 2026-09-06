-- Migration: remember every sign-in so an account can see (and end) the
-- devices it is logged in on. Sessions used to be purely stateless signed
-- cookies, which left nothing to list or revoke.
-- Apply with:
--   npx wrangler d1 execute cloud-songs-auth --remote --file migrations/0005_sessions.sql

CREATE TABLE IF NOT EXISTS sessions (
	id            TEXT PRIMARY KEY,       -- random session id, also inside the cookie
	user_id       TEXT NOT NULL,
	created_at    INTEGER NOT NULL,       -- unix seconds
	last_seen_at  INTEGER NOT NULL,
	expires_at    INTEGER NOT NULL,
	revoked_at    INTEGER NOT NULL DEFAULT 0,
	device        TEXT,                   -- Computer / Phone / Tablet
	os            TEXT,
	browser       TEXT,
	ip            TEXT,
	location      TEXT,                   -- city, country from Cloudflare geo
	user_agent    TEXT
);

CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id, last_seen_at);
