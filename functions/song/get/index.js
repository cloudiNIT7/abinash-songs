/* GET /song/get/?id=&lyrics=  - one song by id (used to refresh an expired url) */
import { getSong, json, fail, flags } from "../../_lib/saavn.js";

export async function onRequestGet({ request }) {
	const url = new URL(request.url);
	const id = url.searchParams.get("id");
	if (!id) return fail("Song ID is required to get a song!");

	const { lyrics } = flags(url);
	const song = await getSong(id, lyrics);
	if (!song) return fail("Invalid Song ID received!");
	// Media urls go stale, so this one is not cached at the edge.
	return json(song, { maxAge: 0 });
}
