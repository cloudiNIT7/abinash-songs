-- Native APNs device tokens, so a closed iOS app can be woken for a sign-in
-- approval and can be sent listening suggestions. The iOS counterpart of
-- 0008_fcm_tokens.sql: a WKWebView has no Push API either, so the app registers
-- its APNs token here and functions/_lib/apns.js pushes to it directly.
--
-- `env` records which APNs host the token belongs to ('sandbox' for a build run
-- from Xcode, 'production' for TestFlight / the App Store). The sender falls
-- back to the other host if Apple rejects the token, so a wrong value is
-- recoverable rather than fatal.
--
-- Applied with:
--   npx wrangler d1 execute cloud-songs-auth --remote --file migrations/0009_apns_tokens.sql

CREATE TABLE IF NOT EXISTS apns_tokens (
	token         TEXT PRIMARY KEY,
	user_id       TEXT NOT NULL,
	env           TEXT NOT NULL DEFAULT 'production',
	platform      TEXT,
	user_agent    TEXT,
	created_at    INTEGER NOT NULL,
	last_used_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS apns_tokens_user_idx ON apns_tokens (user_id);
