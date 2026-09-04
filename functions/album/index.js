/* GET /album/?query=<jiosaavn album url>&lyrics= */
import { getAlbumId, getAlbum, json, fail, flags } from "../_lib/saavn.js";

export async function onRequestGet({ request }) {
	const url = new URL(request.url);
	const query = url.searchParams.get("query");
	if (!query) return fail("Query is required to search albums!");

	const { lyrics } = flags(url);
	try {
		const id = await getAlbumId(query);
		const album = await getAlbum(id, lyrics);
		if (!album) return fail("That album could not be loaded.");
		return json(album, { maxAge: 300 });
	} catch (e) {
		return fail(e.message || "Could not load that album.");
	}
}
