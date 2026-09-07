/* Native FCM token registration for the signed-in Android app.
 *
 *   GET    /api/me/fcm            - is native FCM available on this deployment?
 *   POST   /api/me/fcm            - store this device's FCM token
 *   POST   /api/me/fcm/remove     - forget it again
 *
 * The APK's WebView cannot use Web Push, so it registers an FCM token here and
 * the login-approval path wakes it through FCM instead. Scoped to the signed-in
 * user by the /api/me/* auth middleware.
 */
import { reply, badRequest, readJson } from "../../_lib/auth.js";
import { saveFcmToken, listFcmTokens } from "../../_lib/push.js";
import { fcmAvailable } from "../../_lib/fcm.js";

export async function onRequestGet({ env, data }) {
	let count = 0;
	try {
		count = (await listFcmTokens(env, data.user.id)).length;
	} catch (e) { /* table not migrated yet */ }
	return reply({ ok: true, available: fcmAvailable(env), devices: count });
}

export async function onRequestPost({ request, env, data }) {
	if (!fcmAvailable(env)) return reply({ ok: true, available: false });
	const body = await readJson(request);
	const token = String(body.token || "").trim();
	if (!token || token.length < 20 || token.length > 4096) {
		return badRequest("A valid FCM token is required.");
	}
	try {
		await saveFcmToken(env, data.user.id, token, request);
	} catch (e) {
		return badRequest("Push isn't set up on this deployment yet.", 503);
	}
	return reply({ ok: true });
}
