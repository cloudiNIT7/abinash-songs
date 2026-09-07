/* POST /api/me/apns/remove  {token} - stop pushing to this iOS device. */
import { reply, badRequest, readJson } from "../../../_lib/auth.js";
import { deleteApnsToken } from "../../../_lib/push.js";

export async function onRequestPost({ request, env, data }) {
	const body = await readJson(request);
	const token = String(body.token || "").trim().toLowerCase();
	if (!token) return badRequest("A token is required.");
	try {
		await deleteApnsToken(env, data.user.id, token);
	} catch (e) { /* nothing stored: already gone */ }
	return reply({ ok: true });
}
