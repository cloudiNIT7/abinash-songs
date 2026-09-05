/* GET  /api/me/playlists       - list this account's playlists (with counts)
   POST /api/me/playlists {name} - create a new playlist */
import { reply, badRequest, readJson } from "../../_lib/auth.js";
import { listPlaylists, createPlaylist } from "../../_lib/library.js";

export async function onRequestGet({ env, data }) {
	return reply({ ok: true, playlists: await listPlaylists(env, data.user.id) });
}

export async function onRequestPost({ request, env, data }) {
	const body = await readJson(request);
	try {
		const pl = await createPlaylist(env, data.user.id, body.name);
		return reply({ ok: true, playlist: pl }, { status: 201 });
	} catch (e) {
		return badRequest(e.message || "Couldn't create the playlist.");
	}
}
