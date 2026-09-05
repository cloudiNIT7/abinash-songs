/* POST /api/me/playlists/delete  {id} - delete one of this account's playlists. */
import { reply, badRequest, readJson } from "../../../_lib/auth.js";
import { deletePlaylist } from "../../../_lib/library.js";

export async function onRequestPost({ request, env, data }) {
	const body = await readJson(request);
	if (!body.id) return badRequest("A playlist id is required.");
	const ok = await deletePlaylist(env, data.user.id, body.id);
	if (!ok) return badRequest("Playlist not found.", 404);
	return reply({ ok: true });
}
