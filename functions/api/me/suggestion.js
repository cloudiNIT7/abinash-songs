/* Suggestion preferences for the signed-in account.
 *
 *   GET  /api/me/suggestion   - are the "listen to this" nudges on?
 *   POST /api/me/suggestion   - {optout: true|false} turn them off or on.
 *
 * The nudges themselves are delivered by Firebase as notification messages, so
 * nothing here is involved in showing them - this is only the on/off switch.
 * Scoped to the signed-in user by the /api/me/* auth middleware.
 */
import { reply, readJson } from "../../_lib/auth.js";

export async function onRequestGet({ env, data }) {
	let optout = 0;
	try {
		const row = await env.DB.prepare("SELECT optout FROM suggest_state WHERE user_id = ?")
			.bind(data.user.id).first();
		optout = (row && row.optout) || 0;
	} catch (e) {
		return reply({ ok: true, available: false, optout: false });
	}
	return reply({ ok: true, available: true, optout: !!optout });
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
