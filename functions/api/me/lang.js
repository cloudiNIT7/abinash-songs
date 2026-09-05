/* POST /api/me/lang  {lang} - save this account's preferred language. */
import { reply, badRequest, readJson } from "../../_lib/auth.js";

export async function onRequestPost({ request, env, data }) {
	const body = await readJson(request);
	const lang = String(body.lang || "").trim().slice(0, 20);
	if (!lang) return badRequest("A language is required.");
	await env.DB.prepare("UPDATE users SET pref_lang = ?, updated_at = ? WHERE id = ?")
		.bind(lang, new Date().toISOString(), data.user.id).run();
	return reply({ ok: true });
}
