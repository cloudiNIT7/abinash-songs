/* GET /lyrics/?query=<song id or jiosaavn song url> */
import { getSongId, getLyrics, json, fail } from "../_lib/saavn.js";

export async function onRequestGet({ request }) {
	const url = new URL(request.url);
	const query = url.searchParams.get("query");
	if (!query) return fail("Query containing song link or id is required to fetch lyrics!");

	try {
		const id = /^https?:/i.test(query) && query.includes("saavn")
			? await getSongId(query)
			: query;
		return json({ status: true, lyrics: await getLyrics(id) }, { maxAge: 3600 });
	} catch (e) {
		return fail(e.message || "Could not fetch lyrics.");
	}
}
