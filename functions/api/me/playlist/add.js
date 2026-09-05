/* POST /api/me/playlist/add  {playlistId, track} - add a track to a playlist. */
import { reply, badRequest, readJson } from "../../../_lib/auth.js";
import { addToPlaylist } from "../../../_lib/library.js";

export async function onRequestPost({ request, env, data }) {
	const body = await readJson(request);
	if (!body.playlistId || !body.track || !body.track.id) {
		return badRequest("A playlist and a track are required.");
	}
	try {
		await addToPlaylist(env, data.user.id, body.playlistId, body.track);
		return reply({ ok: true });
	} catch (e) {
		return badRequest(e.message || "Couldn't add to the playlist.", 404);
	}
}
