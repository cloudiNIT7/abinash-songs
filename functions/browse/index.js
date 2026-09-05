/* GET /browse/?query=<mood|genre|artist> - songs for a mood/genre/artist,
   preferring a matching editorial playlist for a rich result. */
import { browseTracks, json, fail } from "../_lib/saavn.js";

export async function onRequestGet({ request }) {
	const url = new URL(request.url);
	const query = url.searchParams.get("query");
	if (!query) return fail("Query is required.");
	try {
		return json(await browseTracks(query, false), { maxAge: 300 });
	} catch (e) {
		return fail(e.message || "Browse failed.");
	}
}
