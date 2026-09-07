/**
 * Server-side accounts for Cloud Songs.
 *
 * Passwords are hashed with PBKDF2-SHA256 in D1; the browser gets nothing but
 * an HttpOnly, signed session cookie. This replaces the old localStorage
 * "auth", which anyone could forge from devtools.
 *
 * Bindings expected on the Pages project:
 *   DB             - D1 database (schema.sql)
 *   SESSION_SECRET - secret used to sign session cookies
 */

const COOKIE = "cs_session";
const SESSION_DAYS = 30;
/**
 * PBKDF2 cost. OWASP suggests 210k iterations for SHA-256, but that measures
 * ~26 ms of CPU and the Workers Free plan allows 10 ms per invocation, so
 * signup/login would be killed mid-hash. 25k measures ~3 ms and leaves room
 * for the rest of the request.
 *
 * The count is stored per account, so raising it later (for example on the
 * Workers Paid plan, where the budget is 30 s) does not invalidate existing
 * passwords - old rows keep verifying with the value they were written with.
 */
const PBKDF2_ITERATIONS = 25000;
const MAX_ATTEMPTS = 8;             // per email+IP before a lockout
const LOCK_SECONDS = 15 * 60;
const ATTEMPT_WINDOW = 15 * 60;

/* ---------- encoding helpers ---------- */

const enc = new TextEncoder();

/* KV offloading: session lookups and rate limiting are cached in the globally
 * replicated `CACHE` namespace so the single D1 database is not hit on every
 * poll and every login. All of it degrades to D1 when no namespace is bound. */
import { kvGet, kvPut, kvDelete, sessionKey, throttleKey, otpKey, approvalKey, userPendingKey, hasKv } from "./kvstore.js";

const SESSION_CACHE_TTL = 60;          // seconds a resolved session is trusted from KV

function toHex(buffer) {
	return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function b64urlEncode(bytes) {
	let s = "";
	for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(text) {
	const padded = text.replace(/-/g, "+").replace(/_/g, "/");
	const raw = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
	return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
}

export function randomHex(bytes = 16) {
	return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Constant-time string compare, so a wrong signature leaks no timing signal. */
function safeEqual(a, b) {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/* ---------- passwords ---------- */

export async function hashPassword(password, salt, iterations = PBKDF2_ITERATIONS) {
	const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
	const bits = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations },
		key,
		256,
	);
	return toHex(bits);
}

export async function verifyPassword(password, user) {
	const hash = await hashPassword(password, user.password_salt, user.iterations);
	return safeEqual(hash, user.password_hash);
}

/* ---------- session cookie ---------- */

async function hmac(secret, message) {
	const key = await crypto.subtle.importKey(
		"raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
	);
	return crypto.subtle.sign("HMAC", key, enc.encode(message));
}

export async function createSessionCookie(env, userId, request = null) {
	const sid = randomHex(16);
	const now = Math.floor(Date.now() / 1000);
	const exp = now + SESSION_DAYS * 86400;

	// Remember the sign-in so /api/me/devices can list it and end it later.
	// A failure here (table not migrated yet, D1 hiccup) must not block a
	// sign-in: the cookie still works, it just won't show up in the list.
	if (request) {
		try {
			const d = describeClient(request);
			await env.DB.prepare(
				`INSERT INTO sessions
				   (id, user_id, created_at, last_seen_at, expires_at, revoked_at,
				    device, os, browser, ip, location, user_agent, lat, lon, tz)
				 VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).bind(sid, userId, now, now, exp, d.device, d.os, d.browser, d.ip, d.location, d.user_agent,
				d.lat, d.lon, d.tz).run();
		} catch (e) {
			// The lat/lon/tz columns may not be migrated yet: fall back to the
			// original shape so a sign-in is never blocked by this.
			try {
				const d = describeClient(request);
				await env.DB.prepare(
					`INSERT INTO sessions
					   (id, user_id, created_at, last_seen_at, expires_at, revoked_at,
					    device, os, browser, ip, location, user_agent)
					 VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
				).bind(sid, userId, now, now, exp, d.device, d.os, d.browser, d.ip, d.location, d.user_agent).run();
			} catch (e2) { /* non-fatal */ }
		}
	}

	const payload = b64urlEncode(enc.encode(JSON.stringify({
		uid: userId,
		sid,
		exp,
	})));
	const sig = b64urlEncode(await hmac(sessionSecret(env), payload));
	const value = `${payload}.${sig}`;
	return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}

/* ---------- devices / active sessions ---------- */

/** Best-effort description of the client behind a request, for the device list. */
export function describeClient(request) {
	const ua = request.headers.get("User-Agent") || "";
	const cf = request.cf || {};
	return {
		device: deviceKind(ua),
		os: osName(ua),
		browser: browserName(ua),
		ip: request.headers.get("CF-Connecting-IP") || "",
		location: [cf.city, cf.region, cf.country].filter(Boolean).join(", "),
		user_agent: ua.slice(0, 300),
		// Kept so a "listen to this" nudge can mention the local weather and be
		// sent at a sensible local hour. Cloudflare supplies all three.
		lat: cf.latitude ? Number(cf.latitude) : null,
		lon: cf.longitude ? Number(cf.longitude) : null,
		tz: cf.timezone || "",
	};
}

function deviceKind(ua) {
	if (/\bTablet\b|iPad/i.test(ua)) return "Tablet";
	if (/Mobi|Android|iPhone|iPod|Windows Phone/i.test(ua)) return "Phone";
	if (/SmartTV|AppleTV|Web0S|Tizen/i.test(ua)) return "TV";
	return "Computer";
}

function osName(ua) {
	if (/Windows NT 10/i.test(ua)) return "Windows";
	if (/Windows/i.test(ua)) return "Windows";
	if (/Android/i.test(ua)) return "Android";
	if (/iPhone|iPad|iPod/i.test(ua)) return "iOS";
	if (/Mac OS X/i.test(ua)) return "macOS";
	if (/CrOS/i.test(ua)) return "ChromeOS";
	if (/Linux/i.test(ua)) return "Linux";
	return "Unknown OS";
}

function browserName(ua) {
	// Order matters: most Chromium browsers also claim "Chrome"/"Safari".
	if (/Edg\//i.test(ua)) return "Edge";
	if (/OPR\/|Opera/i.test(ua)) return "Opera";
	if (/SamsungBrowser/i.test(ua)) return "Samsung Internet";
	if (/Firefox\//i.test(ua)) return "Firefox";
	if (/Chrome\//i.test(ua)) return "Chrome";
	if (/Safari\//i.test(ua)) return "Safari";
	if (/wget|curl|python|node/i.test(ua)) return "Script";
	return "Browser";
}

/** Active (non-revoked, unexpired) sessions for an account, newest activity first. */
export async function listSessions(env, userId) {
	const now = Math.floor(Date.now() / 1000);
	const res = await env.DB.prepare(
		`SELECT id, created_at, last_seen_at, device, os, browser, ip, location
		   FROM sessions
		  WHERE user_id = ? AND revoked_at = 0 AND expires_at > ?
		  ORDER BY last_seen_at DESC
		  LIMIT 50`,
	).bind(userId, now).all();
	return (res && res.results) || [];
}

/** Ends one session. Scoped by user_id so nobody can revoke someone else's. */
export async function revokeSession(env, sessionId, userId) {
	const now = Math.floor(Date.now() / 1000);
	const res = await env.DB.prepare(
		"UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at = 0",
	).bind(now, sessionId, userId).run();
	// Drop the cached session so it stops validating immediately, not just when
	// the short KV TTL lapses. Best-effort; the TTL is the backstop.
	await kvDelete(env, sessionKey(sessionId));
	return !!(res && res.meta && res.meta.changes);
}

/** Ends every session except the one making the request. */
export async function revokeOtherSessions(env, userId, keepSessionId) {
	const now = Math.floor(Date.now() / 1000);
	const res = await env.DB.prepare(
		"UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at = 0 AND id <> ?",
	).bind(now, userId, keepSessionId || "").run();
	return (res && res.meta && res.meta.changes) || 0;
}

/** Housekeeping: drop rows that can never be shown again. */
export async function pruneSessions(env, userId) {
	const now = Math.floor(Date.now() / 1000);
	try {
		await env.DB.prepare(
			"DELETE FROM sessions WHERE user_id = ? AND (expires_at < ? OR (revoked_at > 0 AND revoked_at < ?))",
		).bind(userId, now, now - 7 * 86400).run();
	} catch (e) { /* non-fatal */ }
}

export function clearSessionCookie() {
	return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/* ---------- password-reset token ----------
 * A short-lived signed token handed to the client after it proves email
 * ownership (via the emailed code). It authorises exactly one password change.
 * The "reset." prefix domain-separates it from session cookies, so neither can
 * be used in place of the other. */
const RESET_TTL_SECONDS = 15 * 60;

export async function createResetToken(env, email, bind) {
	const payload = b64urlEncode(enc.encode(JSON.stringify({
		email,
		p: "reset",
		b: bind || "",                         // binds the token to the current password
		exp: Math.floor(Date.now() / 1000) + RESET_TTL_SECONDS,
	})));
	const sig = b64urlEncode(await hmac(sessionSecret(env), "reset." + payload));
	return `${payload}.${sig}`;
}

/** Returns { email, bind } for a valid token, or null. */
export async function verifyResetToken(env, token) {
	if (!token || !token.includes(".")) return null;
	const [payload, sig] = token.split(".");
	let expected;
	try {
		expected = b64urlEncode(await hmac(sessionSecret(env), "reset." + payload));
	} catch (e) {
		return null;
	}
	if (!safeEqual(sig, expected)) return null;
	let claims;
	try {
		claims = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
	} catch (e) {
		return null;
	}
	if (!claims || claims.p !== "reset" || !claims.email || !claims.exp ||
		claims.exp < Math.floor(Date.now() / 1000)) {
		return null;
	}
	return { email: claims.email, bind: claims.b || "" };
}

function sessionSecret(env) {
	const secret = env.SESSION_SECRET;
	if (!secret) throw new Error("SESSION_SECRET is not configured on this project.");
	return secret;
}

function readCookie(request, name) {
	const header = request.headers.get("Cookie") || "";
	for (const part of header.split(";")) {
		const [k, ...rest] = part.trim().split("=");
		if (k === name) return rest.join("=");
	}
	return null;
}

const USER_COLUMNS =
	"id, email, username, display_name, bio, avatar_color, avatar_url, pref_lang, profile_complete, created_at";

/** Returns the signed-in user row, or null. Never throws on a bad cookie.
 *  The row carries `session_id` (the cookie's session), used by the devices UI.
 *
 *  `waitUntil` is optional: when a caller passes Pages' own waitUntil, the
 *  "last active" write is moved off the response path, which matters once the
 *  session poll from every open tab is landing here.
 */
export async function currentUser(request, env, waitUntil) {
	const raw = readCookie(request, COOKIE);
	if (!raw || !raw.includes(".")) return null;

	const [payload, sig] = raw.split(".");
	let expected;
	try {
		expected = b64urlEncode(await hmac(sessionSecret(env), payload));
	} catch (e) {
		return null;
	}
	if (!safeEqual(sig, expected)) return null;

	let claims;
	try {
		claims = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
	} catch (e) {
		return null;
	}
	const now = Math.floor(Date.now() / 1000);
	if (!claims || !claims.uid || !claims.exp || claims.exp < now) return null;

	let row = null;

	// Fast path: a recently-resolved session is cached in KV, which is
	// replicated to every colo. The session poll from every open tab lands
	// here, so serving it from KV instead of D1 is what keeps one database from
	// being the ceiling under traffic. The cache is short-lived (SESSION_CACHE_TTL)
	// and is deleted outright on logout/revoke, so a signed-out session cannot
	// keep working past that window.
	if (claims.sid) {
		const cached = await kvGet(env, sessionKey(claims.sid), { cacheTtl: SESSION_CACHE_TTL });
		if (cached && cached.uid === claims.uid && cached.exp && cached.exp > now) {
			// A cached row means "known good session, here is its user". D1 is
			// untouched on this request.
			cached.user.session_id = claims.sid;
			return cached.user;
		}
	}

	// One round trip for the account and its session. This is the hot path -
	// every authenticated request and every session poll runs it - so it is
	// deliberately a single query rather than two.
	if (claims.sid) {
		try {
			row = await env.DB.prepare(
				`SELECT ${USER_COLUMNS.split(", ").map((c) => "u." + c).join(", ")},
				        s.revoked_at AS s_revoked, s.expires_at AS s_expires, s.last_seen_at AS s_seen
				   FROM users u
				   LEFT JOIN sessions s ON s.id = ? AND s.user_id = u.id
				  WHERE u.id = ?`,
			).bind(claims.sid, claims.uid).first();
		} catch (e) {
			row = null;                     // sessions table missing: fall back below
		}

		// s_revoked is null when no session row exists, which is a cookie issued
		// before device tracking: still valid, just not listable or revocable.
		if (row && row.s_revoked !== null && row.s_revoked !== undefined) {
			if (row.s_revoked > 0 || row.s_expires < now) return null;
			// Keep "last active" fresh without a write on every single request.
			if (now - row.s_seen > 300) {
				const touch = env.DB.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?")
					.bind(now, claims.sid).run().catch(() => {});
				if (waitUntil) waitUntil(touch); else await touch;
			}
		}
	}

	if (!row) {
		row = await env.DB.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`)
			.bind(claims.uid).first();
	}

	if (row) {
		delete row.s_revoked;
		delete row.s_expires;
		delete row.s_seen;
		row.session_id = claims.sid || "";

		// Warm the KV cache so the next poll for this session skips D1. Only a
		// session-backed row is cached (we need a sid to key it and to be able
		// to invalidate it); the TTL never outlives the cookie's own expiry.
		if (claims.sid && hasKv(env)) {
			const ttl = Math.min(SESSION_CACHE_TTL, Math.max(0, claims.exp - now));
			if (ttl > 0) {
				// Cache a copy without the per-request session_id field.
				const { session_id, ...userForCache } = row;
				const write = kvPut(env, sessionKey(claims.sid),
					{ uid: claims.uid, exp: claims.exp, user: userForCache }, ttl);
				if (waitUntil) waitUntil(write); else await write;
			}
		}
	}
	return row;
}

/* ---------- login approvals ----------
 * Once an account is signed in somewhere, a new sign-in with the right password
 * still has to be approved from one of those devices. The waiting device holds
 * the approval id and exchanges it for a session once it is approved.
 *
 * Only sessions seen recently count as approvers: an account whose devices have
 * all gone quiet can still sign in normally, so nobody is locked out by a row
 * that outlived the browser that created it.
 */
const APPROVAL_TTL = 300;              // seconds a request waits for an answer
const APPROVER_WINDOW = 7 * 86400;     // how recently a session must have been used

/** How many live devices could answer an approval request for this account. */
export async function countApprovers(env, userId) {
	const now = Math.floor(Date.now() / 1000);
	const row = await env.DB.prepare(
		`SELECT COUNT(*) AS n FROM sessions
		  WHERE user_id = ? AND revoked_at = 0 AND expires_at > ? AND last_seen_at > ?`,
	).bind(userId, now, now - APPROVER_WINDOW).first();
	return (row && row.n) || 0;
}

/** Park a verified sign-in until an existing device answers it. */
export async function createApproval(env, userId, request) {
	const id = randomHex(16);
	const now = Math.floor(Date.now() / 1000);
	const d = describeClient(request);
	const expiresAt = now + APPROVAL_TTL;
	await env.DB.prepare(
		`INSERT INTO login_approvals
		   (id, user_id, status, created_at, expires_at, device, os, browser, ip, location, user_agent)
		 VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
	).bind(id, userId, now, expiresAt, d.device, d.os, d.browser, d.ip, d.location, d.user_agent).run();

	// Write-through to KV so the waiting device polls status from the edge, and
	// mark the account as having something pending so the long-poll can skip D1
	// when there is nothing to raise. D1 stays the source of truth; KV only
	// mirrors it. Best-effort.
	if (hasKv(env)) {
		await kvPut(env, approvalKey(id),
			{ id, user_id: userId, status: "pending", expires_at: expiresAt, user_agent: d.user_agent },
			APPROVAL_TTL);
		await kvPut(env, userPendingKey(userId), { at: now }, APPROVAL_TTL);
	}
	return { id, expiresIn: APPROVAL_TTL, client: d };
}

/** Status for the waiting device. Returns null for an unknown id. */
export async function getApproval(env, id) {
	const now = Math.floor(Date.now() / 1000);
	// KV first (cacheTtl:0 so a fresh decision is seen at once). This is the
	// endpoint the waiting device polls every second, so serving it from the
	// edge is the point.
	if (hasKv(env)) {
		const cached = await kvGet(env, approvalKey(id), { cacheTtl: 0 });
		if (cached) {
			if (cached.status === "pending" && cached.expires_at < now) return { ...cached, status: "expired" };
			return cached;
		}
	}
	const row = await env.DB.prepare(
		`SELECT id, user_id, status, created_at, expires_at, user_agent FROM login_approvals WHERE id = ?`,
	).bind(id).first();
	if (!row) return null;
	if (row.status === "pending" && row.expires_at < now) {
		return { ...row, status: "expired" };
	}
	return row;
}

/** Pending requests this account should be asked about. */
export async function listPendingApprovals(env, userId) {
	const now = Math.floor(Date.now() / 1000);
	// Fast path for the long-poll: if KV is bound and there is no "pending"
	// marker for this account, there is nothing to raise, so skip the D1 read
	// entirely. The marker is set on createApproval and cleared once every
	// request is answered. A missing marker can only be a false negative for
	// the ~second it takes KV to propagate a just-created one, which the
	// once-a-second poll picks up on its next pass; it can never surface a
	// stale approval, because the actual rows still come from D1 below.
	if (hasKv(env)) {
		const marker = await kvGet(env, userPendingKey(userId), { cacheTtl: 0 });
		if (!marker) return [];
	}
	const res = await env.DB.prepare(
		`SELECT id, device, os, browser, ip, location, created_at, expires_at
		   FROM login_approvals
		  WHERE user_id = ? AND status = 'pending' AND expires_at > ?
		  ORDER BY created_at DESC
		  LIMIT 5`,
	).bind(userId, now).all();
	const rows = (res && res.results) || [];
	// Keep the marker honest: if D1 says nothing is pending, drop it so future
	// polls take the fast path again.
	if (hasKv(env) && rows.length === 0) {
		await kvDelete(env, userPendingKey(userId));
	}
	return rows;
}

/**
 * Answer a request. Scoped by user_id so one account can never answer another's,
 * and only while it is still pending, so a decision cannot be flipped.
 */
export async function decideApproval(env, id, userId, approve, sessionId) {
	const now = Math.floor(Date.now() / 1000);
	const res = await env.DB.prepare(
		`UPDATE login_approvals
		    SET status = ?, decided_at = ?, decided_by = ?
		  WHERE id = ? AND user_id = ? AND status = 'pending' AND expires_at > ?`,
	).bind(approve ? "approved" : "denied", now, sessionId || "", id, userId, now).run();
	const changed = !!(res && res.meta && res.meta.changes);

	// Mirror the decision into KV so the waiting device's poll sees it from the
	// edge, and refresh the per-account pending marker from D1 (there may be
	// other requests still waiting). D1 remains the authority.
	if (changed && hasKv(env)) {
		const cached = await kvGet(env, approvalKey(id), { cacheTtl: 0 });
		if (cached) {
			await kvPut(env, approvalKey(id), { ...cached, status: approve ? "approved" : "denied" },
				Math.max(1, (cached.expires_at || now) - now));
		}
		// Recompute the marker: dropped when this was the last pending request.
		await listPendingApprovals(env, userId);
	}
	return changed;
}

/**
 * Exchange an approved request for a session. Single use, and bound to the
 * browser that asked: a leaked id is useless from anywhere else.
 */
export async function claimApproval(env, id, request) {
	const now = Math.floor(Date.now() / 1000);
	const row = await getApproval(env, id);
	if (!row || row.status !== "approved" || row.expires_at < now) return null;

	const ua = (request.headers.get("User-Agent") || "").slice(0, 300);
	if ((row.user_agent || "") !== ua) return null;

	// The D1 UPDATE is the authority: it only succeeds if the row is still
	// 'approved', so a stale KV "approved" can never mint a second session.
	const claimed = await env.DB.prepare(
		"UPDATE login_approvals SET status = 'claimed' WHERE id = ? AND status = 'approved'",
	).bind(id).run();
	if (!claimed || !claimed.meta || !claimed.meta.changes) return null;   // already claimed

	if (hasKv(env)) {
		const cached = await kvGet(env, approvalKey(id), { cacheTtl: 0 });
		if (cached) await kvPut(env, approvalKey(id), { ...cached, status: "claimed" },
			Math.max(1, (cached.expires_at || now) - now));
	}

	return env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(row.user_id).first();
}

/** Housekeeping. Answered rows are kept for a while: the waiting device still
 *  has to be able to read its answer, and deleting it immediately would look
 *  the same as expiring. */
export async function pruneApprovals(env, userId) {
	const now = Math.floor(Date.now() / 1000);
	try {
		await env.DB.prepare(
			`DELETE FROM login_approvals
			  WHERE user_id = ?
			    AND (expires_at < ?
			         OR (status IN ('claimed', 'denied') AND decided_at > 0 AND decided_at < ?))`,
		).bind(userId, now - 3600, now - 900).run();
	} catch (e) { /* non-fatal */ }
}

/**
 * How long an explicit "no" keeps the account shut.
 *
 * A denial has to mean something. Without this, a refused sign-in could simply
 * take the email-code route instead and be let straight in, which made the
 * Deny button decorative. Fifteen minutes matches how long pruneApprovals keeps
 * a denied row, so the block and the evidence for it expire together.
 */
const DENY_BLOCK_SECONDS = 15 * 60;

/**
 * Has a sign-in for this account been denied in the last few minutes?
 *
 * Read from D1 rather than a cache: this gates a sign-in, so it must not be
 * possible for a missing KV binding to make the check quietly pass.
 *
 * Note this is account-wide, not per-IP: an attacker can change address, so
 * scoping it to one would defeat the point. The cost is that the owner cannot
 * start a *new* sign-in for fifteen minutes after refusing one - they are by
 * definition already signed in somewhere, and it clears on its own.
 */
export async function recentlyDenied(env, userId) {
	const cutoff = Math.floor(Date.now() / 1000) - DENY_BLOCK_SECONDS;
	try {
		const row = await env.DB.prepare(
			`SELECT decided_at FROM login_approvals
			  WHERE user_id = ? AND status = 'denied' AND decided_at > ?
			  ORDER BY decided_at DESC LIMIT 1`,
		).bind(userId, cutoff).first();
		if (!row) return null;
		return { deniedAt: row.decided_at, retryIn: Math.max(1, row.decided_at + DENY_BLOCK_SECONDS - Math.floor(Date.now() / 1000)) };
	} catch (e) {
		return null;                       // table missing: nothing to enforce
	}
}

export { DENY_BLOCK_SECONDS };

/* ---------- rate limiting ----------
 * Login throttling is one of the two things that hit D1 on every attempt. When
 * a KV namespace is bound it lives there instead: KV is replicated to every
 * colo, so a flood of attempts is absorbed at the edge rather than pounding one
 * database, and the rows expire on their own (no pruning). KV has no atomic
 * increment, so a burst can undercount slightly across colos - acceptable for a
 * guard whose job is to stop sustained guessing, and the lockout still fires.
 * Without the binding it falls back to the original D1 table unchanged. */

export async function checkThrottle(env, key) {
	const now = Math.floor(Date.now() / 1000);
	if (hasKv(env)) {
		const row = await kvGet(env, throttleKey(key), { cacheTtl: 0 });
		if (!row) return { allowed: true };
		if (row.locked_until > now) return { allowed: false, retryIn: row.locked_until - now };
		return { allowed: true };          // stale windows just expire out of KV
	}
	const row = await env.DB.prepare("SELECT * FROM login_attempts WHERE key = ?").bind(key).first();
	if (!row) return { allowed: true };
	if (row.locked_until > now) {
		return { allowed: false, retryIn: row.locked_until - now };
	}
	if (now - row.first_at > ATTEMPT_WINDOW) {
		await env.DB.prepare("DELETE FROM login_attempts WHERE key = ?").bind(key).run();
	}
	return { allowed: true };
}

export async function recordFailure(env, key) {
	const now = Math.floor(Date.now() / 1000);
	if (hasKv(env)) {
		const row = await kvGet(env, throttleKey(key), { cacheTtl: 0 });
		// A window that has already lapsed starts fresh.
		const active = row && (now - row.first_at <= ATTEMPT_WINDOW);
		const attempts = (active ? row.attempts : 0) + 1;
		const first_at = active ? row.first_at : now;
		const locked_until = attempts >= MAX_ATTEMPTS ? now + LOCK_SECONDS : 0;
		// Keep the row alive for the whole window or the whole lockout, whichever
		// is longer, then let KV drop it.
		const ttl = Math.max(ATTEMPT_WINDOW, locked_until ? locked_until - now : 0);
		await kvPut(env, throttleKey(key), { attempts, first_at, locked_until }, ttl);
		return;
	}
	const row = await env.DB.prepare("SELECT * FROM login_attempts WHERE key = ?").bind(key).first();
	if (!row) {
		await env.DB.prepare(
			"INSERT INTO login_attempts (key, attempts, first_at, locked_until) VALUES (?, 1, ?, 0)",
		).bind(key, now).run();
		return;
	}
	const attempts = row.attempts + 1;
	const lockedUntil = attempts >= MAX_ATTEMPTS ? now + LOCK_SECONDS : 0;
	await env.DB.prepare(
		"UPDATE login_attempts SET attempts = ?, locked_until = ? WHERE key = ?",
	).bind(attempts, lockedUntil, key).run();
}

export async function clearFailures(env, key) {
	if (hasKv(env)) {
		await kvDelete(env, throttleKey(key));
		return;
	}
	await env.DB.prepare("DELETE FROM login_attempts WHERE key = ?").bind(key).run();
}

/* ---------- request/response helpers ---------- */

export function publicUser(row) {
	if (!row) return null;
	return {
		id: row.id,
		email: row.email,
		username: row.username,
		display_name: row.display_name || row.username,
		bio: row.bio || "",
		avatar_color: row.avatar_color || "#1DB954",
		avatar_url: row.avatar_url || "",
		pref_lang: row.pref_lang || "",
		profile_complete: !!row.profile_complete,
		created_at: row.created_at,
	};
}

export function reply(body, { status = 200, cookie = null } = {}) {
	const headers = {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
	};
	if (cookie) headers["Set-Cookie"] = cookie;
	return new Response(JSON.stringify(body), { status, headers });
}

export function badRequest(message, status = 400) {
	return reply({ ok: false, error: message }, { status });
}

export async function readJson(request) {
	try {
		const data = await request.json();
		return data && typeof data === "object" ? data : {};
	} catch (e) {
		return {};
	}
}

export function clientKey(request, email) {
	const ip = request.headers.get("CF-Connecting-IP") || "unknown";
	return `${email}|${ip}`;
}

export function normaliseEmail(email) {
	return String(email || "").trim().toLowerCase();
}

/** Shared validation so signup and login agree on what is acceptable. */
export function validateCredentials({ email, password, username }) {
	if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return "Enter a valid email address.";
	if (!password || String(password).length < 8) return "Password must be at least 8 characters.";
	if (String(password).length > 200) return "That password is too long.";
	if (username !== undefined) {
		const name = String(username || "").trim();
		if (name.length < 2 || name.length > 40) return "Name must be between 2 and 40 characters.";
	}
	return null;
}

export { PBKDF2_ITERATIONS };

/* ---------- email OTP ---------- */

import { sendMail } from "./smtp.js";

const OTP_TTL_SECONDS = 10 * 60;      // codes are valid for 10 minutes
const OTP_MAX_ATTEMPTS = 6;           // wrong-code tries before a code is burned
const OTP_RESEND_SECONDS = 30;        // minimum gap between sends

function sixDigitCode() {
	// Uniform 000000-999999 without modulo bias.
	const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
	return String(n).padStart(6, "0");
}

async function sha256Hex(text) {
	const digest = await crypto.subtle.digest("SHA-256", enc.encode(text));
	return toHex(digest);
}

// Codes are stored hashed (salted with the email) so a DB leak can't reveal them.
async function hashCode(email, code) {
	return sha256Hex(email + "|" + code);
}

/**
 * Create a fresh OTP for an email, store its hash, and email it.
 * Returns { ok } or { ok:false, retryIn } when asked to resend too soon.
 */
export async function issueOtp(env, email, purpose) {
	const now = Math.floor(Date.now() / 1000);

	// KV path: one record per email, expiring with the code. No pruning, and
	// no D1 write on the busy signup/verify path.
	if (hasKv(env)) {
		const existing = await kvGet(env, otpKey(email), { cacheTtl: 0 });
		if (existing && now - existing.last_sent_at < OTP_RESEND_SECONDS) {
			return { ok: false, retryIn: OTP_RESEND_SECONDS - (now - existing.last_sent_at) };
		}
		const code = sixDigitCode();
		const codeHash = await hashCode(email, code);
		await kvPut(env, otpKey(email),
			{ code_hash: codeHash, expires_at: now + OTP_TTL_SECONDS, attempts: 0, last_sent_at: now },
			OTP_TTL_SECONDS);
		await sendMail(env, otpEmail(email, code, purpose));
		return { ok: true };
	}

	const existing = await env.DB.prepare("SELECT last_sent_at FROM email_otps WHERE email = ?").bind(email).first();
	if (existing && now - existing.last_sent_at < OTP_RESEND_SECONDS) {
		return { ok: false, retryIn: OTP_RESEND_SECONDS - (now - existing.last_sent_at) };
	}

	const code = sixDigitCode();
	const codeHash = await hashCode(email, code);
	const expiresAt = now + OTP_TTL_SECONDS;

	await env.DB.prepare(
		`INSERT INTO email_otps (email, code_hash, expires_at, attempts, last_sent_at)
		 VALUES (?, ?, ?, 0, ?)
		 ON CONFLICT(email) DO UPDATE SET
		   code_hash = excluded.code_hash,
		   expires_at = excluded.expires_at,
		   attempts = 0,
		   last_sent_at = excluded.last_sent_at`,
	).bind(email, codeHash, expiresAt, now).run();

	await sendMail(env, otpEmail(email, code, purpose));
	return { ok: true };
}

/** Validate a submitted code; on success the row is deleted. */
export async function checkOtp(env, email, code) {
	const now = Math.floor(Date.now() / 1000);

	if (hasKv(env)) {
		const row = await kvGet(env, otpKey(email), { cacheTtl: 0 });
		if (!row) return { ok: false, error: "Request a new code." };
		if (row.expires_at < now) {
			await kvDelete(env, otpKey(email));
			return { ok: false, error: "That code has expired. Request a new one." };
		}
		if (row.attempts >= OTP_MAX_ATTEMPTS) {
			await kvDelete(env, otpKey(email));
			return { ok: false, error: "Too many wrong attempts. Request a new code." };
		}
		const submitted = await hashCode(email, String(code || "").trim());
		if (!safeEqual(submitted, row.code_hash)) {
			// Re-store with the attempt counted, keeping the remaining lifetime.
			const ttl = Math.max(1, row.expires_at - now);
			await kvPut(env, otpKey(email), { ...row, attempts: row.attempts + 1 }, ttl);
			return { ok: false, error: "Incorrect code." };
		}
		await kvDelete(env, otpKey(email));
		return { ok: true };
	}

	const row = await env.DB.prepare("SELECT * FROM email_otps WHERE email = ?").bind(email).first();
	if (!row) return { ok: false, error: "Request a new code." };
	if (row.expires_at < now) {
		await env.DB.prepare("DELETE FROM email_otps WHERE email = ?").bind(email).run();
		return { ok: false, error: "That code has expired. Request a new one." };
	}
	if (row.attempts >= OTP_MAX_ATTEMPTS) {
		await env.DB.prepare("DELETE FROM email_otps WHERE email = ?").bind(email).run();
		return { ok: false, error: "Too many wrong attempts. Request a new code." };
	}
	const submitted = await hashCode(email, String(code || "").trim());
	if (!safeEqual(submitted, row.code_hash)) {
		await env.DB.prepare("UPDATE email_otps SET attempts = attempts + 1 WHERE email = ?").bind(email).run();
		return { ok: false, error: "Incorrect code." };
	}
	await env.DB.prepare("DELETE FROM email_otps WHERE email = ?").bind(email).run();
	return { ok: true };
}

function otpEmail(email, code, purpose) {
	const heading = purpose === "login" ? "Confirm your sign-in"
		: purpose === "reset" ? "Reset your password"
		: "Confirm your email";
	const intro = purpose === "reset"
		? "Use this code to reset your Cloud Songs password:"
		: heading + ". Enter this code to continue:";
	const text =
		`Your Cloud Songs verification code is ${code}\n\n` +
		`It expires in 10 minutes. If you didn't request this, you can ignore this email.\n\n` +
		`Found this in spam? Mark it as "not spam" so future codes reach your inbox.`;
	const html =
		`<div style="font-family:Arial,Helvetica,sans-serif;max-width:440px;margin:0 auto;padding:24px;color:#111">` +
		`<h2 style="margin:0 0 6px;color:#1DB954">Cloud Songs</h2>` +
		`<p style="margin:0 0 18px;font-size:15px;color:#333">${intro}</p>` +
		`<div style="font-size:34px;font-weight:700;letter-spacing:8px;background:#f4f4f4;border-radius:10px;` +
		`padding:16px 0;text-align:center;color:#111">${code}</div>` +
		`<p style="margin:18px 0 0;font-size:12px;color:#888">This code expires in 10 minutes. ` +
		`If you didn't request it, ignore this email.</p>` +
		`<p style="margin:8px 0 0;font-size:12px;color:#888">Found this in your spam folder? ` +
		`Mark it as &ldquo;not spam&rdquo; so future codes reach your inbox.</p></div>`;
	return { to: email, subject: `${code} is your Cloud Songs code`, text, html };
}
