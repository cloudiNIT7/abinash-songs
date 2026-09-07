/**
 * Web Push, the bit that reaches a phone when the app isn't open.
 *
 * Only a "tickle" is sent - a push with no payload. The service worker wakes up,
 * asks the API what is waiting and draws the notification itself. That skips the
 * RFC 8291 payload encryption entirely, and means a push carries no account data
 * even in transit.
 *
 * Auth is VAPID: a short-lived ES256 JWT signed with the account's own key pair.
 * The private key lives in the `VAPID_PRIVATE_JWK` secret; the public key is
 * derived from it, so there is only one thing to configure.
 */

const JWT_TTL = 12 * 3600;             // push services reject anything longer than 24h
const SUBJECT = "mailto:admin@abinash-songs.pages.dev";

// Cache the per-account endpoint list in KV so waking an account's other
// devices does not read D1 first. Invalidated on any change; D1 stays the
// source of truth and a miss (or no binding) just runs the query.
import { kvGet, kvPut, kvDelete, hasKv, pushListKey, fcmListKey, suggestKey } from "./kvstore.js";

const PUSH_LIST_TTL = 3600;            // seconds a cached endpoint list is trusted

const enc = new TextEncoder();

function b64url(bytes) {
	let s = "";
	for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(text) {
	const padded = String(text).replace(/-/g, "+").replace(/_/g, "/");
	const raw = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
	return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function readKey(env) {
	if (!env.VAPID_PRIVATE_JWK) throw new Error("VAPID_PRIVATE_JWK is not configured.");
	const jwk = JSON.parse(env.VAPID_PRIVATE_JWK);
	if (!jwk.d || !jwk.x || !jwk.y) throw new Error("VAPID_PRIVATE_JWK is not a P-256 private key.");
	return jwk;
}

/** The `applicationServerKey` a browser needs in order to subscribe. */
export function vapidPublicKey(env) {
	const jwk = readKey(env);
	const x = fromB64url(jwk.x);
	const y = fromB64url(jwk.y);
	const raw = new Uint8Array(65);
	raw[0] = 4;                          // uncompressed point
	raw.set(x, 1);
	raw.set(y, 33);
	return b64url(raw);
}

async function vapidHeader(env, endpoint) {
	const jwk = readKey(env);
	const key = await crypto.subtle.importKey(
		"jwk",
		{ kty: "EC", crv: "P-256", d: jwk.d, x: jwk.x, y: jwk.y, ext: true },
		{ name: "ECDSA", namedCurve: "P-256" },
		false,
		["sign"],
	);

	const header = b64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
	const claims = b64url(enc.encode(JSON.stringify({
		aud: new URL(endpoint).origin,
		exp: Math.floor(Date.now() / 1000) + JWT_TTL,
		sub: SUBJECT,
	})));
	const signature = await crypto.subtle.sign(
		{ name: "ECDSA", hash: "SHA-256" },
		key,
		enc.encode(`${header}.${claims}`),
	);
	return `vapid t=${header}.${claims}.${b64url(signature)}, k=${vapidPublicKey(env)}`;
}

/**
 * Nudge one subscription. Returns "sent", "gone" (the browser dropped it, so the
 * row should go too) or "failed".
 */
export async function sendPush(env, endpoint, { topic, urgency = "high", ttl = 120 } = {}) {
	let res;
	try {
		const headers = {
			Authorization: await vapidHeader(env, endpoint),
			TTL: String(ttl),
			Urgency: urgency,
			"Content-Length": "0",
		};
		// Collapses repeat pushes about the same thing into one notification.
		if (topic) headers.Topic = topic;
		res = await fetch(endpoint, { method: "POST", headers });
	} catch (e) {
		return "failed";
	}
	if (res.status === 404 || res.status === 410) return "gone";
	return res.ok ? "sent" : "failed";
}

/* ---------- stored subscriptions ---------- */

export async function saveSubscription(env, userId, sub, request) {
	const now = Math.floor(Date.now() / 1000);
	const ua = (request.headers.get("User-Agent") || "").slice(0, 300);
	await env.DB.prepare(
		`INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, user_agent, created_at, last_used_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(endpoint) DO UPDATE SET
		   user_id = excluded.user_id,
		   p256dh = excluded.p256dh,
		   auth = excluded.auth,
		   user_agent = excluded.user_agent,
		   last_used_at = excluded.last_used_at`,
	).bind(
		sub.endpoint,
		userId,
		(sub.keys && sub.keys.p256dh) || "",
		(sub.keys && sub.keys.auth) || "",
		ua,
		now,
		now,
	).run();
	// The account's endpoint set changed: drop the cache so the next push
	// re-reads it from D1.
	await kvDelete(env, pushListKey(userId));
}

export async function deleteSubscription(env, userId, endpoint) {
	await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?")
		.bind(endpoint, userId).run();
	await kvDelete(env, pushListKey(userId));
}

export async function listSubscriptions(env, userId) {
	// KV cache first, so the login "wake my other devices" path does not read
	// D1. A miss falls through to D1 and warms the cache.
	if (hasKv(env)) {
		const cached = await kvGet(env, pushListKey(userId), { cacheTtl: 60 });
		if (cached && Array.isArray(cached)) return cached;
	}
	const res = await env.DB.prepare(
		"SELECT endpoint FROM push_subscriptions WHERE user_id = ? LIMIT 20",
	).bind(userId).all();
	const endpoints = ((res && res.results) || []).map((r) => r.endpoint);
	if (hasKv(env)) await kvPut(env, pushListKey(userId), endpoints, PUSH_LIST_TTL);
	return endpoints;
}

/* ---------- native FCM tokens (Android APK) ----------
 * The APK's WebView has no Web Push, so it registers an FCM token instead.
 * Stored in D1 (table fcm_tokens); the send path mints an OAuth token from the
 * service account and pushes the same content-free tickle. */

import { sendFcm, fcmAvailable } from "./fcm.js";

const FCM_LIST_TTL = 3600;

export async function saveFcmToken(env, userId, token, request) {
	const now = Math.floor(Date.now() / 1000);
	const ua = (request && request.headers.get("User-Agent") || "").slice(0, 300);
	await env.DB.prepare(
		`INSERT INTO fcm_tokens (token, user_id, platform, user_agent, created_at, last_used_at)
		 VALUES (?, ?, 'android', ?, ?, ?)
		 ON CONFLICT(token) DO UPDATE SET
		   user_id = excluded.user_id,
		   user_agent = excluded.user_agent,
		   last_used_at = excluded.last_used_at`,
	).bind(token, userId, ua, now, now).run();
	await kvDelete(env, fcmListKey(userId));
}

export async function deleteFcmToken(env, userId, token) {
	await env.DB.prepare("DELETE FROM fcm_tokens WHERE token = ? AND user_id = ?")
		.bind(token, userId).run();
	await kvDelete(env, fcmListKey(userId));
}

export async function listFcmTokens(env, userId) {
	if (hasKv(env)) {
		const cached = await kvGet(env, fcmListKey(userId), { cacheTtl: 60 });
		if (cached && Array.isArray(cached)) return cached;
	}
	const res = await env.DB.prepare(
		"SELECT token FROM fcm_tokens WHERE user_id = ? LIMIT 20",
	).bind(userId).all();
	const tokens = ((res && res.results) || []).map((r) => r.token);
	if (hasKv(env)) await kvPut(env, fcmListKey(userId), tokens, FCM_LIST_TTL);
	return tokens;
}

/** Send the tickle to every registered native (FCM) device. Best-effort. */
export async function fcmToUser(env, userId, { topic } = {}) {
	if (!fcmAvailable(env)) return { sent: 0, gone: 0 };
	let tokens;
	try {
		tokens = await listFcmTokens(env, userId);
	} catch (e) {
		return { sent: 0, gone: 0 };      // table not migrated yet
	}
	if (!tokens.length) return { sent: 0, gone: 0 };

	const results = await Promise.all(tokens.map(async (token) => {
		const state = await sendFcm(env, token, { topic });
		if (state === "gone") {
			try { await env.DB.prepare("DELETE FROM fcm_tokens WHERE token = ?").bind(token).run(); }
			catch (e) { /* non-fatal */ }
		}
		return state;
	}));
	if (results.some((r) => r === "gone")) await kvDelete(env, fcmListKey(userId));

	return {
		sent: results.filter((r) => r === "sent").length,
		gone: results.filter((r) => r === "gone").length,
	};
}

/**
 * Push a "listen to this" suggestion to the account's native devices.
 *
 * Firebase only, and sent as a real FCM *notification* message: Firebase draws
 * it on the device itself whenever the app is backgrounded or closed, so this
 * works on the build people already have installed - no app update needed. The
 * song id still rides along as data, so a tap can open the right track.
 *
 * Browsers are not sent suggestions. Web Push stays reserved for sign-in
 * approvals, where it is a security alert that has to reach every device.
 */
export async function suggestToUser(env, userId, suggestion) {
	if (!fcmAvailable(env)) return { sent: 0, fcm: 0 };

	const title = suggestion.title || "Listen to this";
	const body = suggestion.body || "";
	const data = {
		topic: "cs-suggest",
		kind: "suggest",
		songId: (suggestion.song && suggestion.song.id) || "",
		songName: (suggestion.song && suggestion.song.name) || "",
	};

	let tokens;
	try {
		tokens = await listFcmTokens(env, userId);
	} catch (e) {
		return { sent: 0, fcm: 0 };       // table not migrated yet
	}
	if (!tokens.length) return { sent: 0, fcm: 0 };

	const states = await Promise.all(tokens.map(async (token) => {
		const state = await sendFcm(env, token, {
			topic: "cs-suggest",
			data,
			notify: { title, body, tag: "cs-suggest" },
		});
		if (state === "gone") {
			try { await env.DB.prepare("DELETE FROM fcm_tokens WHERE token = ?").bind(token).run(); }
			catch (e) { /* non-fatal */ }
		}
		return state;
	}));
	if (states.some((s) => s === "gone")) await kvDelete(env, fcmListKey(userId));

	const sent = states.filter((s) => s === "sent").length;
	return { sent, fcm: sent };
}

/**
 * Tell every device this account has registered that something needs attention.
 * Best-effort by design: a phone that cannot be reached must not hold up a login.
 * Covers both Web Push (browsers) and native FCM (the Android APK).
 */
export async function pushToUser(env, userId, { topic } = {}) {
	let endpoints;
	try {
		endpoints = await listSubscriptions(env, userId);
	} catch (e) {
		endpoints = [];                   // table not migrated yet
	}

	const webResults = await Promise.all((endpoints || []).map(async (endpoint) => {
		const state = await sendPush(env, endpoint, { topic });
		if (state === "gone") {
			try { await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(endpoint).run(); }
			catch (e) { /* non-fatal */ }
		}
		return state;
	}));
	if (webResults.some((r) => r === "gone")) await kvDelete(env, pushListKey(userId));

	// Native FCM devices (the APK) in parallel with the Web Push ones above.
	const fcm = await fcmToUser(env, userId, { topic });

	return {
		sent: webResults.filter((r) => r === "sent").length + fcm.sent,
		gone: webResults.filter((r) => r === "gone").length + fcm.gone,
	};
}
