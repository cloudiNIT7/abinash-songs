-- Cloud Songs accounts. Applied with:
--   npx wrangler d1 execute cloud-songs-auth --remote --file schema.sql

CREATE TABLE IF NOT EXISTS users (
	id              TEXT PRIMARY KEY,
	email           TEXT NOT NULL,
	username        TEXT NOT NULL,
	display_name    TEXT,
	bio             TEXT,
	avatar_color    TEXT,
	-- PBKDF2-SHA256; the salt and iteration count travel with the hash so the
	-- cost can be raised later without invalidating existing accounts.
	password_hash   TEXT NOT NULL,
	password_salt   TEXT NOT NULL,
	iterations      INTEGER NOT NULL,
	profile_complete INTEGER NOT NULL DEFAULT 0,
	-- 0 until the signup email OTP is confirmed.
	verified        INTEGER NOT NULL DEFAULT 0,
	created_at      TEXT NOT NULL,
	updated_at      TEXT NOT NULL
);

-- Emails are stored lower-cased, so a plain unique index is enough.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users (email);

-- One pending signup/login code per email. Codes are stored hashed.
CREATE TABLE IF NOT EXISTS email_otps (
	email       TEXT PRIMARY KEY,
	code_hash   TEXT NOT NULL,
	expires_at  INTEGER NOT NULL,
	attempts    INTEGER NOT NULL DEFAULT 0,
	last_sent_at INTEGER NOT NULL DEFAULT 0
);

-- One row per sign-in, so an account can list the devices it is logged in on
-- and end any of them. The session id also travels inside the signed cookie.
CREATE TABLE IF NOT EXISTS sessions (
	id            TEXT PRIMARY KEY,
	user_id       TEXT NOT NULL,
	created_at    INTEGER NOT NULL,
	last_seen_at  INTEGER NOT NULL,
	expires_at    INTEGER NOT NULL,
	revoked_at    INTEGER NOT NULL DEFAULT 0,
	device        TEXT,
	os            TEXT,
	browser       TEXT,
	ip            TEXT,
	location      TEXT,
	user_agent    TEXT
);

CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id, last_seen_at);

-- Throttles password guessing per email+IP. Rows are disposable.
CREATE TABLE IF NOT EXISTS login_attempts (
	key         TEXT PRIMARY KEY,
	attempts    INTEGER NOT NULL DEFAULT 0,
	first_at    INTEGER NOT NULL,
	locked_until INTEGER NOT NULL DEFAULT 0
);
