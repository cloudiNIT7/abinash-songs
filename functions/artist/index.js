/* GET /artist/?query=<name>   - artist search, used by the search type-ahead
   GET /artist/?id=<artistId>  - one artist: identity, bio, popular songs, albums

   The id response uses the same `{name, songs}` shape as /playlist/, so the
   player can load it directly. */
import { searchArtists, getArtist, json, fail, flags } from "../_lib/saavn.js";

export async function onRequestGet({ request }) {
	const url = new URL(request.url);
	const id = url.searchParams.get("id");
	const query = url.searchParams.get("query");
	const { lyrics } = flags(url);

	try {
		if (id) {
			const artist = await getArtist(id, lyrics);
			if (!artist) return fail("That artist could not be loaded.");
			return json(artist, { maxAge: 600 });
		}
		if (!query) return fail("Query or id is required to search artists!");
		return json({ status: true, artists: await searchArtists(query) }, { maxAge: 300 });
	} catch (e) {
		return fail(e.message || "Artist lookup failed.");
	}
}
