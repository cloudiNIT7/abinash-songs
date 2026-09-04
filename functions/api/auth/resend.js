/* POST /api/auth/resend  {email} - email a fresh code for a pending account. */
import { issueOtp, reply, badRequest, readJson, normaliseEmail } from "../../_lib/auth.js";

export async function onRequestPost({ request, env }) {
	const body = await readJson(request);
	const email = normaliseEmail(body.email);
	if (!email) return badRequest("Email is required.");

	const user = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
	// Same response whether or not the account exists, to avoid probing.
	if (!user) return reply({ ok: true });

	try {
		const sent = await issueOtp(env, email, "signup");
		if (!sent.ok) return badRequest(`Please wait ${sent.retryIn}s before requesting another code.`, 429);
	} catch (e) {
		return badRequest("Couldn't send the verification email. Please try again.", 502);
	}
	return reply({ ok: true });
}
