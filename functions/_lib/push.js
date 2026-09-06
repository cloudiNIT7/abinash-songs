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
}

export async function deleteSubscription(env, userId, endpoint) {
	await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?")
		.bind(endpoint, userId).run();
}

export async function listSubscriptions(env, userId) {
	const res = await env.DB.prepare(
		"SELECT endpoint FROM push_subscriptions WHERE user_id = ? LIMIT 20",
	).bind(userId).all();
	return ((res && res.results) || []).map((r) => r.endpoint);
}

/**
 * Tell every device this account has registered that something needs attention.
 * Best-effort by design: a phone that cannot be reached must not hold up a login.
 */
export async function pushToUser(env, userId, { topic } = {}) {
	let endpoints;
	try {
		endpoints = await listSubscriptions(env, userId);
	} catch (e) {
		return { sent: 0, gone: 0 };      // table not migrated yet
	}
	if (!endpoints.length) return { sent: 0, gone: 0 };

	const results = await Promise.all(endpoints.map(async (endpoint) => {
		const state = await sendPush(env, endpoint, { topic });
		if (state === "gone") {
			try { await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(endpoint).run(); }
			catch (e) { /* non-fatal */ }
		}
		return state;
	}));

	return {
		sent: results.filter((r) => r === "sent").length,
		gone: results.filter((r) => r === "gone").length,
	};
}
