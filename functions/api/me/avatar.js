/* POST /api/me/avatar  {dataUrl} - set (or clear) the profile picture. */
import { reply, badRequest, readJson } from "../../_lib/auth.js";
import { setAvatar } from "../../_lib/library.js";

export async function onRequestPost({ request, env, data }) {
	const body = await readJson(request);
	try {
		await setAvatar(env, data.user.id, body.dataUrl || "");
		return reply({ ok: true });
	} catch (e) {
		return badRequest(e.message || "Couldn't save that image.");
	}
}
