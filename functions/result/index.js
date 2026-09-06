/* GET /result/?query=<pasted jiosaavn link, or a plain search term> */
import {
	searchForSong, getSongId, getSong, getAlbumId, getAlbum,
	getPlaylistId, getPlaylist, json, fail, flags,
} from "../_lib/saavn.js";
import { withEdgeCache } from "../_lib/cache.js";

async function handler({ request }) {
	const url = new URL(request.url);
	const query = url.searchParams.get("query");
	if (!query) return fail("Query is required!");

	const { lyrics } = flags(url);
	try {
		if (!query.includes("saavn")) {
			return json(await searchForSong(query, lyrics, true), { maxAge: 300, swr: 120 });
		}
		if (query.includes("/song/")) {
			const song = await getSong(await getSongId(query), lyrics);
			if (!song) return fail("That song could not be loaded.");
			return json(song, { maxAge: 0 });
		}
		if (query.includes("/album/")) {
			return json(await getAlbum(await getAlbumId(query), lyrics), { maxAge: 600, swr: 300 });
		}
		// Playlists and editorial "featured" pages
		return json(await getPlaylist(await getPlaylistId(query), lyrics), { maxAge: 600, swr: 300 });
	} catch (e) {
		return fail(e.message || "Could not resolve that link.");
	}
}

export const onRequestGet = withEdgeCache(handler);
