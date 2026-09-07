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
import { kvGet, kvPut, kvDelete, hasKv, pushListKey, fcmListKey, apnsListKey } from "./kvstore.js";

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
import { sendApns, apnsAvailable } from "./apns.js";

const FCM_LIST_TTL = 3600;

/* Every notification carries a picture. Album art when we have it; otherwise
 * the app icon, so a nudge never lands as a bare line of text. Must be an
 * absolute https URL - FCM fetches it itself and rejects anything else. */
const SITE = "https://abinash-songs.pages.dev";
const FALLBACK_IMAGE = SITE + "/assets/pwa-512.png";

function imageOr(url) {
	const s = String(url || "").trim();
	return /^https:\/\//i.test(s) ? s : FALLBACK_IMAGE;
}

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

/**
 * Send the sign-in approval alert to every registered native (FCM) device.
 *
 * Sent as a notification message with the app icon, so Firebase draws it - with
 * a picture - even on a build whose own handler would render a plain line of
 * text. The wording stays deliberately generic: no device, city or IP travels in
 * the push, exactly as before. The details are only ever read from the API once
 * the app is opened.
 */
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
		const state = await sendFcm(env, token, {
			topic,
			notify: {
				title: "Approve sign-in to Cloud Songs?",
				body: "Someone signed in with your password. Tap to review.",
				tag: "cs-approval",
				image: FALLBACK_IMAGE,
			},
		});
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

/* ---------- native APNs tokens (the iOS app) ----------
 * The iOS shell in ios/ is the counterpart of the APK, and a WKWebView has no
 * Push API either, so it registers an APNs device token here. The send path
 * signs a provider JWT with the .p8 key and posts straight to Apple - see
 * _lib/apns.js. Stored separately from fcm_tokens because the token, the
 * transport and the payload shape are all different. */

const APNS_LIST_TTL = 3600;

export async function saveApnsToken(env, userId, token, { environment = "production" } = {}, request) {
	const now = Math.floor(Date.now() / 1000);
	const ua = (request && request.headers.get("User-Agent") || "").slice(0, 300);
	const host = environment === "sandbox" ? "sandbox" : "production";
	await env.DB.prepare(
		`INSERT INTO apns_tokens (token, user_id, env, platform, user_agent, created_at, last_used_at)
		 VALUES (?, ?, ?, 'ios', ?, ?, ?)
		 ON CONFLICT(token) DO UPDATE SET
		   user_id = excluded.user_id,
		   env = excluded.env,
		   user_agent = excluded.user_agent,
		   last_used_at = excluded.last_used_at`,
	).bind(token, userId, host, ua, now, now).run();
	await kvDelete(env, apnsListKey(userId));
}

export async function deleteApnsToken(env, userId, token) {
	await env.DB.prepare("DELETE FROM apns_tokens WHERE token = ? AND user_id = ?")
		.bind(token, userId).run();
	await kvDelete(env, apnsListKey(userId));
}

/** `[{ token, env }]` for an account. */
export async function listApnsTokens(env, userId) {
	if (hasKv(env)) {
		const cached = await kvGet(env, apnsListKey(userId), { cacheTtl: 60 });
		if (cached && Array.isArray(cached)) return cached;
	}
	const res = await env.DB.prepare(
		"SELECT token, env FROM apns_tokens WHERE user_id = ? LIMIT 20",
	).bind(userId).all();
	const rows = ((res && res.results) || []).map((r) => ({ token: r.token, env: r.env || "production" }));
	if (hasKv(env)) await kvPut(env, apnsListKey(userId), rows, APNS_LIST_TTL);
	return rows;
}

async function dropApnsToken(env, userId, token) {
	// Scoped to the account whose list produced it, the same as the explicit
	// unregister path. `token` is the primary key, so this is the one row.
	try { await env.DB.prepare("DELETE FROM apns_tokens WHERE token = ? AND user_id = ?").bind(token, userId).run(); }
	catch (e) { /* non-fatal */ }
	await kvDelete(env, apnsListKey(userId));
}

/**
 * Send the sign-in approval alert to every registered iOS device.
 *
 * Sent as a displayed alert with the same deliberately generic wording the FCM
 * path uses: no device, city or IP travels in the push. The details are only
 * ever read from the API once the app is opened.
 */
export async function apnsToUser(env, userId, { topic } = {}) {
	if (!apnsAvailable(env)) return { sent: 0, gone: 0 };
	let rows;
	try {
		rows = await listApnsTokens(env, userId);
	} catch (e) {
		return { sent: 0, gone: 0 };      // table not migrated yet
	}
	if (!rows.length) return { sent: 0, gone: 0 };

	const states = await Promise.all(rows.map(async (row) => {
		const state = await sendApns(env, row.token, {
			title: "Approve sign-in to Cloud Songs?",
			body: "Someone signed in with your password. Tap to review.",
			collapseId: "cs-approval",
			threadId: "cs-approval",
			image: FALLBACK_IMAGE,
			data: { kind: "approval", topic: topic || "cs-approval" },
			environment: row.env,
		});
		if (state === "gone") await dropApnsToken(env, userId, row.token);
		return state;
	}));

	return {
		sent: states.filter((s) => s === "sent").length,
		gone: states.filter((s) => s === "gone").length,
	};
}

/** The suggestion nudge, for iOS devices. Shape mirrors the FCM one. */
async function apnsSuggestToUser(env, userId, { title, body, image, data }) {
	if (!apnsAvailable(env)) return 0;
	let rows;
	try {
		rows = await listApnsTokens(env, userId);
	} catch (e) {
		return 0;                         // table not migrated yet
	}
	if (!rows.length) return 0;

	const states = await Promise.all(rows.map(async (row) => {
		const state = await sendApns(env, row.token, {
			title,
			body,
			image,
			collapseId: "cs-suggest",
			threadId: "cs-suggest",
			data,
			environment: row.env,
		});
		if (state === "gone") await dropApnsToken(env, userId, row.token);
		return state;
	}));
	return states.filter((s) => s === "sent").length;
}

/**
 * Push a "listen to this" suggestion to the account's native devices.
 *
 * Android goes through Firebase as a real FCM *notification* message: Firebase
 * draws it on the device itself whenever the app is backgrounded or closed, so
 * this works on the build people already have installed - no app update needed.
 * iOS gets the same thing over APNs, where the system draws it and the app's
 * notification-service extension adds the cover art. The song id still rides
 * along as data, so a tap can open the right track.
 *
 * Browsers are not sent suggestions. Web Push stays reserved for sign-in
 * approvals, where it is a security alert that has to reach every device.
 */
export async function suggestToUser(env, userId, suggestion) {
	if (!fcmAvailable(env) && !apnsAvailable(env)) return { sent: 0, fcm: 0, apns: 0 };

	const title = suggestion.title || "Listen to this";
	const body = suggestion.body || "";
	// Album art, so the notification shows the cover rather than just text.
	// Falls back to the app icon when a track has no usable artwork.
	const image = imageOr(suggestion.song && suggestion.song.image);
	const data = {
		topic: "cs-suggest",
		kind: "suggest",
		songId: (suggestion.song && suggestion.song.id) || "",
		songName: (suggestion.song && suggestion.song.name) || "",
		image: image,
	};

	// iOS in parallel with Android; neither may hold up the other.
	const apnsSent = apnsSuggestToUser(env, userId, { title, body, image, data });

	let tokens = [];
	if (fcmAvailable(env)) {
		try {
			tokens = await listFcmTokens(env, userId);
		} catch (e) {
			tokens = [];                  // table not migrated yet
		}
	}

	const states = await Promise.all((tokens || []).map(async (token) => {
		const state = await sendFcm(env, token, {
			topic: "cs-suggest",
			data,
			notify: { title, body, tag: "cs-suggest", image },
		});
		if (state === "gone") {
			try { await env.DB.prepare("DELETE FROM fcm_tokens WHERE token = ?").bind(token).run(); }
			catch (e) { /* non-fatal */ }
		}
		return state;
	}));
	if (states.some((s) => s === "gone")) await kvDelete(env, fcmListKey(userId));

	const fcm = states.filter((s) => s === "sent").length;
	const apns = await apnsSent;
	return { sent: fcm + apns, fcm, apns };
}

/**
 * Tell every device this account has registered that something needs attention.
 * Best-effort by design: a phone that cannot be reached must not hold up a login.
 * Covers Web Push (browsers), native FCM (the Android APK) and APNs (the iOS
 * app).
 */
export async function pushToUser(env, userId, { topic } = {}) {
	let endpoints;
	try {
		endpoints = await listSubscriptions(env, userId);
	} catch (e) {
		endpoints = [];                   // table not migrated yet
	}

	// Native devices go out alongside the browsers rather than after them, so a
	// login is not slowed by however many transports are configured.
	const native = Promise.all([
		fcmToUser(env, userId, { topic }),
		apnsToUser(env, userId, { topic }),
	]);

	const webResults = await Promise.all((endpoints || []).map(async (endpoint) => {
		const state = await sendPush(env, endpoint, { topic });
		if (state === "gone") {
			try { await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(endpoint).run(); }
			catch (e) { /* non-fatal */ }
		}
		return state;
	}));
	if (webResults.some((r) => r === "gone")) await kvDelete(env, pushListKey(userId));

	const [fcm, apns] = await native;

	return {
		sent: webResults.filter((r) => r === "sent").length + fcm.sent + apns.sent,
		gone: webResults.filter((r) => r === "gone").length + fcm.gone + apns.gone,
	};
}
