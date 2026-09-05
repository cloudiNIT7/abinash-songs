/* GET /api/me/library - this account's recent, most-played, likes and searches. */
import { reply } from "../../_lib/auth.js";
import { getLibrary } from "../../_lib/library.js";

export async function onRequestGet({ env, data }) {
	const lib = await getLibrary(env, data.user.id);
	return reply({ ok: true, ...lib });
}
