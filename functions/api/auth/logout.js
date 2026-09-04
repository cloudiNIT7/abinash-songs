/* POST /api/auth/logout */
import { clearSessionCookie, reply } from "../../_lib/auth.js";

export async function onRequestPost() {
	return reply({ ok: true }, { cookie: clearSessionCookie() });
}
