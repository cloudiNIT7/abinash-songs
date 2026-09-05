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

	return reply({ ok: true, resetToken: await createResetToken(env, email) });
}
