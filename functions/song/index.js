/* GET /song/?query=&songdata=&lyrics=  - search by name, or resolve a song link */
import { searchForSong, json, fail, flags } from "../_lib/saavn.js";
import { withEdgeCache } from "../_lib/cache.js";

async function handler({ request }) {
	const url = new URL(request.url);
	const query = url.searchParams.get("query");
	if (!query) return fail("Query is required to search songs!");

	const { lyrics, songdata } = flags(url);
	try {
		const results = await searchForSong(query, lyrics, songdata);
		// `songdata=false` is the type-ahead: titles only, so it can go stale.
		// With song data the payload carries media urls, so keep that tighter.
		return json(results, songdata ? { maxAge: 300, swr: 120 } : { maxAge: 600, swr: 600 });
	} catch (e) {
		return fail(e.message || "Search failed.");
	}
}

export const onRequestGet = withEdgeCache(handler);
