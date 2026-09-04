/* GET /song/?query=&songdata=&lyrics=  - search by name, or resolve a song link */
import { searchForSong, json, fail, flags } from "../_lib/saavn.js";

export async function onRequestGet({ request }) {
	const url = new URL(request.url);
	const query = url.searchParams.get("query");
	if (!query) return fail("Query is required to search songs!");

	const { lyrics, songdata } = flags(url);
	try {
		return json(await searchForSong(query, lyrics, songdata), { maxAge: 300 });
	} catch (e) {
		return fail(e.message || "Search failed.");
	}
}
