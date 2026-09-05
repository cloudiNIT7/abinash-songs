-- Migration: store the user's preferred language on their account.
-- Apply with:
--   npx wrangler d1 execute cloud-songs-auth --remote --file migrations/0004_pref_lang.sql

ALTER TABLE users ADD COLUMN pref_lang TEXT;
