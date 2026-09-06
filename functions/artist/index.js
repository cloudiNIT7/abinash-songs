/* GET /artist/?query=<name>   - artist search, used by the search type-ahead
   GET /artist/?id=<artistId>  - one artist: identity, bio, popular songs, albums

   The id response uses the same `{name, songs}` shape as /playlist/, so the
   player can load it directly. */
import { searchArtists, getArtist, json, fail, flags } from "../_lib/saavn.js";
import { withEdgeCache } from "../_lib/cache.js";

async function handler({ request }) {
	const url = new URL(request.url);
	const id = url.searchParams.get("id");
	const query = url.searchParams.get("query");
	const { lyrics } = flags(url);

	try {
		if (id) {
			const artist = await getArtist(id, lyrics);
			if (!artist) return fail("That artist could not be loaded.");
			// Carries media urls, so a short stale window only.
			return json(artist, { maxAge: 900, swr: 300 });
		}
		if (!query) return fail("Query or id is required to search artists!");
		// Names and photos: safe to serve stale for a while.
		return json({ status: true, artists: await searchArtists(query) }, { maxAge: 900, swr: 900 });
	} catch (e) {
		return fail(e.message || "Artist lookup failed.");
	}
}

export const onRequestGet = withEdgeCache(handler);
