-- Migration: approve or deny a new sign-in from a device that is already
-- signed in. A correct password is no longer enough on its own once the
-- account has an active session somewhere.
-- Apply with:
--   npx wrangler d1 execute cloud-songs-auth --remote --file migrations/0006_login_approvals.sql

CREATE TABLE IF NOT EXISTS login_approvals (
	id            TEXT PRIMARY KEY,      -- random id, the waiting device's claim token
	user_id       TEXT NOT NULL,
	-- pending -> approved | denied, and approved -> claimed once the waiting
	-- device has exchanged it for a session. Single use.
	status        TEXT NOT NULL DEFAULT 'pending',
	created_at    INTEGER NOT NULL,      -- unix seconds
	expires_at    INTEGER NOT NULL,
	decided_at    INTEGER NOT NULL DEFAULT 0,
	decided_by    TEXT,                  -- session id that answered
	device        TEXT,                   -- Computer / Phone / Tablet
	os            TEXT,
	browser       TEXT,
	ip            TEXT,
	location      TEXT,                   -- city, country from Cloudflare geo
	user_agent    TEXT
);

CREATE INDEX IF NOT EXISTS login_approvals_user_idx
	ON login_approvals (user_id, status, expires_at);
