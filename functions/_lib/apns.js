/**
 * Apple Push Notification service (APNs) sender.
 *
 * The iOS app is the counterpart of the Android APK, and it has the same problem
 * the APK has: a WKWebView cannot use Web Push, so a closed app cannot be
 * reached by the VAPID push in push.js. Where Android goes through Firebase,
 * iOS talks to APNs directly - no SDK on either side.
 *
 * Auth is a provider token: a short-lived ES256 JWT signed with the .p8 key
 * downloaded from the Apple developer portal. That is the same primitive the
 * VAPID path already uses, so it works from the Workers runtime unchanged. The
 * token is valid for an hour and is cached in the `CACHE` KV namespace, so most
 * sends skip the signing entirely.
 *
 * Configuration (Cloudflare secrets):
 *
 *   APNS_KEY        contents of AuthKey_XXXXXXXXXX.p8, including the BEGIN/END lines
 *   APNS_KEY_ID     the 10-character key id
 *   APNS_TEAM_ID    the 10-character Apple team id
 *   APNS_BUNDLE_ID  optional; defaults to com.cloudsongs.app
 *
 * Without those, APNs is simply off - exactly how FCM behaves without
 * FCM_SERVICE_ACCOUNT - and Web Push carries on.
 */

import { kvGet, kvPut, hasKv } from "./kvstore.js";

const enc = new TextEncoder();

const HOST_PROD = "https://api.push.apple.com";
const HOST_SANDBOX = "https://api.sandbox.push.apple.com";
const TOKEN_CACHE_KEY = "auth:apns:token";
const TOKEN_TTL = 45 * 60;             // Apple allows 60 minutes; renew early
const DEFAULT_BUNDLE_ID = "com.cloudsongs.app";

function b64url(bytes) {
	let s = "";
	for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The configured key, or null when this deployment has no APNs credentials. */
function credentials(env) {
	if (!env.APNS_KEY || !env.APNS_KEY_ID || !env.APNS_TEAM_ID) return null;
	const key = String(env.APNS_KEY);
	if (!/BEGIN PRIVATE KEY/.test(key)) return null;
	return {
		key,
		keyId: String(env.APNS_KEY_ID).trim(),
		teamId: String(env.APNS_TEAM_ID).trim(),
		bundleId: String(env.APNS_BUNDLE_ID || DEFAULT_BUNDLE_ID).trim(),
	};
}

/** Is APNs available on this deployment? */
export function apnsAvailable(env) {
	return credentials(env) !== null;
}

/** The topic (bundle id) pushes are addressed to. */
export function apnsTopic(env) {
	const creds = credentials(env);
	return creds ? creds.bundleId : DEFAULT_BUNDLE_ID;
}

/** Import the .p8 (PKCS#8, EC P-256) for ES256 signing. */
async function importKey(pem) {
	const body = pem
		.replace(/-----BEGIN PRIVATE KEY-----/, "")
		.replace(/-----END PRIVATE KEY-----/, "")
		.replace(/\s+/g, "");
	const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
	return crypto.subtle.importKey(
		"pkcs8",
		der.buffer,
		{ name: "ECDSA", namedCurve: "P-256" },
		false,
		["sign"],
	);
}

/**
 * Build the provider JWT. Exported so it can be exercised on its own; the send
 * path goes through `providerToken()`, which caches.
 */
export async function signProviderToken(creds, now = Math.floor(Date.now() / 1000)) {
	const header = b64url(enc.encode(JSON.stringify({ alg: "ES256", kid: creds.keyId, typ: "JWT" })));
	const claims = b64url(enc.encode(JSON.stringify({ iss: creds.teamId, iat: now })));
	const key = await importKey(creds.key);
	const sig = await crypto.subtle.sign(
		{ name: "ECDSA", hash: "SHA-256" },
		key,
		enc.encode(`${header}.${claims}`),
	);
	// WebCrypto already returns the raw r||s pair JWS wants.
	return `${header}.${claims}.${b64url(sig)}`;
}

/** Mint (or reuse) the provider token. */
async function providerToken(env, creds) {
	if (hasKv(env)) {
		const cached = await kvGet(env, TOKEN_CACHE_KEY, { cacheTtl: 60 });
		if (cached && cached.token && cached.exp > Math.floor(Date.now() / 1000) + 60) {
			return cached.token;
		}
	}
	const now = Math.floor(Date.now() / 1000);
	const token = await signProviderToken(creds, now);
	if (hasKv(env)) await kvPut(env, TOKEN_CACHE_KEY, { token, exp: now + TOKEN_TTL }, TOKEN_TTL);
	return token;
}

/** Reasons Apple gives when a device token will never work again. */
const DEAD_REASONS = new Set([
	"BadDeviceToken",
	"Unregistered",
	"DeviceTokenNotForTopic",
	"TopicDisallowed",
]);

async function postToApns(host, deviceToken, bearer, headers, payload) {
	let res;
	try {
		res = await fetch(`${host}/3/device/${deviceToken}`, {
			method: "POST",
			headers: Object.assign({ authorization: `bearer ${bearer}`, "content-type": "application/json" }, headers),
			body: JSON.stringify(payload),
		});
	} catch (e) {
		return { state: "failed", reason: "network" };
	}
	if (res.status === 200) return { state: "sent", reason: "" };

	let reason = "";
	try {
		const body = await res.json();
		reason = (body && body.reason) || "";
	} catch (e) { /* no body */ }

	if (res.status === 410 || DEAD_REASONS.has(reason)) return { state: "gone", reason };
	return { state: "failed", reason: reason || String(res.status) };
}

/**
 * Send one notification to one device token.
 *
 * Returns "sent", "gone" (the token is dead, so the row should go) or "failed".
 *
 * Two shapes, matching the two jobs the FCM sender does:
 *
 *   alert (default)   - a real notification. iOS draws it whether the app is
 *                       open, backgrounded or closed, so no app-side code is
 *                       needed. Used for approvals and suggestions.
 *   silent: true      - `content-available`, nothing displayed. Wakes the app so
 *                       it can decide for itself.
 *
 * `image` is passed through as a custom key; the app's notification-service
 * extension downloads it and attaches the cover, which is how the Android
 * notifications get their artwork.
 *
 * `environment` picks the APNs host: a build run from Xcode has a sandbox token,
 * TestFlight and the App Store have production ones. A token rejected as
 * BadDeviceToken is retried against the other host, so a device that reported
 * the wrong environment still gets its push.
 */
export async function sendApns(env, deviceToken, {
	title = "",
	body = "",
	silent = false,
	sound = "default",
	image = "",
	collapseId = "",
	threadId = "",
	data = null,
	environment = "production",
	expiration = 0,
} = {}) {
	const creds = credentials(env);
	if (!creds || !deviceToken) return "failed";

	let bearer;
	try {
		bearer = await providerToken(env, creds);
	} catch (e) {
		return "failed";
	}

	const aps = {};
	if (silent) {
		aps["content-available"] = 1;
	} else {
		aps.alert = { title, body };
		if (sound) aps.sound = sound;
		// Let the extension add the cover art.
		aps["mutable-content"] = 1;
		if (threadId) aps["thread-id"] = threadId;
	}

	const payload = Object.assign({ aps }, data || {});
	if (image) payload.image = image;

	const headers = {
		"apns-topic": creds.bundleId,
		"apns-push-type": silent ? "background" : "alert",
		"apns-priority": silent ? "5" : "10",
		"apns-expiration": String(expiration || 0),
	};
	if (collapseId) headers["apns-collapse-id"] = collapseId.slice(0, 64);

	const primary = environment === "sandbox" ? HOST_SANDBOX : HOST_PROD;
	const secondary = environment === "sandbox" ? HOST_PROD : HOST_SANDBOX;

	let result = await postToApns(primary, deviceToken, bearer, headers, payload);
	if (result.state === "gone" && result.reason === "BadDeviceToken") {
		// Almost always "this token belongs to the other environment".
		result = await postToApns(secondary, deviceToken, bearer, headers, payload);
	}
	return result.state;
}
