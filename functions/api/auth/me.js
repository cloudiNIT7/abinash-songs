/* GET /api/auth/me - who is signed in (used to bootstrap every page) */
import { currentUser, publicUser, reply } from "../../_lib/auth.js";

export async function onRequestGet({ request, env }) {
	const user = await currentUser(request, env);
	return reply({ ok: true, user: publicUser(user) });
}
