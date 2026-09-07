/**
 * A tiny JSON-over-KV helper used to keep the hot, high-frequency reads and
 * writes off the single D1 database.
 *
 * The read-heavy music API already avoids D1 entirely (see cache.js). The
 * authenticated side is what actually lands on D1 on every request: the session
 * poll from every open tab runs currentUser(), and every login checks the
 * rate-limit table. Under traffic that is thousands of reads/second against one
 * database, which is the bottleneck.
 *
 * KV, unlike D1, is replicated to every colo, so those reads are absorbed at the
 * edge and one database is no longer the ceiling. It is the same store cache.js
 * already prefers - the namespace bound as `CACHE`.
 *
 * Everything here is best-effort and degrades to a no-op when no namespace is
 * bound: callers that use it fall back to D1, so nothing breaks on a project
 * that has not added the binding. It must never throw on the request path.
 */

/** The KV namespace, or null when the project has no `CACHE` binding. */
export function kv(env) {
	try {
		if (env && env.CACHE && typeof env.CACHE.get === "function" && typeof env.CACHE.put === "function") {
			return env.CACHE;
		}
	} catch (e) { /* fall through */ }
	return null;
}

/** True when a KV namespace is available to offload to. */
export function hasKv(env) {
	return kv(env) !== null;
}

/**
 * Read and JSON-parse a key. Returns null on a miss, a parse error, or any KV
 * problem - a cache read must never fail the request that made it.
 *
 * `cacheTtl` lets KV also cache the value in the reading colo for a few seconds,
 * so a burst of polls for the same session collapses onto one origin read.
 */
export async function kvGet(env, key, { cacheTtl = 60 } = {}) {
	const ns = kv(env);
	if (!ns) return null;
	try {
		const raw = await ns.get(key, { type: "text", cacheTtl });
		if (raw === null || raw === undefined) return null;
		return JSON.parse(raw);
	} catch (e) {
		return null;
	}
}

/**
 * Write a JSON value with a required TTL in seconds (KV's floor is 60s, so
 * anything smaller is rounded up). Best-effort: a failed write just means the
 * next read is a miss and falls back to D1.
 */
export async function kvPut(env, key, value, ttlSeconds) {
	const ns = kv(env);
	if (!ns) return false;
	try {
		await ns.put(key, JSON.stringify(value), { expirationTtl: Math.max(60, Math.floor(ttlSeconds || 60)) });
		return true;
	} catch (e) {
		return false;
	}
}

/** Delete a key. Used to invalidate a cached session on logout/revoke. */
export async function kvDelete(env, key) {
	const ns = kv(env);
	if (!ns) return false;
	try {
		await ns.delete(key);
		return true;
	} catch (e) {
		return false;
	}
}

/* ---------- key namespacing ----------
 * The same namespace holds the music response cache, so auth entries are
 * prefixed to keep the two from ever colliding. */

export function sessionKey(sid) { return "auth:sess:" + sid; }
export function throttleKey(key) { return "auth:throttle:" + key; }

/** One pending email OTP per address (stored hashed, same as the D1 row). */
export function otpKey(email) { return "auth:otp:" + email; }

/** A login-approval's status, written through on every state change so the
 *  waiting device's poll can read it from KV instead of D1. */
export function approvalKey(id) { return "auth:appr:" + id; }

/** A per-account marker that says "this account has >=1 pending approval",
 *  so the wait.js long-poll can skip D1 when there is nothing to raise. */
export function userPendingKey(userId) { return "auth:pending:" + userId; }

/** The list of push endpoints for an account, cached so a login's "wake my
 *  other devices" does not read D1 first. */
export function pushListKey(userId) { return "auth:push:" + userId; }

/** The list of native FCM device tokens for an account. */
export function fcmListKey(userId) { return "auth:fcm:" + userId; }

/** The most recent "listen to this" nudge, so a browser's service worker can
 *  read what to show after a content-free Web Push tickle. */
export function suggestKey(userId) { return "auth:suggest:" + userId; }
