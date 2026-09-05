/* POST /api/me/search  {term} - record a search term for this account. */
import { reply, readJson } from "../../_lib/auth.js";
import { recordSearch } from "../../_lib/library.js";

export async function onRequestPost({ request, env, data }) {
	const body = await readJson(request);
	await recordSearch(env, data.user.id, body.term);
	return reply({ ok: true });
}
