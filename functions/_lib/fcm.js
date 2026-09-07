/**
 * Firebase Cloud Messaging (HTTP v1) sender.
 *
 * The Android APK is a WebView, and Android System WebView has no Web Push API,
 * so a closed app cannot be reached by the VAPID push in push.js. FCM is the
 * native channel that can. This module sends the same content-free "tickle" the
 * Web Push path sends: a data-only message with `topic: cs-approval`, so the
 * app wakes, asks /api/me/approvals what is waiting and draws the notification
 * itself. Nothing about the account travels in the message.
 *
 * Auth is a short-lived OAuth2 access token minted from a Google service
 * account (RS256-signed JWT exchanged at oauth2.googleapis.com), which works
 * from the Workers runtime the same way the VAPID ES256 JWT does. The service
 * account JSON is the `FCM_SERVICE_ACCOUNT` secret; without it FCM is simply
 * off and Web Push carries on.
 *
 * The access token is cached in the `CACHE` KV namespace (it is valid for an
 * hour) so most sends skip the token exchange entirely.
 */

import { kvGet, kvPut, hasKv } from "./kvstore.js";

const enc = new TextEncoder();
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const TOKEN_CACHE_KEY = "auth:fcm:token";

function b64url(bytes) {
	let s = "";
	for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Parse the service-account JSON secret, or null when it is not configured. */
function serviceAccount(env) {
	if (!env.FCM_SERVICE_ACCOUNT) return null;
	try {
		const sa = JSON.parse(env.FCM_SERVICE_ACCOUNT);
		if (!sa.client_email || !sa.private_key || !sa.project_id) return null;
		return sa;
	} catch (e) {
		return null;
	}
}

/** Is native FCM available on this deployment? */
export function fcmAvailable(env) {
	return serviceAccount(env) !== null;
}

/** Import the PEM private key from the service account for RS256 signing. */
async function importPrivateKey(pem) {
	const body = pem
		.replace(/-----BEGIN PRIVATE KEY-----/, "")
		.replace(/-----END PRIVATE KEY-----/, "")
		.replace(/\s+/g, "");
	const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
	return crypto.subtle.importKey(
		"pkcs8",
		der.buffer,
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["sign"],
	);
}

/** Mint (or reuse) an OAuth2 access token for the FCM scope. */
async function accessToken(env, sa) {
	// Reuse a cached token while it is still comfortably valid.
	if (hasKv(env)) {
		const cached = await kvGet(env, TOKEN_CACHE_KEY, { cacheTtl: 60 });
		if (cached && cached.token && cached.exp > Math.floor(Date.now() / 1000) + 60) {
			return cached.token;
		}
	}

	const now = Math.floor(Date.now() / 1000);
	const header = b64url(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
	const claims = b64url(enc.encode(JSON.stringify({
		iss: sa.client_email,
		scope: SCOPE,
		aud: TOKEN_URL,
		iat: now,
		exp: now + 3600,
	})));
	const key = await importPrivateKey(sa.private_key);
	const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(`${header}.${claims}`));
	const assertion = `${header}.${claims}.${b64url(sig)}`;

	const res = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=" + encodeURIComponent(assertion),
	});
	if (!res.ok) throw new Error("FCM token exchange failed: " + res.status);
	const data = await res.json();
	const token = data.access_token;
	if (!token) throw new Error("FCM token exchange returned no token");

	if (hasKv(env)) {
		// Google returns expires_in (~3600s); cache a little short of that.
		const ttl = Math.max(60, (data.expires_in || 3600) - 120);
		await kvPut(env, TOKEN_CACHE_KEY, { token, exp: now + ttl }, ttl);
	}
	return token;
}

/**
 * Send one message to a device token. Returns "sent", "gone" (the token is
 * unregistered/invalid, so the row should go) or "failed".
 *
 * Approval tickles carry no content - the app asks the API what is waiting.
 * Suggestions do carry their text, because the native messaging service runs
 * outside the WebView and has no session cookie to fetch it with.
 */
export async function sendFcm(env, token, { topic = "cs-approval", data = null } = {}) {
	const sa = serviceAccount(env);
	if (!sa) return "failed";

	let bearer;
	try {
		bearer = await accessToken(env, sa);
	} catch (e) {
		return "failed";
	}

	const url = `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`;
	// Data-only (no `notification` block) so the app decides how to present it.
	const payload = Object.assign({ topic, kind: "approval" }, data || {});
	// FCM requires every data value to be a string.
	for (const k of Object.keys(payload)) payload[k] = String(payload[k] === undefined || payload[k] === null ? "" : payload[k]);

	const message = {
		message: {
			token,
			data: payload,
			android: { priority: "high" },
		},
	};

	let res;
	try {
		res = await fetch(url, {
			method: "POST",
			headers: { Authorization: "Bearer " + bearer, "Content-Type": "application/json" },
			body: JSON.stringify(message),
		});
	} catch (e) {
		return "failed";
	}
	if (res.ok) return "sent";
	// 404 (UNREGISTERED) / 400 (invalid token) mean the row should be dropped.
	if (res.status === 404 || res.status === 400) return "gone";
	return "failed";
}
