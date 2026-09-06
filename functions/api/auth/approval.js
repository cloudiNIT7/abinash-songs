/* The waiting device's half of a login approval.
 *
 *   GET  /api/auth/approval?id=<approvalId>   - has it been answered yet?
 *   POST /api/auth/approval  {id}             - approved: collect the session
 *
 * Unauthenticated by necessity: this device has no session yet. The id is a
 * random 128-bit secret handed only to the browser that submitted the password,
 * the status response says nothing about the account, and claiming is bound to
 * that browser's User-Agent and works exactly once.
 */
import {
	getApproval, claimApproval, createSessionCookie, publicUser, reply, badRequest, readJson,
} from "../../_lib/auth.js";

export async function onRequestGet({ request, env }) {
	const url = new URL(request.url);
	const id = String(url.searchParams.get("id") || "").trim();
	if (!id) return badRequest("An approval id is required.");

	let row;
	try {
		row = await getApproval(env, id);
	} catch (e) {
		return badRequest("Approvals are not available right now.", 503);
	}
	if (!row) return reply({ ok: true, status: "unknown" });

	return reply({
		ok: true,
		status: row.status,                        // pending | approved | denied | claimed | expired
		expiresIn: Math.max(0, row.expires_at - Math.floor(Date.now() / 1000)),
	});
}

export async function onRequestPost({ request, env }) {
	const body = await readJson(request);
	const id = String(body.id || "").trim();
	if (!id) return badRequest("An approval id is required.");

	const user = await claimApproval(env, id, request);
	if (!user) return badRequest("That approval is no longer valid. Please sign in again.", 403);

	return reply(
		{ ok: true, user: publicUser(user) },
		{ cookie: await createSessionCookie(env, user.id, request) },
	);
}
