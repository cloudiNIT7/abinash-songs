/* POST /api/auth/logout - ends this device's session. */
import { clearSessionCookie, currentUser, revokeSession, reply } from "../../_lib/auth.js";

export async function onRequestPost({ request, env }) {
	// Revoke the server-side session too, so it disappears from the device list
	// instead of lingering until it expires.
	try {
		const user = await currentUser(request, env);
		if (user && user.session_id) await revokeSession(env, user.session_id, user.id);
	} catch (e) { /* clearing the cookie is what matters */ }
	return reply({ ok: true }, { cookie: clearSessionCookie() });
}
