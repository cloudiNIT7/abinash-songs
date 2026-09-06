/* GET /playlist/?query=<jiosaavn playlist or featured url>&lyrics= */
import { getPlaylistId, getPlaylist, json, fail, flags } from "../_lib/saavn.js";
import { withEdgeCache } from "../_lib/cache.js";

async function handler({ request }) {
	const url = new URL(request.url);
	const query = url.searchParams.get("query");
	if (!query) return fail("Query is required to search playlists!");

	const { lyrics } = flags(url);
	try {
		const id = await getPlaylistId(query);
		const playlist = await getPlaylist(id, lyrics);
		if (!playlist) return fail("That playlist could not be loaded.");
		// The editorial lists the home view opens: the hottest path in the app,
		// and each one costs an HTML scrape plus a details call upstream.
		return json(playlist, { maxAge: 600, swr: 300 });
	} catch (e) {
		return fail(e.message || "Could not load that playlist.");
	}
}

export const onRequestGet = withEdgeCache(handler);
