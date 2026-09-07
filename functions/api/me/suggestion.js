/* Suggestion nudges for the signed-in device.
 *
 *   GET  /api/me/suggestion   - the pending "listen to this" text, if any.
 *                               The service worker calls this after a
 *                               content-free Web Push tickle, the same way the
 *                               approval flow works.
 *   POST /api/me/suggestion   - {optout: true|false} turn the nudges off or on.
 *
 * Scoped to the signed-in user by the /api/me/* auth middleware.
 */
import { reply, readJson } from "../../_lib/auth.js";
import { kvGet, suggestKey } from "../../_lib/kvstore.js";

export async function onRequestGet({ env, data }) {
	const pending = await kvGet(env, suggestKey(data.user.id), { cacheTtl: 0 });
	if (!pending) return reply({ ok: true, suggestion: null });
	return reply({
		ok: true,
		suggestion: {
			title: pending.title || "Listen to this",
			body: pending.body || "",
			songId: pending.songId || "",
			songName: pending.songName || "",
		},
	});
}

export async function onRequestPost({ request, env, data }) {
	const body = await readJson(request);
	const optout = body.optout ? 1 : 0;
	try {
		await env.DB.prepare(
			`INSERT INTO suggest_state (user_id, last_at, sent_today, day, optout)
			 VALUES (?, 0, 0, NULL, ?)
			 ON CONFLICT(user_id) DO UPDATE SET optout = excluded.optout`,
		).bind(data.user.id, optout).run();
	} catch (e) {
		return reply({ ok: false, error: "Suggestions aren't available yet." }, { status: 503 });
	}
	return reply({ ok: true, optout: !!optout });
}
