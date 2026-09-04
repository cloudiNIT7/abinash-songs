/* GET /playlist/?query=<jiosaavn playlist or featured url>&lyrics= */
import { getPlaylistId, getPlaylist, json, fail, flags } from "../_lib/saavn.js";

export async function onRequestGet({ request }) {
	const url = new URL(request.url);
	const query = url.searchParams.get("query");
	if (!query) return fail("Query is required to search playlists!");

	const { lyrics } = flags(url);
	try {
		const id = await getPlaylistId(query);
		const playlist = await getPlaylist(id, lyrics);
		if (!playlist) return fail("That playlist could not be loaded.");
		return json(playlist, { maxAge: 300 });
	} catch (e) {
		return fail(e.message || "Could not load that playlist.");
	}
}
