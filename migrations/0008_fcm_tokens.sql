-- Native FCM device tokens, so a closed Android app can be woken for a sign-in
-- approval. Separate from push_subscriptions (Web Push): the APK's WebView has
-- no Push API, so it registers an FCM token here instead.
--
-- Applied with:
--   npx wrangler d1 execute cloud-songs-auth --remote --file migrations/0008_fcm_tokens.sql

CREATE TABLE IF NOT EXISTS fcm_tokens (
	token         TEXT PRIMARY KEY,
	user_id       TEXT NOT NULL,
	platform      TEXT,
	user_agent    TEXT,
	created_at    INTEGER NOT NULL,
	last_used_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS fcm_tokens_user_idx ON fcm_tokens (user_id);
