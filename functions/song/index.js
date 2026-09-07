/* GET /song/?query=&songdata=&lyrics=&n=&p=  - search by name, or resolve a song link */
import { searchForSong, searchSongs, json, fail, flags } from "../_lib/saavn.js";
import { withEdgeCache } from "../_lib/cache.js";

async function handler({ request }) {
	const url = new URL(request.url);
	const query = url.searchParams.get("query");
	if (!query) return fail("Query is required to search songs!");

	const { lyrics, songdata } = flags(url);
	const isLink = /^https?:/i.test(query) && query.includes("saavn.com");

	try {
		// A real search: return everything that matches, newest release first,
		// rather than the five type-ahead suggestions this used to give. Paged
		// with n/p; the response stays a plain array so the player is unchanged,
		// and the totals ride along in headers for anything that wants them.
		if (songdata && !isLink) {
			const page = await searchSongs(query, {
				page: url.searchParams.get("p"),
				count: url.searchParams.get("n") || 40,
				lyrics,
			});
			return json(page.results, {
				maxAge: 300,
				swr: 120,
				headers: {
					"X-Total-Results": String(page.total),
					"X-Page": String(page.page),
					"X-Page-Size": String(page.count),
				},
			});
		}

		const results = await searchForSong(query, lyrics, songdata);
		// `songdata=false` is the type-ahead: titles only, so it can go stale.
		// With song data the payload carries media urls, so keep that tighter.
		return json(results, songdata ? { maxAge: 300, swr: 120 } : { maxAge: 600, swr: 600 });
	} catch (e) {
		return fail(e.message || "Search failed.");
	}
}

export const onRequestGet = withEdgeCache(handler);
