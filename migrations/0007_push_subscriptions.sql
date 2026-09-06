-- Migration: remember where to push, so a phone can be told about a sign-in
-- request even when the app is closed.
-- Apply with:
--   npx wrangler d1 execute cloud-songs-auth --remote --file migrations/0007_push_subscriptions.sql

CREATE TABLE IF NOT EXISTS push_subscriptions (
	endpoint      TEXT PRIMARY KEY,      -- the browser's own push endpoint
	user_id       TEXT NOT NULL,
	-- Kept for a future encrypted payload; the current pushes carry no body, so
	-- they are not used yet.
	p256dh        TEXT,
	auth          TEXT,
	user_agent    TEXT,
	created_at    INTEGER NOT NULL,
	last_used_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions (user_id);
