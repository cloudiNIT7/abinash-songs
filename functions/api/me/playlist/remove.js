/* POST /api/me/playlist/remove  {playlistId, trackId} - remove a track. */
import { reply, badRequest, readJson } from "../../../_lib/auth.js";
import { removeFromPlaylist } from "../../../_lib/library.js";

export async function onRequestPost({ request, env, data }) {
	const body = await readJson(request);
	if (!body.playlistId || !body.trackId) return badRequest("A playlist and a track are required.");
	try {
		await removeFromPlaylist(env, data.user.id, body.playlistId, body.trackId);
		return reply({ ok: true });
	} catch (e) {
		return badRequest(e.message || "Couldn't remove from the playlist.", 404);
	}
}
