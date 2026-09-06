/* Push registration for the signed-in device.
 *
 *   GET    /api/me/push          - the public key a browser needs to subscribe
 *   POST   /api/me/push          - store this device's subscription
 *   POST   /api/me/push/remove   - forget it again
 */
import { reply, badRequest, readJson } from "../../_lib/auth.js";
import { vapidPublicKey, saveSubscription, listSubscriptions } from "../../_lib/push.js";

export async function onRequestGet({ env, data }) {
	let key = "";
	try {
		key = vapidPublicKey(env);
	} catch (e) {
		// No key configured: the client simply skips push and uses the tab.
		return reply({ ok: true, key: "", available: false });
	}
	let count = 0;
	try {
		count = (await listSubscriptions(env, data.user.id)).length;
	} catch (e) { /* table not migrated yet */ }
	return reply({ ok: true, key, available: true, devices: count });
}

export async function onRequestPost({ request, env, data }) {
	const body = await readJson(request);
	const sub = body.subscription || body;
	if (!sub || typeof sub.endpoint !== "string" || !/^https:\/\//.test(sub.endpoint)) {
		return badRequest("A push subscription with an https endpoint is required.");
	}
	if (sub.endpoint.length > 1000) return badRequest("That endpoint is too long.");

	try {
		await saveSubscription(env, data.user.id, sub, request);
	} catch (e) {
		return badRequest("Push isn't set up on this deployment yet.", 503);
	}
	return reply({ ok: true });
}
