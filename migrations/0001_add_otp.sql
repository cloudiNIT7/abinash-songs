-- Migration: add email OTP verification.
-- Apply with:
--   npx wrangler d1 execute cloud-songs-auth --remote --file migrations/0001_add_otp.sql

ALTER TABLE users ADD COLUMN verified INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS email_otps (
	email        TEXT PRIMARY KEY,
	code_hash    TEXT NOT NULL,
	expires_at   INTEGER NOT NULL,
	attempts     INTEGER NOT NULL DEFAULT 0,
	last_sent_at INTEGER NOT NULL DEFAULT 0
);

-- Accounts that already existed before verification was added are grandfathered
-- in as verified, so nobody gets locked out by the new requirement.
UPDATE users SET verified = 1 WHERE verified = 0;
