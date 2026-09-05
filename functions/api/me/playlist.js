/* GET /api/me/playlist?id=<id> - the tracks in one of this account's playlists. */
import { reply, badRequest } from "../../_lib/auth.js";
import { getPlaylistTracks } from "../../_lib/library.js";

export async function onRequestGet({ request, env, data }) {
	const id = new URL(request.url).searchParams.get("id");
	if (!id) return badRequest("A playlist id is required.");
	const pl = await getPlaylistTracks(env, data.user.id, id);
	if (!pl) return badRequest("Playlist not found.", 404);
	return reply({ ok: true, ...pl });
}
