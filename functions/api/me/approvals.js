/* The signed-in device's half of a login approval.
 *
 *   GET  /api/me/approvals                      - sign-ins waiting on an answer
 *   POST /api/me/approvals {id, action}         - "approve" or "deny" one
 *
 * Everything is scoped to data.user.id by the /api/me/* auth middleware, so one
 * account can never see or answer another's requests.
 */
import {
	listPendingApprovals, decideApproval, pruneApprovals, reply, badRequest, readJson,
} from "../../_lib/auth.js";

export async function onRequestGet({ env, data }) {
	let rows;
	try {
		rows = await listPendingApprovals(env, data.user.id);
	} catch (e) {
		// Table not migrated yet: nothing is waiting, by definition.
		return reply({ ok: true, approvals: [], unavailable: true });
	}
	const now = Math.floor(Date.now() / 1000);
	return reply({
		ok: true,
		approvals: rows.map((row) => ({
			id: row.id,
			device: row.device || "Computer",
			os: row.os || "",
			browser: row.browser || "",
			location: row.location || "",
			ip: row.ip || "",
			created_at: row.created_at,
			expires_in: Math.max(0, row.expires_at - now),
		})),
	});
}

export async function onRequestPost({ request, env, data }) {
	const body = await readJson(request);
	const id = String(body.id || "").trim();
	const action = String(body.action || "").toLowerCase();
	if (!id) return badRequest("An approval id is required.");
	if (action !== "approve" && action !== "deny") return badRequest("Action must be approve or deny.");

	const done = await decideApproval(env, id, data.user.id, action === "approve", data.user.session_id);
	if (!done) return badRequest("That request has already been answered or has expired.", 409);

	await pruneApprovals(env, data.user.id);
	return reply({ ok: true, status: action === "approve" ? "approved" : "denied" });
}
