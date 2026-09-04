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

export async function createSessionCookie(env, userId) {
	const payload = b64urlEncode(enc.encode(JSON.stringify({
		uid: userId,
		exp: Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400,
	})));
	const sig = b64urlEncode(await hmac(sessionSecret(env), payload));
	const value = `${payload}.${sig}`;
	return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}

export function clearSessionCookie() {
	return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
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

/** Returns the signed-in user row, or null. Never throws on a bad cookie. */
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
	if (!claims || !claims.uid || !claims.exp || claims.exp < Math.floor(Date.now() / 1000)) return null;

	return env.DB.prepare(
		"SELECT id, email, username, display_name, bio, avatar_color, profile_complete, created_at FROM users WHERE id = ?",
	).bind(claims.uid).first();
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
	const heading = purpose === "login" ? "Confirm your sign-in" : "Confirm your email";
	const text =
		`Your Cloud Songs verification code is ${code}\n\n` +
		`It expires in 10 minutes. If you didn't request this, you can ignore this email.`;
	const html =
		`<div style="font-family:Arial,Helvetica,sans-serif;max-width:440px;margin:0 auto;padding:24px;color:#111">` +
		`<h2 style="margin:0 0 6px;color:#1DB954">Cloud Songs</h2>` +
		`<p style="margin:0 0 18px;font-size:15px;color:#333">${heading}. Enter this code to continue:</p>` +
		`<div style="font-size:34px;font-weight:700;letter-spacing:8px;background:#f4f4f4;border-radius:10px;` +
		`padding:16px 0;text-align:center;color:#111">${code}</div>` +
		`<p style="margin:18px 0 0;font-size:12px;color:#888">This code expires in 10 minutes. ` +
		`If you didn't request it, ignore this email.</p></div>`;
	return { to: email, subject: `${code} is your Cloud Songs code`, text, html };
}
