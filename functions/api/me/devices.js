/* /api/me/devices - where this account is signed in.
 *
 *   GET                     -> { ok, devices: [...], current }
 *   POST { id }             -> end that one session
 *   POST { all: true }      -> end every session except this one
 *
 * Every row is scoped to data.user.id by the /api/me/* auth middleware, so one
 * account can never see or revoke another's sessions.
 */
import {
	listSessions, revokeSession, revokeOtherSessions, pruneSessions,
	reply, badRequest, readJson,
} from "../../_lib/auth.js";

function shape(row, currentId) {
	return {
		id: row.id,
		device: row.device || "Computer",
		os: row.os || "",
		browser: row.browser || "",
		location: row.location || "",
		ip: row.ip || "",
		created_at: row.created_at,
		last_seen_at: row.last_seen_at,
		current: row.id === currentId,
	};
}

export async function onRequestGet({ env, data }) {
	await pruneSessions(env, data.user.id);
	let rows;
	try {
		rows = await listSessions(env, data.user.id);
	} catch (e) {
		// The sessions table isn't migrated yet: report an empty list rather
		// than a 500, so the UI can explain itself.
		return reply({ ok: true, devices: [], current: "", unavailable: true });
	}
	const current = data.user.session_id || "";
	return reply({
		ok: true,
		current,
		devices: rows.map((row) => shape(row, current)),
	});
}

export async function onRequestPost({ request, env, data }) {
	const body = await readJson(request);
	const current = data.user.session_id || "";

	if (body.all) {
		const ended = await revokeOtherSessions(env, data.user.id, current);
		return reply({ ok: true, ended });
	}

	const id = String(body.id || "").trim();
	if (!id) return badRequest("A device id is required.");
	if (id === current) {
		return badRequest("That's this device. Use Log Out instead.");
	}

	const ended = await revokeSession(env, id, data.user.id);
	if (!ended) return badRequest("That device is already signed out.", 404);
	return reply({ ok: true, ended: 1 });
}
