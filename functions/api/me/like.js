/* POST /api/me/like  {track, liked} - like or unlike a track for this account. */
import { reply, badRequest, readJson } from "../../_lib/auth.js";
import { setLike } from "../../_lib/library.js";

export async function onRequestPost({ request, env, data }) {
	const body = await readJson(request);
	if (!body.track || !body.track.id) return badRequest("A track is required.");
	const liked = !!body.liked;
	await setLike(env, data.user.id, body.track, liked);
	return reply({ ok: true, liked: liked });
}
