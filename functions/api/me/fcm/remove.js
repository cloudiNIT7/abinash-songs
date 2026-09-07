/* POST /api/me/fcm/remove  {token} - stop pushing to this native device. */
import { reply, badRequest, readJson } from "../../../_lib/auth.js";
import { deleteFcmToken } from "../../../_lib/push.js";

export async function onRequestPost({ request, env, data }) {
	const body = await readJson(request);
	const token = String(body.token || "").trim();
	if (!token) return badRequest("A token is required.");
	try {
		await deleteFcmToken(env, data.user.id, token);
	} catch (e) { /* nothing stored: already gone */ }
	return reply({ ok: true });
}
