/* GET /api/auth/me - who is signed in (used to bootstrap every page, and polled
   by the player to notice a session that was ended elsewhere).

   `?approvals=1` also returns sign-ins waiting for this device to approve them,
   so the player's poll can raise them without a second request. */
import { currentUser, publicUser, listPendingApprovals, reply } from "../../_lib/auth.js";

export async function onRequestGet(context) {
	const { request, env } = context;
	const user = await currentUser(request, env, context.waitUntil && context.waitUntil.bind(context));
	const body = { ok: true, user: publicUser(user) };

	if (user && new URL(request.url).searchParams.get("approvals") === "1") {
		const now = Math.floor(Date.now() / 1000);
		try {
			body.approvals = (await listPendingApprovals(env, user.id)).map((row) => ({
				id: row.id,
				device: row.device || "Computer",
				os: row.os || "",
				browser: row.browser || "",
				location: row.location || "",
				ip: row.ip || "",
				created_at: row.created_at,
				expires_in: Math.max(0, row.expires_at - now),
			}));
		} catch (e) {
			body.approvals = [];            // not migrated yet
		}
	}

	return reply(body);
}
