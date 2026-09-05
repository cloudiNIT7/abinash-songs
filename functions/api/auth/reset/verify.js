/* POST /api/auth/reset/verify  {email, code}
   Confirms the reset code and returns a short-lived token that authorises one
   password change. The code is consumed here. */
import {
	checkOtp, createResetToken, reply, badRequest, readJson, normaliseEmail,
} from "../../../_lib/auth.js";

export async function onRequestPost({ request, env }) {
	const body = await readJson(request);
	const email = normaliseEmail(body.email);
	const code = String(body.code || "").trim();
	if (!email || !code) return badRequest("Email and code are required.");

	const result = await checkOtp(env, email, code);
	if (!result.ok) return badRequest(result.error, 401);

	// Bind the token to the current password salt so it can be used exactly
	// once: after the password changes, the salt changes and the token dies.
	const user = await env.DB.prepare("SELECT password_salt FROM users WHERE email = ?").bind(email).first();
	const bind = user ? user.password_salt : "";
	return reply({ ok: true, resetToken: await createResetToken(env, email, bind) });
}
