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
	created_at      TEXT NOT NULL,
	updated_at      TEXT NOT NULL
);

-- Emails are stored lower-cased, so a plain unique index is enough.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users (email);

-- Throttles password guessing per email+IP. Rows are disposable.
CREATE TABLE IF NOT EXISTS login_attempts (
	key         TEXT PRIMARY KEY,
	attempts    INTEGER NOT NULL DEFAULT 0,
	first_at    INTEGER NOT NULL,
	locked_until INTEGER NOT NULL DEFAULT 0
);
