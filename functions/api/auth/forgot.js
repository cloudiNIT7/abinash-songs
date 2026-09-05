/* POST /api/auth/forgot  {email}
   Emails a password-reset code. Always responds ok so it can't be used to
   discover which emails have accounts. */
import { issueOtp, reply, badRequest, readJson, normaliseEmail } from "../../_lib/auth.js";

export async function onRequestPost({ request, env }) {
	const body = await readJson(request);
	const email = normaliseEmail(body.email);
	if (!email) return badRequest("Email is required.");

	const user = await env.DB.prepare("SELECT id, verified FROM users WHERE email = ?").bind(email).first();
	if (user && user.verified) {
		try {
			await issueOtp(env, email, "reset");
		} catch (e) {
			// Don't leak send failures or account existence; the client just
			// sees the neutral "if that email exists…" message.
		}
	}
	return reply({ ok: true });
}
