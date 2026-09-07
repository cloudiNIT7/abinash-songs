/* APNs token registration for the signed-in iOS app.
 *
 *   GET    /api/me/apns           - is APNs available on this deployment?
 *   POST   /api/me/apns           - store this device's APNs token
 *   POST   /api/me/apns/remove    - forget it again
 *
 * The iOS shell in ios/ is a WKWebView, which has no Web Push, so it registers
 * an APNs device token here and the login-approval path pushes to Apple
 * directly. The token is posted from inside the page (see BridgeScript.swift),
 * so it arrives with the session cookie and is scoped to the signed-in user by
 * the /api/me auth middleware - the same arrangement the Android FCM route uses.
 */
import { reply, badRequest, readJson } from "../../_lib/auth.js";
import { saveApnsToken, listApnsTokens } from "../../_lib/push.js";
import { apnsAvailable, apnsTopic } from "../../_lib/apns.js";

export async function onRequestGet({ env, data }) {
	let count = 0;
	try {
		count = (await listApnsTokens(env, data.user.id)).length;
	} catch (e) { /* table not migrated yet */ }
	return reply({ ok: true, available: apnsAvailable(env), topic: apnsTopic(env), devices: count });
}

export async function onRequestPost({ request, env, data }) {
	if (!apnsAvailable(env)) return reply({ ok: true, available: false });
	const body = await readJson(request);
	const token = String(body.token || "").trim().toLowerCase();
	// A device token is 32 bytes as hex today, but Apple has changed the length
	// before, so accept any plausible hex string rather than a fixed size.
	if (!/^[0-9a-f]{40,200}$/.test(token)) {
		return badRequest("A valid APNs device token is required.");
	}
	const environment = String(body.env || "").trim() === "sandbox" ? "sandbox" : "production";
	try {
		await saveApnsToken(env, data.user.id, token, { environment }, request);
	} catch (e) {
		return badRequest("Push isn't set up on this deployment yet.", 503);
	}
	return reply({ ok: true });
}
