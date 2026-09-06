/* POST /api/me/push/remove  {endpoint} - stop pushing to this device. */
import { reply, badRequest, readJson } from "../../../_lib/auth.js";
import { deleteSubscription } from "../../../_lib/push.js";

export async function onRequestPost({ request, env, data }) {
	const body = await readJson(request);
	const endpoint = String(body.endpoint || "").trim();
	if (!endpoint) return badRequest("An endpoint is required.");
	try {
		await deleteSubscription(env, data.user.id, endpoint);
	} catch (e) { /* nothing stored: already gone */ }
	return reply({ ok: true });
}
