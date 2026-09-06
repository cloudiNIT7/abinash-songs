/* GET /api/auth/me - who is signed in (used to bootstrap every page, and polled
   by the player to notice a session that was ended elsewhere). */
import { currentUser, publicUser, reply } from "../../_lib/auth.js";

export async function onRequestGet(context) {
	const { request, env } = context;
	const user = await currentUser(request, env, context.waitUntil && context.waitUntil.bind(context));
	return reply({ ok: true, user: publicUser(user) });
}
