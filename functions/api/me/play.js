/* POST /api/me/play  {track} - record a play for this account. */
import { reply, badRequest, readJson } from "../../_lib/auth.js";
import { recordPlay } from "../../_lib/library.js";

export async function onRequestPost({ request, env, data }) {
	const body = await readJson(request);
	if (!body.track || !body.track.id) return badRequest("A track is required.");
	await recordPlay(env, data.user.id, body.track);
	return reply({ ok: true });
}
