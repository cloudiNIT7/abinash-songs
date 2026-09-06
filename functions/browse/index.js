/* GET /browse/?query=<mood|genre|artist> - songs for a mood/genre/artist,
   preferring a matching editorial playlist for a rich result. */
import { browseTracks, json, fail } from "../_lib/saavn.js";
import { withEdgeCache } from "../_lib/cache.js";

async function handler({ request }) {
	const url = new URL(request.url);
	const query = url.searchParams.get("query");
	if (!query) return fail("Query is required.");
	try {
		// Mood and language chips on the home view: a fixed, small set of terms,
		// which is exactly the shape the edge cache is good at.
		return json(await browseTracks(query, false), { maxAge: 600, swr: 300 });
	} catch (e) {
		return fail(e.message || "Browse failed.");
	}
}

export const onRequestGet = withEdgeCache(handler);
