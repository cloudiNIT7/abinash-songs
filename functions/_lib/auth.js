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
				    device, os, browser, ip, location, user_agent)
				 VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
			).bind(sid, userId, now, now, exp, d.device, d.os, d.browser, d.ip, d.location, d.user_agent).run();
		} catch (e) { /* non-fatal */ }
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

/** Returns the signed-in user row, or null. Never throws on a bad cookie.
 *  The row carries `session_id` (the cookie's session), used by the devices UI. */
export async function currentUser(request, env) {
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

	// Cookies issued before device tracking carry no sid; they stay valid, they
	// just can't be listed or revoked until the next sign-in.
	if (claims.sid) {
		let session = null;
		try {
			session = await env.DB.prepare(
				"SELECT revoked_at, expires_at, last_seen_at FROM sessions WHERE id = ? AND user_id = ?",
			).bind(claims.sid, claims.uid).first();
		} catch (e) {
			session = null;                  // table missing: fall back to the cookie alone
		}
		if (session) {
			if (session.revoked_at > 0 || session.expires_at < now) return null;
			// Keep "last active" fresh without a write on every single request.
			if (now - session.last_seen_at > 300) {
				try {
					await env.DB.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?")
						.bind(now, claims.sid).run();
				} catch (e) { /* non-fatal */ }
			}
		}
	}

	const user = await env.DB.prepare(
		"SELECT id, email, username, display_name, bio, avatar_color, avatar_url, pref_lang, profile_complete, created_at FROM users WHERE id = ?",
	).bind(claims.uid).first();
	if (user) user.session_id = claims.sid || "";
	return user;
}

/* ---------- rate limiting ---------- */

export async function checkThrottle(env, key) {
	const now = Math.floor(Date.now() / 1000);
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
		`It expires in 10 minutes. If you didn't request this, you can ignore this email.`;
	const html =
		`<div style="font-family:Arial,Helvetica,sans-serif;max-width:440px;margin:0 auto;padding:24px;color:#111">` +
		`<h2 style="margin:0 0 6px;color:#1DB954">Cloud Songs</h2>` +
		`<p style="margin:0 0 18px;font-size:15px;color:#333">${intro}</p>` +
		`<div style="font-size:34px;font-weight:700;letter-spacing:8px;background:#f4f4f4;border-radius:10px;` +
		`padding:16px 0;text-align:center;color:#111">${code}</div>` +
		`<p style="margin:18px 0 0;font-size:12px;color:#888">This code expires in 10 minutes. ` +
		`If you didn't request it, ignore this email.</p></div>`;
	return { to: email, subject: `${code} is your Cloud Songs code`, text, html };
}
